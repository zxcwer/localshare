// Simple in-memory, per-IP limiter for PIN entry. Brute-forcing a 6-digit PIN
// means many wrong guesses from one client, so we lock that client out after a
// handful of failures. State is intentionally in-memory: a restart clears it,
// which is acceptable for a small LAN tool.
import { config } from './config.js';

const attempts = new Map(); // ip -> { count, lockedUntil }

export function checkLocked(ip) {
  const rec = attempts.get(ip);
  if (rec && rec.lockedUntil > Date.now()) {
    return Math.ceil((rec.lockedUntil - Date.now()) / 1000);
  }
  return 0;
}

export function registerFailure(ip) {
  const rec = attempts.get(ip) || { count: 0, lockedUntil: 0 };
  rec.count += 1;
  if (rec.count >= config.maxPinAttempts) {
    rec.lockedUntil = Date.now() + config.pinLockoutMinutes * 60 * 1000;
    rec.count = 0;
  }
  attempts.set(ip, rec);
}

export function registerSuccess(ip) {
  attempts.delete(ip);
}
