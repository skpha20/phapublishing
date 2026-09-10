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
| Cloudflare account | `Skpha20@gmail.com` (Susan's own) | account `a04bd95749e8ea27370121393a3ac93e` |
| Cloudflare zone id | `fb2118972cadf8c1200466bbd3e7e546` | Free plan, DNS Setup: Full |
| Web host | Railway | project `capable-serenity` / service `phapublishing` |

### Why HostGator looked empty
Nameserver delegation already points at Cloudflare. Once NS records are delegated,
HostGator's own DNS zone is bypassed entirely — it is never consulted. The empty
DNS panel there is expected and correct. **Do not add records at HostGator**; they
would have no effect and would create a misleading second source of truth. The only
thing HostGator still controls is the NS delegation, which is already correct.

---

## Records live on phapublishing.com

All created 2026-09-10 and verified resolving against `1.1.1.1`.

| Type | Name | Content | Proxy |
|---|---|---|---|
| CNAME | `@` | `o9xyu31t.up.railway.app` | DNS only |
| CNAME | `www` | `6yh20jss.up.railway.app` | DNS only |
| MX | `@` | `.` (priority 0) | — |
| TXT | `@` | `v=spf1 -all` | DNS only |
| TXT | `_dmarc` | `v=DMARC1; p=reject; sp=reject; adkim=s; aspf=s` | DNS only |
| TXT | `*._domainkey` | `v=DKIM1; p=` | DNS only |

The apex resolves as an **A record** (Cloudflare flattens the apex CNAME) — correct
and expected, not a misconfiguration.

**Mail posture:** this domain sends and receives no mail. The null MX (RFC 7505)
plus `-all` SPF, `p=reject` DMARC and a wildcard null DKIM make that explicit, so
the domain cannot be used for spoofing while it sits idle. **All four must be
revisited the moment Susan wants email here** — as written they forbid it.

---

## Railway

- Workspace `skpha20's Projects` (Pro) — same identity as the Cloudflare account.
- Project `capable-serenity` / service `phapublishing`; Railpack, node@20.20.2,
  US West, 1 replica. Deploys from `skpha20/phapublishing` branch `main`.
- Serving a placeholder "coming soon" page (zero-dependency Node static server,
  `server.js` + `public/index.html`), marked `noindex, nofollow` so search engines
  do not index the placeholder as the site's identity. Replacing it with the real
  site is just a commit to `main`.

### Railway CNAME targets are per-domain
Railway mints a **different** target for every hostname. They are never
interchangeable and cannot be guessed from one another:

| Hostname | Target |
|---|---|
| `phapublishing.com` | `o9xyu31t.up.railway.app` |
| `www.phapublishing.com` | `6yh20jss.up.railway.app` |
| `www.susanphaforsenate.com` | `d9rkgh7c.up.railway.app` |

### Keep the records grey-clouded until certs issue
Railway provisions certificates over HTTP-01. If the Cloudflare proxy (orange
cloud) is on, it intercepts the challenge and issuance never completes. This is the
single most common failure in a Cloudflare + Railway setup.

While issuance is pending, `https://` serves Railway's wildcard `*.up.railway.app`
certificate and clients report a name mismatch. That is the normal intermediate
state, not a fault — HTTP already routes correctly (301 to https).

---

## Remaining / optional

- **SSL/TLS mode is `Full`.** Safe as-is. Move to **Full (strict)** once certs are
  issued — Railway serves valid public certs. Never set Flexible; it causes a
  redirect loop with Railway.
- **Canonical host undecided.** Apex and `www` both serve the site independently.
  Pick one and redirect the other, or search engines see duplicate content.
  Cloudflare template: Rules -> Redirect Rules -> "Redirect www to root".
- **Proxy status.** Once certs are live the records may optionally be
  orange-clouded for Cloudflare's CDN/WAF. The campaign apex is already orange, so
  its `www` should be flipped to match.

---

## susanphaforsenate.com (Susan's campaign domain)

Second zone in the same Cloudflare account, zone id
`fe56cd2f7670bf85bf73cf298397dcb9`. Separate from this engagement, but changed on
2026-09-10 at Steph's direction, so recorded here.

### DMARC was broken
`v=DMARC1; p=none; rua=mailto:name@domain.com;`

Two defects: `p=none` enforces nothing, and the reporting address was an unedited
template placeholder pointing at `domain.com`, a domain owned by an unrelated third
party. External DMARC reporting also requires the receiving domain to publish an
authorisation record, which `domain.com` does not — so no reports reached anyone.
DMARC appeared "on" while delivering neither enforcement nor data.

**Now:**
`v=DMARC1; p=none; rua=mailto:c3e8ce3372fa425b8730136daee17213@dmarc-reports.cloudflare.net;`

### p=none was deliberately preserved
The zone shows three outbound senders — SendGrid (`em4301`, `s1/s2._domainkey`),
Amazon SES (`send.` subdomain), and Resend (`resend._domainkey`) — while the apex
SPF is only `v=spf1 include:_spf.mx.cloudflare.net ~all`, which authorises
Cloudflare Email Routing (inbound forwarding) and **none of those three senders**.
Escalating before reconciling SPF risks bouncing live campaign mail, including
fundraising sends.

**Next step:** read the aggregate reports in Cloudflare (Email -> DMARC Management)
after ~2 weeks, add every legitimate sender to SPF, confirm DKIM alignment, then
escalate `p=none` -> `p=quarantine` -> `p=reject` on evidence, not assumption.

### Do NOT apply the phapublishing mail treatment here
`v=spf1 -all` and a null MX are correct for a domain that sends no mail. On this
domain they would declare every legitimate campaign sender unauthorised and refuse
all inbound mail.

### www
`www.susanphaforsenate.com` did not resolve at all. Attached to the campaign's
Railway service (project `susanpha-senate`) and pointed at `d9rkgh7c.up.railway.app`
(grey). Flip to orange once its certificate issues, to match the proxied apex.

---

## Verification

```powershell
foreach ($n in @('phapublishing.com','www.phapublishing.com','www.susanphaforsenate.com')) {
  Write-Output "=== $n ==="
  Resolve-DnsName $n -Server 1.1.1.1 |
    ForEach-Object { if ($_.NameHost) { "  -> $($_.NameHost)" } elseif ($_.IPAddress) { "  -> $($_.IPAddress)" } }
}
```

Mail posture on phapublishing.com:

```powershell
$d = 'phapublishing.com'
foreach ($n in @($d, "_dmarc.$d", "selector1._domainkey.$d")) {
  Write-Output "=== $n ==="
  Resolve-DnsName $n -Type TXT -Server 1.1.1.1 |
    Where-Object Strings | ForEach-Object { $_.Strings -join '' }
}
Resolve-DnsName $d -Type MX -Server 1.1.1.1 | ForEach-Object { "MX $($_.Preference) '$($_.NameExchange)'" }
```

Certificate state (shows `*.up.railway.app` while issuance is still pending):

```bash
echo | openssl s_client -connect phapublishing.com:443 -servername phapublishing.com 2>/dev/null \
  | openssl x509 -noout -subject -dates
```

---

## Notes for whoever picks this up

- `workspace/` is a local-only working directory and is gitignored. **This repo is
  public** — never commit anything from it.
- The Cloudflare dashboard proved unreliable for browser automation (modal
  animation timing plus a persistent websocket that never lets the page settle).
  DNS changes here were made through the Cloudflare API instead, which is
  deterministic and verifiable. Prefer the API.
