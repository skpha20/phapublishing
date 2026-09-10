# phapublishing.com — DNS / Hosting Setup

**Client:** Susan Pha — Pha Publishing
**Engagement:** Initiate Concept, Inc.
**Last updated:** 2026-09-10

---

## Registrar / DNS / Host chain

| Layer | Provider | Notes |
|---|---|---|
| Registrar | HostGator | **Nothing to configure here.** |
| Source repo | `github.com/skpha20/phapublishing` (public) | auto-deploys on push to `main` |
| Authoritative DNS | Cloudflare | `junade.ns.cloudflare.com`, `leah.ns.cloudflare.com` |
| Cloudflare account | `Skpha20@gmail.com` (Susan's own) | Account ID `a04bd95749e8ea27370121393a3ac93e` |
| Zone plan | Free | DNS Setup: Full |
| Web host | Railway | project `capable-serenity`, service `phapublishing` (deployed, online) |

### Why HostGator looked empty
Nameserver delegation already points at Cloudflare. Once NS records are delegated,
HostGator's own DNS zone is bypassed entirely — it is never consulted. The empty
DNS panel there is expected and correct. **Do not add records at HostGator**; they
would have no effect and would create a misleading second source of truth.

The only thing HostGator still controls is the NS delegation itself, which is
already correct.

---

## Records currently live (added 2026-09-10)

All verified resolving against `1.1.1.1`.

| Type | Name | Content | Proxy |
|---|---|---|---|
| TXT | `phapublishing.com` | `v=spf1 -all` | DNS only |
| TXT | `_dmarc` | `v=DMARC1; p=reject; sp=reject; adkim=s; aspf=s` | DNS only |
| TXT | `*._domainkey` | `v=DKIM1; p=` | DNS only |

**Purpose:** the domain sends no mail today. This trio makes that explicit so the
domain cannot be used for spoofing/phishing while it sits unused — a real risk for
a domain tied to a sitting public official. The wildcard DKIM neutralises *any*
selector, not just known ones.

### Not yet added
- **Null MX** (`MX @ . priority 0`, RFC 7505) — intended but the Cloudflare
  "Add record" modal kept dismissing mid-interaction. Optional: SPF `-all` +
  DMARC `p=reject` already carry the anti-spoofing weight. Nice-to-have, adds
  faster bounces + an explicit "accepts no mail" signal.

---

## Railway

- Workspace: `skpha20's Projects` (Pro) — same identity as the Cloudflare account.
- Project `capable-serenity` / service `phapublishing`, builder Railpack, node@20.20.2,
  US West, 1 replica. Deploys from `skpha20/phapublishing` branch `main`,
  auto-deploy on push enabled.
- First deployment succeeded; service reports **Online**.
- Service is still **unexposed** — no custom domain attached yet, so no public URL.

### Remaining: attach domains and point DNS

Railway mints a unique CNAME target per custom domain, only once the domain is
attached to the service. Do this from the CLI — the Railway settings page holds a
persistent websocket that prevents browser automation from ever seeing the page
settle.

```bash
# interactive, run it yourself:
railway login          # must land on skpha20@gmail.com, NOT tech@qthemusic.app

cd "D:/InitiateConcept/Clients/Susan Pha/phapublishing/phapublishing-website"
railway link           # choose: skpha20's Projects -> capable-serenity -> production -> phapublishing
railway domain phapublishing.com
railway domain www.phapublishing.com
```

Each command prints the CNAME target to create. Then in Cloudflare:

| Type | Name | Content | Proxy |
|---|---|---|---|
| CNAME | `@` | *(Railway target for apex)* | **DNS only (grey)** |
| CNAME | `www` | *(Railway target for www)* | **DNS only (grey)** |

Cloudflare's CNAME flattening handles the apex automatically — no A record needed.

**Leave both grey-clouded until Railway reports the certificate issued.** Railway
provisions its cert over HTTP-01, and Cloudflare's proxy intercepts that challenge
if the record is orange. This is the most common failure in this setup.

### Cloudflare settings to confirm

- **SSL/TLS mode is currently `Full`.** Safe as-is. Move to **Full (strict)** once
  Railway's cert is live. Never set Flexible — it causes a redirect loop with Railway.
- Decide canonical host (apex vs `www`) and redirect the other.
  Rules → Redirect Rules → "Redirect www to root" is a one-click template.

---

## Also in this Cloudflare account

`susanphaforsenate.com` is a second zone under the same login — Susan's campaign
domain. Out of scope for this engagement; noted only so it isn't mistaken for a
stray zone or accidentally modified.

---

## Verification

```powershell
$d = 'phapublishing.com'
foreach ($n in @($d, "_dmarc.$d", "selector1._domainkey.$d")) {
  Write-Output "=== $n ==="
  Resolve-DnsName $n -Type TXT -Server 1.1.1.1 |
    Where-Object Strings | ForEach-Object { $_.Strings -join '' }
}
```

Once Railway is wired up, confirm the CNAMEs resolve and the site answers:

```powershell
Resolve-DnsName 'phapublishing.com' -Type CNAME -Server 1.1.1.1
Resolve-DnsName 'www.phapublishing.com' -Type CNAME -Server 1.1.1.1
curl.exe -sI https://phapublishing.com | Select-Object -First 5
```
