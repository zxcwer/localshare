# localshare — Design

Local-network file sharing via PIN-code rooms with per-file expiration.
No USB, no cloud accounts — both devices just open a browser on the same Wi-Fi.

## Goal

Send photos/files from an iPhone to a Windows PC (or any direction) over the
local network. The phone creates a **room** protected by a **PIN**, uploads
files, and the PC opens the same web app, enters the PIN, and downloads them.
Files **expire** and are deleted automatically so a small disk never fills up.

## Architecture

```
iPhone (Safari)  ──create / upload──►  ┌────────────────────────┐
                                       │  localshare (Node/      │
PC (browser)     ──PIN / download──►   │  Fastify) + SQLite +    │
                                       │  filesystem uploads     │
                                       └────────────────────────┘
        all on the same LAN; server runs on an always-on device
        (Raspberry Pi / NAS / old laptop) listening on 0.0.0.0
```

- **Backend:** Node.js + Fastify (single process).
- **Metadata:** SQLite (`better-sqlite3`), WAL mode. Stores rooms + file rows.
- **File bytes:** stored on disk under `data/uploads/`, referenced by row.
- **Frontend:** one static, responsive page (`public/`). Works in iOS Safari
  and desktop browsers; no build step, no framework.

## Identity & security model

There are two secrets:

| Secret      | Who holds it          | Purpose                                            |
|-------------|-----------------------|----------------------------------------------------|
| `roomId`    | Creator + anyone who entered the PIN | 96-bit unguessable bearer token. Grants list/upload/download. |
| `PIN`       | Shown to the creator; typed by the receiver | Human-friendly gate that hands out the `roomId`. |

- Creating a room returns `roomId` + `PIN`. The creator uses `roomId` directly.
- The receiver POSTs the `PIN` to `/api/rooms/access`; on success it gets the
  `roomId` and uses that thereafter.
- The PIN is stored only as an HMAC-SHA256 hash (`PIN_SALT`), never plaintext.
- **Brute-force protection:** PIN entry is rate-limited per client IP
  (`MAX_PIN_ATTEMPTS` failures → lockout for `PIN_LOCKOUT_MINUTES`), and PINs
  are 6 digits by default. Rooms also self-expire (`ROOM_TTL_HOURS`), shrinking
  the attack window.

> Threat model: this is a LAN convenience tool. Anyone on your Wi-Fi who learns
> the PIN can read the room. That is the intended trade-off. Do not expose the
> port to the public internet.

## Expiration & storage reclamation

Two layers work together:

1. **Lazy filtering** — listings/downloads ignore anything past `expires_at`,
   so expired files never appear even before deletion.
2. **Active sweep** — a background timer (`SWEEP_INTERVAL_SECONDS`) deletes
   expired files (and expired rooms) from both SQLite and disk. This is what
   actually frees space.
3. **Startup reconciliation** — on boot, any upload blob with no matching DB
   row (left by a crash) is removed.

Hard limits prevent the disk filling: `MAX_FILE_MB`, `MAX_ROOM_MB`,
`GLOBAL_QUOTA_MB`. Uploads past a limit are rejected (413 / 507).

## HTTP API

| Method | Path                                   | Purpose                              |
|--------|----------------------------------------|--------------------------------------|
| POST   | `/api/rooms`                           | Create room → `{roomId, pin, ...}`   |
| POST   | `/api/rooms/access`                    | `{pin}` → `{roomId}` (rate-limited)  |
| GET    | `/api/rooms/:roomId`                   | Room info + live file list           |
| POST   | `/api/rooms/:roomId/files?ttlHours=N`  | Upload (multipart, many files)       |
| GET    | `/api/rooms/:roomId/files/:fileId`     | Download one file                    |
| GET    | `/api/rooms/:roomId/zip`               | Download all files as a zip          |
| DELETE | `/api/rooms/:roomId/files/:fileId`     | Delete a file                        |

## Data model

```
rooms(id, pin_hash, created_at, expires_at, failed_count, locked_until)
files(id, room_id→rooms.id ON DELETE CASCADE, original_name, stored_name,
      size, mime_type, created_at, expires_at, download_count)
```

## Known gaps / future work

- **HEIC photos:** iPhones save HEIC, which Windows may not preview. Today the
  file is served as-is. Optional: convert HEIC→JPEG on upload (e.g. `sharp`).
- **Finding the server:** the phone must open `http://<server-ip>:8080`.
  Add a **QR code** on the create screen and/or mDNS (`localshare.local`).
- **HTTPS:** plain HTTP is fine for LAN uploads, but iOS gates some features
  (clipboard, PWA install) behind HTTPS. A self-signed cert is possible later.
- **PC → iPhone:** the room model is symmetric; exposing upload on the receiver
  side is a small addition.
- **One-time / burn-after-download** files as an extra privacy option.
- **Auth hardening** if ever run on an untrusted network.

## Running

See `README.md`. `npm install && npm start`, then open the printed LAN URL on
both devices.
