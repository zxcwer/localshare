// Central configuration. Every value can be overridden with an environment
// variable so the same build runs on a PC, a Pi, or a NAS without code changes.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const num = (v, fallback) => (v === undefined ? fallback : Number(v));

export const config = {
  host: process.env.HOST || '0.0.0.0',
  port: num(process.env.PORT, 8080),

  dataDir: process.env.DATA_DIR || path.join(projectRoot, 'data'),
  get uploadsDir() {
    return path.join(this.dataDir, 'uploads');
  },
  get dbPath() {
    return path.join(this.dataDir, 'localshare.db');
  },

  // Size limits (mega-bytes). Uploads beyond these are rejected.
  // Note: maxRoomMb and globalQuotaMb must each be >= maxFileMb, otherwise a
  // single large file is rejected by the room/global quota even if it is under
  // the per-file limit.
  maxFileMb: num(process.env.MAX_FILE_MB, 500),
  maxRoomMb: num(process.env.MAX_ROOM_MB, 4096),
  globalQuotaMb: num(process.env.GLOBAL_QUOTA_MB, 20480),

  // How long a room stays alive before it (and everything in it) is removed.
  roomTtlHours: num(process.env.ROOM_TTL_HOURS, 24),

  // Allowed per-file expiration choices offered in the UI (hours).
  fileTtlChoicesHours: (process.env.FILE_TTL_CHOICES || '1,24,168')
    .split(',')
    .map((n) => Number(n.trim()))
    .filter((n) => n > 0),

  // PIN brute-force protection.
  pinDigits: num(process.env.PIN_DIGITS, 6),
  maxPinAttempts: num(process.env.MAX_PIN_ATTEMPTS, 5),
  pinLockoutMinutes: num(process.env.PIN_LOCKOUT_MINUTES, 10),

  // How often the background sweep runs (seconds).
  sweepIntervalSeconds: num(process.env.SWEEP_INTERVAL_SECONDS, 60),
};

export const MB = 1024 * 1024;
