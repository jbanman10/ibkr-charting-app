/**
 * Tiny file-backed persistence for client-side stores (drawings, …).
 *
 * localStorage lives inside the browser profile and dies with origin changes,
 * cache wipes, and profile resets — which kept eating the user's drawings
 * across desktop updates. This stores them as plain JSON files on disk:
 *   - packaged exe: <userData>/store/<key>.json  (DATA_DIR set by main.js)
 *   - dev:          apps/backend/.data/<key>.json
 * The frontend hydrates from here at boot and PUTs (debounced) on changes, so
 * drawings survive any reinstall, cache clear, or origin move — and can be
 * backed up by copying a file.
 */

import type { FastifyInstance } from 'fastify';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

const DATA_DIR = process.env.DATA_DIR ?? join(process.cwd(), '.data');
const KEYS = new Set(['drawings', 'theme', 'chartSettings', 'drawingDefaults']); // whitelist of persisted stores

const fileFor = (key: string) => join(DATA_DIR, 'store', `${key}.json`);

export async function registerStoreRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/store/:key', async (request, reply) => {
    const { key } = request.params as { key: string };
    if (!KEYS.has(key)) return reply.status(404).send({ error: 'Unknown store key' });
    try {
      const raw = await readFile(fileFor(key), 'utf8');
      return reply.type('application/json').send(raw);
    } catch {
      return { }; // no file yet — empty store
    }
  });

  app.put('/api/store/:key', async (request, reply) => {
    const { key } = request.params as { key: string };
    if (!KEYS.has(key)) return reply.status(404).send({ error: 'Unknown store key' });
    const body = request.body;
    if (body == null || typeof body !== 'object') {
      return reply.status(400).send({ error: 'Body must be a JSON object' });
    }
    try {
      const file = fileFor(key);
      await mkdir(join(DATA_DIR, 'store'), { recursive: true });
      // Write-then-rename so a crash mid-write can't corrupt the store file.
      const tmp = `${file}.tmp`;
      await writeFile(tmp, JSON.stringify(body, null, 2), 'utf8');
      await rename(tmp, file);
      return { ok: true };
    } catch (err) {
      app.log.error({ err, key }, 'store write failed');
      return reply.status(500).send({ error: 'write failed' });
    }
  });
}
