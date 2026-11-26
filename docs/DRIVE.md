# Cloud drive mirror (Google Drive / Shared drive)

HEXSign stores every uploaded and signed document in its own `files` directory.
This integration mirrors those files into a Google Drive folder or Shared drive, so
document copies are available to the people who already use Drive, and survive
independently of the platform container.

It is **one-way and additive**: new or changed files are uploaded, nothing on the
Drive is ever deleted or replaced with an older copy.

Supported: **Google Drive** (My Drive folder or Shared drive).
OneDrive / Dropbox are not implemented — the same script can be extended by swapping
the Google client for the Microsoft Graph client.


## 0. Connect it from inside the platform (recommended)

No server work, no cron, no container sidecar:

1. Sign in to the platform as a tenant admin.
2. **Settings → Drive** (the page lives at `/api/drive-admin`).
3. Paste a **service-account key** (or an OAuth token JSON containing `refresh_token`),
   type the Shared drive name, keep the folders as `Documents,Signed`, hit **Connect drive**.
   The page checks the credentials with Google before saving them and creates the folders.
4. The page then shows the account, drive, folders, **last sync** and last result, with
   **Sync now** and **Disconnect**.

The sync then runs **inside the platform server** every 10 minutes
(`DRIVE_INTERVAL_SECONDS`, default 600) — the same process that serves the app, so there is
nothing extra to keep alive and no Docker socket involved.

Configuration is stored in the `hexsign_DriveConfig` class in MongoDB, one row per install.
Every call to the page's API requires a valid platform session token.

---

## 1. Credentials — use a service account, not a person

A service account means the sync keeps working when staff change, and it cannot
touch anything you did not share with it.

1. Google Cloud Console → **IAM & Admin → Service Accounts → Create**
   Name it `hexsign-drive-sync`.
2. Open it → **Keys → Add key → Create new key → JSON**. Download it.
3. Google Drive → right-click the folder or **Shared drive** → **Manage access** →
   share it with the service account address (`hexsign-drive-sync@<project>.iam.gserviceaccount.com`)
   as **Content manager**.
   - A **Shared drive** member must be added at drive level (Shared drive → Manage members),
     not on a single folder.
4. Store the JSON **outside git**, e.g. `deploy/credentials/service-account.json` (mode 600).

Alternative (not recommended — ties the sync to one person): an OAuth user token JSON
containing `refresh_token`. The script accepts either and detects which it was given.

---

## 2. Run it

### A. Compose sidecar (new installs)

`opensign-server` keeps its documents on the `opensign-files` volume, so the sidecar can
mount the same volume read-only:

```bash
cp deploy/opensign.env.example deploy/opensign.env     # then edit the DRIVE_* block
mkdir -p deploy/credentials && cp /path/to/key.json deploy/credentials/service-account.json
docker compose --profile drive -f deploy/opensign-stack.yml up -d
```

It starts with the stack, restarts on failure and runs every `DRIVE_INTERVAL` seconds.
Logs: `docker logs -f opensign-drive-sync`.

### B. Existing install where files are still inside the container

The container has no volume, so the service reads through the Docker CLI instead:

```bash
sudo ./scripts/drive-sync/install-host-service.sh
```

That writes `/etc/systemd/system/hexsign-drive-sync.service` and starts it.
It uses `DRIVE_SOURCE=docker:opensign-server:/usr/src/app/files/files` and needs no
volume. Migrating to the volume later (see `docs/INSTALL.md`) removes the dependency on
the Docker socket.

---

## 3. All settings

| Variable | Meaning | Default |
|----------|---------|---------|
| `DRIVE_ENABLED` | master switch | `true` |
| `DRIVE_SOURCE` | `/data/files` (volume) or `docker:<container>:<path>` | `/data/files` |
| `DRIVE_CREDENTIALS` | path to the key / token JSON | — (required) |
| `DRIVE_ID` | Shared drive id (`0AF…`) | — |
| `DRIVE_NAME` | Shared drive name, used when `DRIVE_ID` is blank | — |
| `DRIVE_ROOT` | sub-folder path inside the drive | root |
| `DRIVE_FOLDERS` | folders to keep, first = general, second = signed | `Documents,Signed` |
| `DRIVE_ROUTE_SIGNED` | files containing "signed" go to the second folder | `true` |
| `DRIVE_INTERVAL` | seconds between runs (loop mode) | `600` |
| `DRIVE_LOG` | `stdout`, `stderr` or a file path | `stderr` |

Run one pass by hand — useful before trusting the schedule:

```bash
DRIVE_CREDENTIALS=... DRIVE_SOURCE=... DRIVE_NAME=HEXSign python3 scripts/drive-sync/drive_sync.py --once
```

Exit code is non-zero only when at least one file failed to upload.

---

## 4. Troubleshooting

- **`shared drive "X" not found`** — the service account is not a member of the Shared
  drive. Add it at drive level as Content manager, or use `DRIVE_ID` and share the folders.
- **`File not found: <id>` on upload** — usually a folder shared individually instead of
  the whole Shared drive; check membership again. All Drive calls send `supportsAllDrives`.
- **`403 insufficientPermissions`** — the JSON is an OAuth token without the Drive scope,
  or a service account that was never granted access to that folder.
- **Nothing uploads but files exist** — check `DRIVE_SOURCE`. In existing installs the
  documents sit one level in: `/usr/src/app/files/files`, not `/usr/src/app/files`.
- **Duplicate uploads** — the mirror matches on file name + size + md5. If a file is
  re-uploaded to the platform under a new name it will appear twice; that is expected.

## 5. What this does not do

- It does not upload documents you add **to** Drive back into HEXSign.
- It does not rename files — they keep the platform's internal names. Mapping them to
  document titles is a separate feature.
- It does not delete: removing a document in the platform leaves the Drive copy in place.
