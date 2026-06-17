// SQLite schema + helpers. The database stores only metadata; the actual file
// bytes live on disk under config.uploadsDir, referenced by `stored_name`.
import fs from 'node:fs';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { config } from './config.js';

fs.mkdirSync(config.uploadsDir, { recursive: true });

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS rooms (
    id            TEXT PRIMARY KEY,
    pin_hash      TEXT NOT NULL UNIQUE,
    created_at    INTEGER NOT NULL,
    expires_at    INTEGER NOT NULL,
    failed_count  INTEGER NOT NULL DEFAULT 0,
    locked_until  INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS files (
    id            TEXT PRIMARY KEY,
    room_id       TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    original_name TEXT NOT NULL,
    stored_name   TEXT NOT NULL,
    size          INTEGER NOT NULL,
    mime_type     TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    expires_at    INTEGER NOT NULL,
    download_count INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_files_room    ON files(room_id);
  CREATE INDEX IF NOT EXISTS idx_files_expires ON files(expires_at);
  CREATE INDEX IF NOT EXISTS idx_rooms_expires ON rooms(expires_at);
`);

// PIN is hashed deterministically so the PC can look a room up by typing it,
// while the plaintext PIN is never stored. Brute force is contained by rate
// limiting + short room lifetime, not by the hash alone.
const PIN_SALT = process.env.PIN_SALT || 'localshare-static-salt';
export const hashPin = (pin) =>
  crypto.createHmac('sha256', PIN_SALT).update(String(pin)).digest('hex');

export const newId = () => crypto.randomBytes(12).toString('hex');

export function generateUniquePin() {
  const max = 10 ** config.pinDigits;
  for (let attempt = 0; attempt < 50; attempt++) {
    const pin = String(crypto.randomInt(0, max)).padStart(config.pinDigits, '0');
    const exists = db
      .prepare('SELECT 1 FROM rooms WHERE pin_hash = ?')
      .get(hashPin(pin));
    if (!exists) return pin;
  }
  throw new Error('Could not allocate a unique PIN; too many active rooms.');
}
