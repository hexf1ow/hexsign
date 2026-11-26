# HEXSign runbook

## Daily / weekly

```bash
/home/superuser/hexsign/scripts/verify.sh          # 20 seconds, must print "all checks passed"
tail -20 /home/superuser/esign-patches/ensure.log  # drift guard history
tail -5  /home/superuser/esign-backups/backup.log  # nightly dumps
```

## Something looks wrong (logo gone, "OpenSign" back, font changed)

Almost always a container was rebuilt from the stock image.

```bash
/home/superuser/hexsign/scripts/apply.sh     # ~1 minute, restarts opensign-server only
/home/superuser/hexsign/scripts/verify.sh
```

If `apply.sh` fails it aborts **before** changing anything (syntax check) or leaves
`/home/superuser/esign-patches/apply-<stamp>/` with the previous files.

## Restore a database backup

```bash
ls -lt /home/superuser/esign-backups/*.gz | head
docker exec -i opensign-mongo sh -c 'mongorestore --archive --gzip --drop --nsInclude="opensign.*"' \
  < /home/superuser/esign-backups/opensign_YYYY-MM-DD_HHMM.gz
```

`--drop` replaces the collections — take a fresh dump first if you are unsure.

## Logins

- Admin: `nafees.m@rapidlodge.com.au` (display name "Rapid Admin"), lands on `/dashboard/<tenantId>`
- All outbound mail leaves from `info@rapidlodge.com.au` (server env `SMTP_USER_EMAIL`); the admin account plays no part in sending.

## Do not

- Do not `docker compose up --build` and walk away — run `apply.sh` afterwards (or wait for `ensure.sh`).
- Do not edit files inside the containers and leave them there; the repo is the source of truth.
- Do not change Font Awesome styles: only light/solid/brands exist on the CDN, the rest 404.
