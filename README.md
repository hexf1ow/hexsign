# HEXSign — e-signing platform (branding overlay + operations)

`https://esign.rapidlodge.com.au` — self-hosted OpenSign, rebranded to **HEXSign** for Rapid Lodgements / Hex Flow.

This repo is the **source of truth for every customisation** on that platform. Upstream OpenSign images are
left untouched; everything here is applied on top and can be re-applied at any time.

## Why this repo exists

The platform runs from stock `opensign-server` / `opensign-client` images with **no volumes for code**.
Any `docker compose up --build`, image pull or container recreate reverts the site to upstream OpenSign
(OpenSign logo, "OpenSign" wording, no Arvo font, no footer, GPS gate on the login page).
`scripts/apply.sh` restores the branded state; `scripts/ensure.sh` (cron) does it automatically.

## Layout

```
client/client-build.tar.gz   branded SPA build (HexSign logo, Arvo fonts, footer, route-guarded GPS hook, icon colours)
server/Utils.js              appName='HexSign', HexSign logo in mail template, navy header
server/cloud/parsefunction/  mail + PDF functions rebranded (footer, signature reason, map user-agent)
scripts/apply.sh             deploy the overlay to a running platform (backs up first, verifies after)
scripts/ensure.sh            drift guard — re-applies if branding is missing (safe to cron)
scripts/verify.sh            proof the live platform is healthy and branded
scripts/backup-db.sh         mongodump of the opensign database, 14-day retention
docs/BRANDING.md             exactly what was changed and where
docs/RUNBOOK.md              day-2 operations
```

## Apply / repair

```bash
./scripts/verify.sh      # is the live platform correct?
./scripts/apply.sh       # (re)deploy the branding, restarts opensign-server, verifies
./scripts/ensure.sh      # non-destructive drift check; applies only if needed
```

Installed cron:

```
*/15 * * * *  /home/superuser/hexsign/scripts/ensure.sh          # self-heal after any rebuild
30 2 * * *    /home/superuser/hexsign/scripts/backup-db.sh       # nightly database dump
```

## After any image update

```bash
docker compose pull && docker compose up -d   # or however the stack is updated
/home/superuser/hexsign/scripts/apply.sh      # re-apply branding (ensure.sh would do it within 15 min)
/home/superuser/hexsign/scripts/verify.sh
```


## Running this for your own brand

The overlay ships with **our** deployment values. To point it at another business, edit
`config/brand.env` and run the rebrander — it rewrites the server files and the client build,
then refreshes the manifest:

```bash
vi config/brand.env        # PRODUCT_NAME, TENANT_NAME, PLATFORM_URL, SUPPORT_EMAIL, WEBSITE_URL, CERT_LOGO
./scripts/rebrand.sh       # rewrites repo working copy only — nothing goes live
./scripts/apply.sh         # deploy
```

Verified: setting it to a fictional customer (`Acme Sign` / `sign.acme.com.au` / `help@acme.com.au`)
replaces `appName`, every support/complaint address, the platform hostname and the page title, leaving
**zero** references to the previous brand.

**What this repo is not:** it is an *overlay*, not a standalone installer. You still need the upstream
OpenSign stack running (`opensign-server`, `opensign-client`, `opensign-mongo` + env: `APP_ID`,
`MASTER_KEY`, `SMTP_*`, `PFX_BASE64`, `PASS_PHRASE`). The admin account, tenant name and tenant logo
are database records, created in-app — not code, and never in this repo.


## Infrastructure reality (important)

- The containers were created with `docker run`, not compose. `deploy/opensign-stack.yml` now records the
  real shape (images, ports, network `opensign-stack_opensign-net`, volume names) so the stack is rebuildable.
  Secrets are **not** in git — they live in `/home/superuser/.hermes/private/opensign.env` (mode 600).
- **`/usr/src/app/files` (all signed PDFs + certificates, ~70 MB, 142 files) is inside the `opensign-server`
  container, not on a volume.** Recreating that container would destroy them. Mitigations in place:
  nightly archive (`scripts/backup-files.sh`, 03:00, 7-day retention). Proper fix = migrate to a named
  volume, which needs one container recreate.
- `esign.rapidlodge.com.au` is routed by Caddy config stored in the `caddy-config` volume (API-written,
  not in the on-disk Caddyfile). Back it up before touching Caddy.

## Backups

| What | When | Where | Retention |
|---|---|---|---|
| Mongo database | 02:30 daily | `/home/superuser/esign-backups/opensign_*.gz` | 14 days |
| Document files (PDFs) | 03:00 daily | `/home/superuser/esign-backups/files/esign-files_*.tgz` | 7 days |
| Container env/secrets | on demand | `~/.hermes/private/opensign.env` (600) | — |

## Rules

- Never edit files directly inside the containers and leave them there — change the repo, then `apply.sh`.
- `apply.sh` never deletes data: it only replaces code, keeps a pre-apply backup in
  `/home/superuser/esign-patches/apply-<stamp>/` and leaves the previous build as
  `/usr/src/app/build.previous` inside the client container.
- Emails already sent cannot be rebranded retroactively.
