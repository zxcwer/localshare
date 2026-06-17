import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { config, MB } from './config.js';
import { registerRoutes } from './routes.js';
import { startSweeper } from './sweep.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL || 'info' },
  bodyLimit: 1 * MB, // JSON bodies only; uploads go through multipart limits.
});

await app.register(multipart, {
  limits: {
    fileSize: config.maxFileMb * MB,
    files: 50,
  },
});

await app.register(fastifyStatic, {
  root: path.join(__dirname, '..', 'public'),
  prefix: '/',
});

await registerRoutes(app);

startSweeper(app.log);

function lanAddresses() {
  const out = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  }
  return out;
}

try {
  await app.listen({ host: config.host, port: config.port });
  const urls = lanAddresses().map((ip) => `http://${ip}:${config.port}`);
  app.log.info(`localshare ready. Open from your phone/PC at: ${urls.join('  ')}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
