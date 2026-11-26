#!/usr/bin/env python3
"""HEXSign -> cloud drive mirror.

One-way, additive mirror of the documents stored by the HEXSign platform into a
Google Drive (My Drive folder or a Shared drive). Nothing on the Drive is ever
deleted or overwritten with older content.

Configuration is entirely through environment variables so the same script works
for a compose sidecar, a systemd service or a cron job:

  DRIVE_ENABLED=true|false            master switch (default true)
  DRIVE_SOURCE=...                    where the platform's files are:
                                        /data/files                    (a mounted volume)
                                        docker:opensign-server:/usr/src/app/files/files
  DRIVE_CREDENTIALS=/path/creds.json  service-account key OR an OAuth user token
  DRIVE_ID=0AF...                     shared drive id          (optional)
  DRIVE_NAME=HEXSign                  shared drive name        (used if no id)
  DRIVE_ROOT=                         folder inside the drive / My Drive (optional)
  DRIVE_FOLDERS=Documents,Signed      sub folders to keep
  DRIVE_ROUTE_SIGNED=true             names containing "signed" go to the 2nd folder
  DRIVE_INTERVAL=600                  seconds between runs (loop mode)
  DRIVE_LOG=stderr|stdout|/path       where to log

Run once:   ./drive_sync.py --once
Loop:       ./drive_sync.py            (docker compose / systemd default)
"""
from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

from google.auth.transport.requests import Request
from google.oauth2 import service_account
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload

FOLDER_MIME = "application/vnd.google-apps.folder"
SCOPES = ["https://www.googleapis.com/auth/drive"]


# --------------------------------------------------------------------------- env
def env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def log(msg: str) -> None:
    line = f"{datetime.datetime.now():%Y-%m-%d %H:%M:%S} {msg}"
    target = env("DRIVE_LOG", "stderr")
    print(line, file=sys.stdout if target == "stdout" else sys.stderr, flush=True)
    if target.startswith("/"):
        with open(target, "a") as fh:
            fh.write(line + "\n")


# ----------------------------------------------------------------- credentials
def service():
    path = env("DRIVE_CREDENTIALS")
    if not path:
        raise SystemExit("DRIVE_CREDENTIALS is not set — point it at a service-account key or an OAuth token file")
    if not os.path.exists(path):
        raise SystemExit(f"DRIVE_CREDENTIALS file not found: {path}")

    try:
        data = json.load(open(path))
    except json.JSONDecodeError as exc:
        raise SystemExit(f"DRIVE_CREDENTIALS is not valid JSON: {exc}") from exc

    if data.get("type") == "service_account":
        creds = service_account.Credentials.from_service_account_info(data, scopes=SCOPES)
        who = data.get("client_email", "service account")
    elif data.get("refresh_token"):
        # normalise a unix-int expiry (google-auth only accepts ISO strings)
        if isinstance(data.get("expiry"), (int, float)):
            data["expiry"] = datetime.datetime.utcfromtimestamp(data["expiry"]).isoformat() + "Z"
            json.dump(data, open(path, "w"))
        creds = Credentials.from_authorized_user_info(data, scopes=SCOPES)
        if not creds.valid and creds.refresh_token:
            creds.refresh(Request())
            json.dump(json.loads(creds.to_json()), open(path, "w"))
        who = data.get("client_id", "oauth user")
    else:
        raise SystemExit("DRIVE_CREDENTIALS is neither a service-account key nor an OAuth token (no refresh_token)")

    log(f"credentials: {who}")
    return build("drive", "v3", credentials=creds, cache_discovery=False)


# --------------------------------------------------------------------- folders
def resolve_drive(svc) -> str | None:
    drive_id = env("DRIVE_ID")
    if drive_id:
        return drive_id
    name = env("DRIVE_NAME")
    if not name:
        return None
    token, found = None, None
    while True:
        res = svc.drives().list(pageSize=100, pageToken=token, fields="nextPageToken, drives(id,name)").execute()
        for d in res.get("drives", []):
            if d["name"].strip().lower() == name.strip().lower():
                found = d["id"]
        token = res.get("nextPageToken")
        if not token or found:
            break
    if not found:
        raise SystemExit(f'shared drive "{name}" not found — share it with the service account, or set DRIVE_ID')
    log(f"shared drive: {name} ({found})")
    return found


def ensure_folder(svc, drive_id: str | None, name: str, parent: str | None) -> str:
    q = f"name = '{name}' and mimeType = '{FOLDER_MIME}' and trashed = false"
    if parent:
        q += f" and '{parent}' in parents"
    if drive_id:
        kwargs = dict(corpora="drive", driveId=drive_id, includeItemsFromAllDrives=True)
    else:
        kwargs = dict()
    res = svc.files().list(q=q, supportsAllDrives=True, spaces="drive",
                           fields="files(id,name)", pageSize=10, **kwargs).execute()
    files = res.get("files", [])
    if files:
        return files[0]["id"]
    body: dict[str, object] = {"name": name, "mimeType": FOLDER_MIME}
    if parent:
        body["parents"] = [parent]
    if drive_id:
        body["driveId"] = drive_id
    created = svc.files().create(body=body, supportsAllDrives=True, fields="id").execute()
    log(f"created folder {name}")
    return created["id"]


def targets(svc, drive_id):
    root = ensure_folder(svc, drive_id, env("DRIVE_ROOT"), None) if env("DRIVE_ROOT") else None
    names = [n.strip() for n in env("DRIVE_FOLDERS", "Documents,Signed").split(",") if n.strip()]
    ids = {n: ensure_folder(svc, drive_id, n, root) for n in names}
    log("folders: " + ", ".join(f"{n}={i}" for n, i in ids.items()))
    return names, ids


# ----------------------------------------------------------------------- files
def stage() -> str:
    source = env("DRIVE_SOURCE", "/data/files")
    dest = tempfile.mkdtemp(prefix="hexsign-drive-")
    if source.startswith("docker:"):
        _, container, path = source.split(":", 2)
        subprocess.run(["docker", "cp", f"{container}:{path}/.", dest], check=True, capture_output=True)
    else:
        if not os.path.isdir(source):
            raise SystemExit(f"DRIVE_SOURCE is not a directory: {source}")
        for name in os.listdir(source):
            src = os.path.join(source, name)
            if os.path.isfile(src):
                shutil.copy2(src, dest)
    return dest


def md5(path: str) -> str:
    h = hashlib.md5()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def remote_index(svc, drive_id, ids):
    out = {}
    for label, fid in ids.items():
        token = None
        while True:
            res = svc.files().list(
                q=f"'{fid}' in parents and trashed = false", supportsAllDrives=True,
                includeItemsFromAllDrives=bool(drive_id),
                corpora="drive" if drive_id else "user", driveId=drive_id,
                pageSize=200, pageToken=token,
                fields="nextPageToken, files(id,name,size,md5Checksum)").execute()
            for f in res.get("files", []):
                out[f["name"]] = {"id": f["id"], "size": int(f.get("size", 0)),
                                  "md5": f.get("md5Checksum"), "folder": label}
            token = res.get("nextPageToken")
            if not token:
                break
    return out


def route(name: str, names, ids):
    if env("DRIVE_ROUTE_SIGNED", "true").lower() == "true" and len(names) > 1:
        return names[1] if "signed" in name.lower() else names[0]
    return names[0]


def run_once() -> int:
    svc = service()
    drive_id = resolve_drive(svc)
    names, ids = targets(svc, drive_id)

    staged = stage()
    try:
        local = {n: os.path.join(staged, n) for n in os.listdir(staged)
                 if os.path.isfile(os.path.join(staged, n))}
        remote = remote_index(svc, drive_id, ids)
        log(f"local={len(local)} remote={len(remote)}")

        uploaded = unchanged = failed = 0
        for name, path in sorted(local.items()):
            have = remote.get(name)
            size = os.path.getsize(path)
            if have and have["size"] == size and (not have["md5"] or have["md5"] == md5(path)):
                unchanged += 1
                continue
            folder = route(name, names, ids)
            try:
                media = MediaFileUpload(path)
                if have:
                    svc.files().update(fileId=have["id"], media_body=media, supportsAllDrives=True).execute()
                    log(f"updated {folder}/{name}")
                else:
                    svc.files().create(body={"name": name, "parents": [ids[folder]]},
                                       media_body=media, supportsAllDrives=True, fields="id").execute()
                    log(f"uploaded {folder}/{name}")
                uploaded += 1
            except Exception as exc:                      # noqa: BLE001
                failed += 1
                log(f"FAILED {name}: {type(exc).__name__} {str(exc)[:140]}")
        log(f"done uploaded={uploaded} unchanged={unchanged} failed={failed}")
        return 0 if failed == 0 else 1
    finally:
        shutil.rmtree(staged, ignore_errors=True)


def main() -> int:
    ap = argparse.ArgumentParser(description="Mirror HEXSign documents into a Google Drive")
    ap.add_argument("--once", action="store_true", help="run a single sync and exit")
    args = ap.parse_args()

    if env("DRIVE_ENABLED", "true").lower() != "true":
        log("DRIVE_ENABLED=false — nothing to do")
        return 0

    if args.once:
        return run_once()

    interval = int(env("DRIVE_INTERVAL", "600"))
    log(f"loop mode, every {interval}s")
    while True:
        try:
            run_once()
        except SystemExit:
            raise
        except Exception as exc:                          # noqa: BLE001
            log(f"run failed: {type(exc).__name__} {str(exc)[:200]}")
        time.sleep(interval)


if __name__ == "__main__":
    sys.exit(main())
