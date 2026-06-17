# 📤 localshare

Send files (photos) between devices on your local network using a **PIN-code
room** — no USB cable, no cloud login. Files **expire automatically** so a small
disk never fills up.

Built with Node.js + Fastify + SQLite. See [`DESIGN.md`](./DESIGN.md) for the
full design and rationale.

## How it works

1. On the **sending** device (e.g. iPhone), open the app and tap **Create a
   room**. You get a 6-digit PIN.
2. Pick photos/files and upload them, choosing how long they should live.
3. On the **receiving** device (e.g. Windows PC), open the app, enter the PIN,
   and download files individually or all at once as a `.zip`.
4. Expired files are deleted automatically, freeing storage.

## Requirements

- Node.js 18+ (tested on Node 22).
- Both devices on the same Wi-Fi / LAN.

## Run

```bash
npm install
npm start
```

The server prints the LAN URL(s), e.g.:

```
localshare ready. Open from your phone/PC at: http://192.168.1.42:8080
```

Open that URL in a browser on **both** devices. Best run on an always-on device
(Raspberry Pi, NAS, old laptop) so it's available whenever you need it.

> Tip: give the host a static/reserved IP in your router so the URL never
> changes.

## Configuration

All settings have sensible defaults and can be overridden with environment
variables:

| Variable                | Default | Meaning                                   |
|-------------------------|---------|-------------------------------------------|
| `PORT`                  | `8080`  | HTTP port                                 |
| `HOST`                  | `0.0.0.0` | Bind address                            |
| `DATA_DIR`              | `./data`| Where the DB + uploads live               |
| `MAX_FILE_MB`           | `500`   | Max size per file                         |
| `MAX_ROOM_MB`           | `4096`  | Max total size per room                   |
| `GLOBAL_QUOTA_MB`       | `20480` | Max total storage across all rooms        |
| `ROOM_TTL_HOURS`        | `24`    | How long a room lives                     |
| `FILE_TTL_CHOICES`      | `1,24,168` | Per-file expiry options (hours) in the UI |
| `PIN_DIGITS`            | `6`     | PIN length                                |
| `MAX_PIN_ATTEMPTS`      | `5`     | Wrong PINs before lockout                 |
| `PIN_LOCKOUT_MINUTES`   | `10`    | Lockout duration                          |
| `SWEEP_INTERVAL_SECONDS`| `60`    | How often expired files are purged        |
| `PIN_SALT`              | (built-in) | Set a secret to harden PIN hashing     |

Example:

```bash
PORT=8080 DATA_DIR=/var/lib/localshare MAX_ROOM_MB=500 PIN_SALT=change-me npm start
```

## Security notes

This is a **LAN convenience tool**. Anyone on your network who knows a room's
PIN can read that room. PIN entry is rate-limited and rooms self-expire, but do
**not** expose the port directly to the public internet. See `DESIGN.md` →
*Identity & security model* for details.
