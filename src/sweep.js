// Background cleanup. Two responsibilities:
//   1. Delete expired files (and expired rooms) from disk + DB so storage is
//      actually reclaimed, not just hidden.
//   2. Reconcile disk vs DB on startup, removing orphaned upload files left
//      behind by a crash or restart.
import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.js';
import { config } from './config.js';

function unlinkQuiet(storedName) {
  try {
    fs.unlinkSync(path.join(config.uploadsDir, storedName));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('unlink failed:', storedName, err.message);
  }
}

export function sweepOnce() {
  const now = Date.now();

  // Expired individual files.
  const expiredFiles = db
    .prepare('SELECT id, stored_name FROM files WHERE expires_at <= ?')
    .all(now);
  for (const f of expiredFiles) unlinkQuiet(f.stored_name);

  // Files belonging to expired rooms (the room itself is going away).
  const filesInDeadRooms = db
    .prepare(
      `SELECT f.stored_name FROM files f
       JOIN rooms r ON r.id = f.room_id
       WHERE r.expires_at <= ?`
    )
    .all(now);
  for (const f of filesInDeadRooms) unlinkQuiet(f.stored_name);

  const delFiles = db.prepare('DELETE FROM files WHERE expires_at <= ?').run(now);
  // ON DELETE CASCADE removes the files rows of expired rooms.
  const delRooms = db.prepare('DELETE FROM rooms WHERE expires_at <= ?').run(now);

  return { files: delFiles.changes, rooms: delRooms.changes };
}

export function reconcileOrphans() {
  const known = new Set(
    db.prepare('SELECT stored_name FROM files').all().map((r) => r.stored_name)
  );
  let removed = 0;
  for (const name of fs.readdirSync(config.uploadsDir)) {
    if (!known.has(name)) {
      unlinkQuiet(name);
      removed++;
    }
  }
  return removed;
}

export function startSweeper(log) {
  const orphans = reconcileOrphans();
  if (orphans) log?.info(`startup: removed ${orphans} orphaned upload file(s)`);

  const tick = () => {
    const { files, rooms } = sweepOnce();
    if (files || rooms) log?.info(`sweep: removed ${files} file(s), ${rooms} room(s)`);
  };
  tick();
  const timer = setInterval(tick, config.sweepIntervalSeconds * 1000);
  timer.unref?.();
  return timer;
}
