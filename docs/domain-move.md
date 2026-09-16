# Moving the registry website to `packages.mvx-lang.org`

Runbook for mv-package-registry#55. The website moves to the project's own
domain; the JSON API keeps answering on `mv-package.heydon.io` as well, because
installed clients have that origin compiled in (`MVPKG.REG`'s `DEFURL`) and
GitHub holds release webhooks pointing at it. The application handles the
split — page requests get a 301, the API never does — so the infrastructure
only has to deliver **both hostnames to the same container**.

## What is in place today

| | |
|---|---|
| Traefik host | `192.168.15.2` (`gordon@`), config `~/docker/traefik/` |
| Router file | `~/docker/traefik/data/dynamic/mv-package.yml` |
| Registry backend | `192.168.15.35:8086` (VM105) |
| Cert resolver | `cloudflare`, DNS-01, token in `CF_DNS_API_TOKEN` |
| DNS | both zones on Cloudflare (`jake`/`lisa.ns.cloudflare.com`) |
| `mv-package.heydon.io` (public, Cloudflare) | A → `157.211.20.183`, **DNS-only**, TTL auto |
| `mv-package.heydon.io` (on the LAN) | resolves to `192.168.15.2` — UniFi overrides the public answer |
| `packages.mvx-lang.org` | does not exist yet |

**The name resolves to two different addresses by design.** Cloudflare publishes
the public address for the outside world; UniFi answers `192.168.15.2` for
clients on the LAN, so internal traffic reaches Traefik directly instead of
hairpinning out and back. Both halves are needed — a public record alone leaves
LAN clients going the long way round, and a UniFi entry alone makes the name
work only at home.

## 1. Cloudflare DNS

In zone `mvx-lang.org`, add:

```
Type: A    Name: packages    Content: 157.211.20.183    Proxy: DNS only (grey cloud)    TTL: Auto
```

That is the **public** address, matching `mv-package.heydon.io` exactly — not
`192.168.15.2`, which is the LAN answer UniFi gives in step 3.

Keep it grey-clouded, as the existing record is. Proxying would terminate TLS at
Cloudflare, and the cert Traefik issues by DNS-01 would never be the one clients
see.

## 2. Check the cert token covers the new zone — do this *before* step 4

Traefik issues with DNS-01 through `CF_DNS_API_TOKEN`. That token was scoped
per zone, and `traefik.yml` already carries a `letsencrypt-http` resolver for
zones it cannot edit (the snowgum ones). If it has no `Zone:DNS:Edit` on
`mvx-lang.org`, issuance for the new hostname fails and the router serves a
self-signed cert.

Either widen the token in the Cloudflare dashboard (**My Profile → API Tokens →**
edit the token used for DNS-01, add `mvx-lang.org` to Zone Resources), or use
the documented fallback — see the variant in step 4.

## 3. UniFi

Add the local DNS override so LAN clients reach Traefik directly rather than
hairpinning through the public address. This mirrors the entry
`mv-package.heydon.io` already has:

```
packages.mvx-lang.org  ->  192.168.15.2
```

Without it the name still works from inside, but every internal request leaves
the network and comes back.

UniFi Network → Settings → Routing & Firewall (or Network → DNS, depending on
the controller version) → local DNS records.

## 4. Traefik router

Edit `~/docker/traefik/data/dynamic/mv-package.yml` on `192.168.15.2` so one
router answers for both names:

```yaml
# MANAGED — mv_package registry.
# Website: packages.mvx-lang.org.  mv-package.heydon.io stays for the JSON API,
# which clients installed before the move and GitHub's webhooks still use; the
# app answers a page request there with a 301.
# Routes to the registry container on the hosting VM (192.168.15.35:8086).
http:
  routers:
    mvpkg:
      entryPoints:
      - https
      rule: Host(`packages.mvx-lang.org`) || Host(`mv-package.heydon.io`)
      middlewares:
      - default-headers
      tls:
        certResolver: cloudflare
        domains:
        - main: packages.mvx-lang.org
        - main: mv-package.heydon.io
      service: mvpkg
  services:
    mvpkg:
      loadBalancer:
        servers:
        - url: http://192.168.15.35:8086
        passHostHeader: true
```

`passHostHeader: true` must stay. The application decides whether to redirect by
comparing the request's `Host` against `WEB_ORIGIN`; without it every request
looks like it arrived on the wrong host and pages would redirect in a loop.

Traefik watches the dynamic directory, so the file is picked up without a
restart. Watch it land:

```bash
ssh gordon@192.168.15.2 'docker logs --since 2m traefik 2>&1 | grep -i "mvpkg\|acme\|error" | tail -20'
```

**Variant, if step 2 says the token cannot edit `mvx-lang.org`:** split into two
routers — keep `mvpkg` exactly as it is on `certResolver: cloudflare`, and add a
second router for `Host(`packages.mvx-lang.org`)` with
`certResolver: letsencrypt-http` pointing at the same `mvpkg` service. HTTP-01
needs port 80 reachable from the internet, which is the same path the other home
services already use.

## 5. Registry `.env` on VM105 (`192.168.15.35`)

```
WEB_ORIGIN=https://packages.mvx-lang.org
PUBLIC_ORIGIN=https://packages.mvx-lang.org
WEBAUTHN_RP_ID=packages.mvx-lang.org
WEBAUTHN_ORIGIN=https://packages.mvx-lang.org
```

`WEB_ORIGIN` is what turns the redirect on; leaving it unset keeps the old
behaviour exactly. `PUBLIC_ORIGIN` is the origin baked into **newly created**
webhook URLs and the GitHub App callback — webhooks already registered keep
their old URL and keep working, because the old host still serves the API.

Then redeploy. The code is baked into the image, so `restart` would keep serving
the old one:

```bash
docker compose up -d --build
```

## 6. External services that know the hostname

- **Cloudflare Turnstile** — add `packages.mvx-lang.org` to the widget's
  allowed hostnames, or registration fails the CAPTCHA on the new domain.
- **GitHub App** — update the callback/redirect URL to the new origin. The
  App-manifest flow builds it from `PUBLIC_ORIGIN`, but an App already created
  holds the old URL in its own settings.

## 7. Verify

```bash
# the website answers on the new name, with a valid cert
curl -sS -o /dev/null -w "new site: %{http_code}\n" https://packages.mvx-lang.org/

# a page on the old host moves, carrying its path
curl -sS -o /dev/null -w "old page: %{http_code} -> %{redirect_url}\n" https://mv-package.heydon.io/p/mvx-lang/getopt

# the API on the old host does NOT move — this is the one that matters
curl -sS -o /dev/null -w "old api:  %{http_code} (expect 200, not 301)\n" https://mv-package.heydon.io/packages

# and a webhook POST is not redirected
curl -sS -o /dev/null -X POST -w "old hook: %{http_code} (expect 404, not 301)\n" https://mv-package.heydon.io/webhook/nosuchid
```

Then sign in on the new domain and enrol a passkey — see below.

## Passkeys

`heydon.io` and `mvx-lang.org` share no registrable parent, so the WebAuthn RP
ID genuinely changes and **every existing passkey stops verifying**
(`lib/webauthn.js:89` compares `sha256(rpId)` against the authenticator's
`rpIdHash`). Nothing can carry them across; registered users enrol again on the
new domain. Accepted, not an oversight.

## Rollback

Clearing `WEB_ORIGIN` in `.env` and redeploying stops all redirecting
immediately, with no Traefik or DNS change. The router serving both hostnames is
harmless on its own.

One caveat: a 301 is cached hard by browsers. Anyone who has hit the old
hostname will keep being sent to the new one until that cache expires, whatever
the server later says. Do the verification in step 7 before browsing the old
host casually.
