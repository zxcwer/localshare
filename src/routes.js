// HTTP API. Identity model:
//   - Creating a room returns an opaque, unguessable `roomId` (96-bit token)
//     plus the human PIN. The creator (iPhone) keeps the roomId and uses it for
//     all uploads/management without re-entering the PIN.
//   - The PC enters the PIN at /api/rooms/access; on success it receives the
//     same roomId, which then acts as its bearer capability for listing and
//     downloading. PIN entry is rate-limited per IP.
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import archiver from 'archiver';
import { db, hashPin, newId, generateUniquePin } from './db.js';
import { config, MB } from './config.js';
import { checkLocked, registerFailure, registerSuccess } from './rateLimit.js';

const HOUR = 3600 * 1000;

function getLiveRoom(roomId) {
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
  if (!room || room.expires_at <= Date.now()) return null;
  return room;
}

function liveFiles(roomId) {
  return db
    .prepare(
      'SELECT * FROM files WHERE room_id = ? AND expires_at > ? ORDER BY created_at DESC'
    )
    .all(roomId, Date.now());
}

function publicFile(f) {
  return {
    id: f.id,
    name: f.original_name,
    size: f.size,
    mimeType: f.mime_type,
    createdAt: f.created_at,
    expiresAt: f.expires_at,
    downloadCount: f.download_count,
  };
}

function roomUsage(roomId) {
  const row = db
    .prepare('SELECT COALESCE(SUM(size),0) AS used FROM files WHERE room_id = ?')
    .get(roomId);
  return row.used;
}

function globalUsage() {
  const row = db.prepare('SELECT COALESCE(SUM(size),0) AS used FROM files').get();
  return row.used;
}

export async function registerRoutes(app) {
  // --- Create a room (iPhone) ---------------------------------------------
  app.post('/api/rooms', async () => {
    const id = newId();
    const pin = generateUniquePin();
    const now = Date.now();
    const expiresAt = now + config.roomTtlHours * HOUR;
    db.prepare(
      'INSERT INTO rooms (id, pin_hash, created_at, expires_at) VALUES (?, ?, ?, ?)'
    ).run(id, hashPin(pin), now, expiresAt);
    return {
      roomId: id,
      pin,
      expiresAt,
      fileTtlChoicesHours: config.fileTtlChoicesHours,
      limits: { maxFileMb: config.maxFileMb, maxRoomMb: config.maxRoomMb },
    };
  });

  // --- Exchange a PIN for a roomId (PC) -----------------------------------
  app.post('/api/rooms/access', async (req, reply) => {
    const ip = req.ip;
    const locked = checkLocked(ip);
    if (locked) {
      return reply.code(429).send({
        error: `Too many attempts. Try again in ${locked}s.`,
        retryAfter: locked,
      });
    }
    const pin = String(req.body?.pin || '').trim();
    if (!pin) return reply.code(400).send({ error: 'PIN required.' });

    const room = db.prepare('SELECT * FROM rooms WHERE pin_hash = ?').get(hashPin(pin));
    if (!room || room.expires_at <= Date.now()) {
      registerFailure(ip);
      return reply.code(404).send({ error: 'No active room for that PIN.' });
    }
    registerSuccess(ip);
    return { roomId: room.id, expiresAt: room.expires_at };
  });

  // --- Room info + file listing -------------------------------------------
  app.get('/api/rooms/:roomId', async (req, reply) => {
    const room = getLiveRoom(req.params.roomId);
    if (!room) return reply.code(404).send({ error: 'Room not found or expired.' });
    return {
      roomId: room.id,
      expiresAt: room.expires_at,
      fileTtlChoicesHours: config.fileTtlChoicesHours,
      limits: { maxFileMb: config.maxFileMb, maxRoomMb: config.maxRoomMb },
      usedBytes: roomUsage(room.id),
      files: liveFiles(room.id).map(publicFile),
    };
  });

  // --- Upload one or more files -------------------------------------------
  app.post('/api/rooms/:roomId/files', async (req, reply) => {
    const room = getLiveRoom(req.params.roomId);
    if (!room) return reply.code(404).send({ error: 'Room not found or expired.' });

    const ttlHours = Number(req.query.ttlHours) || config.fileTtlChoicesHours[0];
    if (!config.fileTtlChoicesHours.includes(ttlHours)) {
      return reply.code(400).send({ error: 'Invalid expiration choice.' });
    }
    const expiresAt = Math.min(Date.now() + ttlHours * HOUR, room.expires_at);

    const saved = [];
    const cleanup = () => {
      for (const s of saved) {
        try {
          fs.unlinkSync(path.join(config.uploadsDir, s.stored_name));
        } catch {}
      }
    };

    try {
      const parts = req.files(); // async iterator of file parts
      for await (const part of parts) {
        const storedName = newId() + path.extname(part.filename || '');
        const dest = path.join(config.uploadsDir, storedName);
        await pipeline(part.file, fs.createWriteStream(dest));

        if (part.file.truncated) {
          try { fs.unlinkSync(dest); } catch {}
          cleanup();
          return reply
            .code(413)
            .send({ error: `"${part.filename}" exceeds the ${config.maxFileMb} MB file limit.` });
        }

        const size = fs.statSync(dest).size;

        // Enforce room + global quotas including everything in this batch.
        const projectedRoom =
          roomUsage(room.id) + saved.reduce((a, s) => a + s.size, 0) + size;
        const projectedGlobal =
          globalUsage() + saved.reduce((a, s) => a + s.size, 0) + size;
        if (projectedRoom > config.maxRoomMb * MB) {
          try { fs.unlinkSync(dest); } catch {}
          cleanup();
          return reply
            .code(413)
            .send({ error: `Room storage limit (${config.maxRoomMb} MB) reached.` });
        }
        if (projectedGlobal > config.globalQuotaMb * MB) {
          try { fs.unlinkSync(dest); } catch {}
          cleanup();
          return reply.code(507).send({ error: 'Server storage is full.' });
        }

        saved.push({
          id: newId(),
          stored_name: storedName,
          original_name: part.filename || storedName,
          size,
          mime_type: part.mimetype || 'application/octet-stream',
        });
      }
    } catch (err) {
      cleanup();
      req.log.error(err);
      return reply.code(500).send({ error: 'Upload failed.' });
    }

    if (saved.length === 0) {
      return reply.code(400).send({ error: 'No files were uploaded.' });
    }

    const now = Date.now();
    const insert = db.prepare(
      `INSERT INTO files
       (id, room_id, original_name, stored_name, size, mime_type, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const tx = db.transaction((rows) => {
      for (const s of rows) {
        insert.run(s.id, room.id, s.original_name, s.stored_name, s.size, s.mime_type, now, expiresAt);
      }
    });
    tx(saved);

    return { uploaded: saved.length, files: liveFiles(room.id).map(publicFile) };
  });

  // --- Download a single file ---------------------------------------------
  app.get('/api/rooms/:roomId/files/:fileId', async (req, reply) => {
    const room = getLiveRoom(req.params.roomId);
    if (!room) return reply.code(404).send({ error: 'Room not found or expired.' });
    const f = db
      .prepare('SELECT * FROM files WHERE id = ? AND room_id = ? AND expires_at > ?')
      .get(req.params.fileId, room.id, Date.now());
    if (!f) return reply.code(404).send({ error: 'File not found or expired.' });

    const full = path.join(config.uploadsDir, f.stored_name);
    if (!fs.existsSync(full)) return reply.code(410).send({ error: 'File no longer available.' });

    db.prepare('UPDATE files SET download_count = download_count + 1 WHERE id = ?').run(f.id);
    reply.header('Content-Type', f.mime_type);
    reply.header(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(f.original_name)}`
    );
    return reply.send(fs.createReadStream(full));
  });

  // --- Download everything as a zip ---------------------------------------
  app.get('/api/rooms/:roomId/zip', async (req, reply) => {
    const room = getLiveRoom(req.params.roomId);
    if (!room) return reply.code(404).send({ error: 'Room not found or expired.' });
    const files = liveFiles(room.id);
    if (files.length === 0) return reply.code(404).send({ error: 'Room is empty.' });

    reply.header('Content-Type', 'application/zip');
    reply.header('Content-Disposition', 'attachment; filename="localshare.zip"');

    const archive = archiver('zip', { zlib: { level: 0 } }); // images are already compressed
    archive.on('warning', (e) => req.log.warn(e));
    archive.on('error', (e) => req.log.error(e));
    for (const f of files) {
      const full = path.join(config.uploadsDir, f.stored_name);
      if (fs.existsSync(full)) archive.file(full, { name: f.original_name });
    }
    archive.finalize();
    return reply.send(archive);
  });

  // --- Delete a file (creator convenience) --------------------------------
  app.delete('/api/rooms/:roomId/files/:fileId', async (req, reply) => {
    const room = getLiveRoom(req.params.roomId);
    if (!room) return reply.code(404).send({ error: 'Room not found or expired.' });
    const f = db
      .prepare('SELECT * FROM files WHERE id = ? AND room_id = ?')
      .get(req.params.fileId, room.id);
    if (!f) return reply.code(404).send({ error: 'File not found.' });
    try {
      fs.unlinkSync(path.join(config.uploadsDir, f.stored_name));
    } catch {}
    db.prepare('DELETE FROM files WHERE id = ?').run(f.id);
    return { deleted: f.id };
  });
}
