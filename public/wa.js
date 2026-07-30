// mv_package registry — passkey (WebAuthn) browser glue.  GPL-2.0-only.
'use strict';
function _d(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u.buffer; }
function _e(b) { const u = new Uint8Array(b); let s = ''; for (const x of u) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

async function addPasskey() {
  try {
    const o = await (await fetch('/webauthn/register/options')).json();
    if (o.error) return alert(o.error);
    o.challenge = _d(o.challenge); o.user.id = _d(o.user.id);
    (o.excludeCredentials || []).forEach(c => c.id = _d(c.id));
    const c = await navigator.credentials.create({ publicKey: o });
    const body = { id: c.id, rawId: _e(c.rawId), type: c.type, response: {
      clientDataJSON: _e(c.response.clientDataJSON), attestationObject: _e(c.response.attestationObject) } };
    const r = await fetch('/webauthn/register/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.ok) location.reload(); else alert('passkey registration failed: ' + (await r.json()).error);
  } catch (e) { alert('passkey error: ' + e.message); }
}

async function loginPasskey() {
  try {
    const un = (document.querySelector('[name=username]') || {}).value || '';
    const o = await (await fetch('/webauthn/login/options?username=' + encodeURIComponent(un))).json();
    if (o.error) return alert(o.error);
    o.challenge = _d(o.challenge);
    (o.allowCredentials || []).forEach(c => c.id = _d(c.id));
    const c = await navigator.credentials.get({ publicKey: o });
    const body = { id: c.id, rawId: _e(c.rawId), type: c.type, response: {
      clientDataJSON: _e(c.response.clientDataJSON), authenticatorData: _e(c.response.authenticatorData),
      signature: _e(c.response.signature), userHandle: c.response.userHandle ? _e(c.response.userHandle) : null } };
    const r = await fetch('/webauthn/login/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.ok) location.href = '/account'; else alert('passkey sign-in failed: ' + (await r.json()).error);
  } catch (e) { alert('passkey error: ' + e.message); }
}
