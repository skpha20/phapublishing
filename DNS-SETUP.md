# phapublishing.com — DNS / Hosting Setup

**Client:** Susan Pha — Pha Publishing
**Engagement:** Initiate Concept, Inc.
**Last updated:** 2026-09-10

---

## Registrar / DNS / Host chain

| Layer | Provider | Notes |
|---|---|---|
| Registrar | HostGator | **Nothing to configure here.** |
| Authoritative DNS | Cloudflare | `junade.ns.cloudflare.com`, `leah.ns.cloudflare.com` |
| Cloudflare account | `Skpha20@gmail.com` (Susan's own) | Account ID `a04bd95749e8ea27370121393a3ac93e` |
| Zone plan | Free | DNS Setup: Full |
| Web host | Railway | **Not yet provisioned** |

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

## Remaining work — pointing the domain at Railway

Cannot be completed yet: **Railway mints the CNAME target only when a custom
domain is attached to a live service.** There is no Railway project for this site
yet, and `phapublishing-website/` has no code.

Note: the Railway CLI on this machine is authenticated as
`tech@qthemusic.app` (Q the Music) — the wrong account. It will need to be
re-authed to Susan's / Initiate Concept's Railway account before the CLI is useful
here.

### Finish-out steps, in order

1. Build and deploy the site to Railway.
2. In Railway: **Service → Settings → Networking → Custom Domain.**
   Add both `phapublishing.com` and `www.phapublishing.com`.
   Railway returns a unique target per domain, e.g. `abc123.up.railway.app`.
3. In Cloudflare DNS add:

   | Type | Name | Content | Proxy |
   |---|---|---|---|
   | CNAME | `@` | *(Railway target for apex)* | **DNS only (grey)** |
   | CNAME | `www` | *(Railway target for www)* | **DNS only (grey)** |

   Cloudflare's CNAME flattening handles the apex CNAME automatically — no
   A record or origin IP is needed.

4. **Leave the proxy grey-clouded until Railway shows the domain as verified and
   the certificate is issued.** Railway provisions its cert via HTTP-01, which
   fails while Cloudflare's proxy is intercepting the challenge. This is the
   single most common failure in this setup.
5. Once Railway reports the cert issued, optionally orange-cloud the records —
   but only after step 6.

### Cloudflare settings to confirm

- **SSL/TLS mode is currently `Full`.** Safe as-is. Recommend moving to
  **Full (strict)** once Railway's cert is live — Railway serves valid public
  certs, so strict validation works. Do **not** set Flexible; that causes an
  infinite redirect loop with Railway.
- Decide canonical host (apex vs `www`) and add a redirect rule for the other.
  Cloudflare offers a one-click template: Rules → Redirect Rules →
  "Redirect www to root".

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
