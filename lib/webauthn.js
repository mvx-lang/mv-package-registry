// mv_package registry — WebAuthn (passkeys), dependency-free.
// Copyright (C) 2026 Gordon Heydon.  GPL-2.0-only.
//
// Just enough of the WebAuthn server ceremony to register and authenticate
// passkeys, using only Node's crypto: a minimal CBOR decoder (for the
// attestation object and COSE public key), COSE->JWK conversion so
// crypto.createPublicKey can import the key, and ECDSA/RSA signature
// verification.  Attestation statements are NOT verified (we trust the
// registration flow, as is common for passkeys) — we only parse out and
// store the credential public key.
'use strict';
const crypto = require('crypto');

const b64u = {
  enc: b => Buffer.from(b).toString('base64url'),
  dec: s => Buffer.from(String(s), 'base64url'),
};
const sha256 = b => crypto.createHash('sha256').update(b).digest();

// ---- minimal CBOR decoder -------------------------------------------
// Handles the subset WebAuthn uses: uint, negint, byte/text strings, arrays,
// maps.  Returns { value, end } from offset `p` in buffer `b`.
function cbor(b, p) {
  const ib = b[p], mt = ib >> 5, ai = ib & 0x1f;
  let len = ai, q = p + 1;
  if (ai === 24) { len = b[q]; q += 1; }
  else if (ai === 25) { len = b.readUInt16BE(q); q += 2; }
  else if (ai === 26) { len = b.readUInt32BE(q); q += 4; }
  else if (ai === 27) { len = Number(b.readBigUInt64BE(q)); q += 8; }
  else if (ai > 27) throw new Error('cbor: bad additional info ' + ai);
  switch (mt) {
    case 0: return { value: len, end: q };                       // uint
    case 1: return { value: -1 - len, end: q };                  // negint
    case 2: return { value: b.slice(q, q + len), end: q + len }; // byte string
    case 3: return { value: b.slice(q, q + len).toString('utf8'), end: q + len }; // text
    case 4: { const a = []; for (let i = 0; i < len; i++) { const e = cbor(b, q); a.push(e.value); q = e.end; } return { value: a, end: q }; }
    case 5: { const m = new Map(); for (let i = 0; i < len; i++) { const k = cbor(b, q); q = k.end; const v = cbor(b, q); q = v.end; m.set(k.value, v.value); } return { value: m, end: q }; }
    default: throw new Error('cbor: unsupported major type ' + mt);
  }
}
const cborDecode = b => cbor(b, 0).value;

// ---- authenticator data ---------------------------------------------
// rpIdHash[32] flags[1] counter[4] [attestedCredentialData] [extensions]
function parseAuthData(ad) {
  const rpIdHash = ad.slice(0, 32);
  const flags = ad[32];
  const counter = ad.readUInt32BE(33);
  const out = { rpIdHash, flags, counter, up: !!(flags & 1), uv: !!(flags & 4), at: !!(flags & 0x40) };
  if (out.at) {
    const credIdLen = ad.readUInt16BE(53);
    out.credId = ad.slice(55, 55 + credIdLen);
    // the COSE public key is the remaining CBOR from here
    out.cosePubKey = cborDecode(ad.slice(55 + credIdLen));
  }
  return out;
}

// ---- COSE key -> JWK (for crypto.createPublicKey) --------------------
// COSE labels: 1=kty, 3=alg, -1=crv/n(rsa), -2=x/e(rsa), -3=y.  kty 2=EC2,
// 3=RSA.  crv 1=P-256, 2=P-384, 3=P-521.  alg -7=ES256, -257=RS256.
function coseToKey(m) {
  const kty = m.get(1), alg = m.get(3);
  if (kty === 2) {
    const crv = { 1: 'P-256', 2: 'P-384', 3: 'P-521' }[m.get(-1)];
    if (!crv) throw new Error('unsupported EC curve');
    const jwk = { kty: 'EC', crv, x: b64u.enc(m.get(-2)), y: b64u.enc(m.get(-3)) };
    return { key: crypto.createPublicKey({ key: jwk, format: 'jwk' }), alg, hash: 'sha256', kind: 'ec' };
  }
  if (kty === 3) {
    const jwk = { kty: 'RSA', n: b64u.enc(m.get(-1)), e: b64u.enc(m.get(-2)) };
    return { key: crypto.createPublicKey({ key: jwk, format: 'jwk' }), alg, hash: 'sha256', kind: 'rsa' };
  }
  throw new Error('unsupported COSE key type ' + kty);
}
// Store the public key as SPKI PEM so we can reload it later without COSE.
const keyToPem = pub => pub.export({ type: 'spki', format: 'pem' });

// ---- registration ----------------------------------------------------
// credential = { clientDataJSON, attestationObject } (both base64url).
function verifyRegistration(cred, expected) {
  const clientData = JSON.parse(b64u.dec(cred.clientDataJSON).toString('utf8'));
  if (clientData.type !== 'webauthn.create') throw new Error('bad clientData type');
  if (clientData.challenge !== expected.challenge) throw new Error('challenge mismatch');
  if (clientData.origin !== expected.origin) throw new Error('origin mismatch: ' + clientData.origin);

  const att = cborDecode(b64u.dec(cred.attestationObject));
  const authData = parseAuthData(att.get('authData'));
  if (!sha256(Buffer.from(expected.rpId)).equals(authData.rpIdHash)) throw new Error('rpId mismatch');
  if (!authData.up) throw new Error('user not present');
  if (!authData.at || !authData.credId) throw new Error('no attested credential');

  const pub = coseToKey(authData.cosePubKey);
  return {
    credId: b64u.enc(authData.credId),
    publicKeyPem: keyToPem(pub.key),
    kind: pub.kind,
    counter: authData.counter,
  };
}

// ---- authentication --------------------------------------------------
// assertion = { clientDataJSON, authenticatorData, signature } (base64url);
// passkey = { publicKeyPem, kind, counter }.
function verifyAssertion(assertion, passkey, expected) {
  const clientData = JSON.parse(b64u.dec(assertion.clientDataJSON).toString('utf8'));
  if (clientData.type !== 'webauthn.get') throw new Error('bad clientData type');
  if (clientData.challenge !== expected.challenge) throw new Error('challenge mismatch');
  if (clientData.origin !== expected.origin) throw new Error('origin mismatch: ' + clientData.origin);

  const authData = b64u.dec(assertion.authenticatorData);
  const parsed = parseAuthData(authData);
  if (!sha256(Buffer.from(expected.rpId)).equals(parsed.rpIdHash)) throw new Error('rpId mismatch');
  if (!parsed.up) throw new Error('user not present');

  const signed = Buffer.concat([authData, sha256(b64u.dec(assertion.clientDataJSON))]);
  const key = crypto.createPublicKey(passkey.publicKeyPem);
  const sig = b64u.dec(assertion.signature);
  const alg = passkey.kind === 'rsa'
    ? { key, padding: crypto.constants.RSA_PKCS1_PADDING }
    : { key, dsaEncoding: 'der' };
  const ok = crypto.verify('sha256', signed, alg, sig);
  if (!ok) throw new Error('signature verification failed');
  // signature counter: reject a clone (counter went backwards), 0 = unsupported
  if (parsed.counter !== 0 && passkey.counter !== 0 && parsed.counter <= passkey.counter)
    throw new Error('counter did not increase (possible cloned authenticator)');
  return { newCounter: parsed.counter };
}

const challenge = () => b64u.enc(crypto.randomBytes(32));

module.exports = { verifyRegistration, verifyAssertion, challenge, b64u };
