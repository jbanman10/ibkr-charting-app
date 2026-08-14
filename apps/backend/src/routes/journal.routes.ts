/**
 * Trading journal — one screenshot + one note per day.
 *
 *   GET    /api/journal/summary            which days have an entry (calendar dots)
 *   GET    /api/journal/day/:date          that day's note + capture metadata
 *   PUT    /api/journal/day/:date          save the note
 *   PUT    /api/journal/day/:date/image    save (replace) the day's capture
 *   GET    /api/journal/day/:date/image    the PNG itself
 *   DELETE /api/journal/day/:date/image    drop the capture
 *
 * Notes live in <DATA_DIR>/store/journal.json alongside the other stores; images
 * are written as real PNG files under <DATA_DIR>/journal/ rather than base64 in
 * JSON, so the metadata file stays small and a capture can be opened, copied or
 * backed up with any file manager.
 */

import type { FastifyInstance } from 'fastify';
import { mkdir, readFile, writeFile, rename, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

const DATA_DIR = process.env.DATA_DIR ?? join(process.cwd(), '.data');
const STORE_FILE = join(DATA_DIR, 'store', 'journal.json');
const IMAGE_DIR = join(DATA_DIR, 'journal');

// A screenshot of a 4-panel grid runs a few hundred KB; base64 inflates it by a
// third. Fastify's 1MB default would reject those, so this route gets its own.
const IMAGE_BODY_LIMIT = 16 * 1024 * 1024;

/** Strict, because `date` is used as a filename — no traversal, no surprises. */
const DateParam = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });
const NoteBody = z.object({ note: z.string().max(20_000) });
const ImageBody = z.object({
  image: z.string().regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/, 'expected a PNG data URL'),
});

interface JournalEntry {
  note?: string;
  capturedAt?: number; // unix ms of the stored screenshot
  updatedAt?: number;
}

type JournalStore = Record<string, JournalEntry>; // date → entry

let cache: JournalStore | null = null;

async function load(): Promise<JournalStore> {
  if (cache) return cache;
  try {
    const raw = await readFile(STORE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    cache = parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    cache = {};
  }
  return cache!;
}

async function save(): Promise<void> {
  await mkdir(join(DATA_DIR, 'store'), { recursive: true });
  const tmp = `${STORE_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(cache ?? {}, null, 2), 'utf8');
  await rename(tmp, STORE_FILE);
}

const imageFile = (date: string) => join(IMAGE_DIR, `${date}.png`);

async function hasImage(date: string): Promise<boolean> {
  try {
    await stat(imageFile(date));
    return true;
  } catch {
    return false;
  }
}

export async function registerJournalRoutes(app: FastifyInstance): Promise<void> {
  // ─── Which days have something ─────────────────────────────────────────────
  app.get('/api/journal/summary', async () => {
    const store = await load();
    const days = await Promise.all(
      Object.entries(store).map(async ([date, e]) => ({
        date,
        hasNote: !!e.note?.trim(),
        hasImage: await hasImage(date),
        capturedAt: e.capturedAt ?? null,
        // Enough for a calendar tooltip without shipping every note.
        excerpt: (e.note ?? '').trim().slice(0, 120),
      }))
    );
    return { days: days.filter((d) => d.hasNote || d.hasImage).sort((a, b) => a.date.localeCompare(b.date)) };
  });

  // ─── One day ───────────────────────────────────────────────────────────────
  app.get('/api/journal/day/:date', async (request, reply) => {
    const parsed = DateParam.safeParse(request.params);
    if (!parsed.success) return reply.status(400).send({ error: 'date must be YYYY-MM-DD' });
    const { date } = parsed.data;
    const store = await load();
    const e = store[date] ?? {};
    return {
      date,
      note: e.note ?? '',
      hasImage: await hasImage(date),
      capturedAt: e.capturedAt ?? null,
    };
  });

  app.put('/api/journal/day/:date', async (request, reply) => {
    const p = DateParam.safeParse(request.params);
    const b = NoteBody.safeParse(request.body);
    if (!p.success) return reply.status(400).send({ error: 'date must be YYYY-MM-DD' });
    if (!b.success) return reply.status(400).send({ error: 'note is required' });

    const store = await load();
    const entry = store[p.data.date] ?? {};
    entry.note = b.data.note;
    entry.updatedAt = Date.now();
    store[p.data.date] = entry;
    await save();
    return { ok: true };
  });

  // ─── The capture ───────────────────────────────────────────────────────────
  app.put('/api/journal/day/:date/image', { bodyLimit: IMAGE_BODY_LIMIT }, async (request, reply) => {
    const p = DateParam.safeParse(request.params);
    const b = ImageBody.safeParse(request.body);
    if (!p.success) return reply.status(400).send({ error: 'date must be YYYY-MM-DD' });
    if (!b.success) return reply.status(400).send({ error: 'image must be a PNG data URL' });

    const base64 = b.data.image.slice(b.data.image.indexOf(',') + 1);
    const buf = Buffer.from(base64, 'base64');
    if (!buf.length) return reply.status(400).send({ error: 'empty image' });

    try {
      await mkdir(IMAGE_DIR, { recursive: true });
      const file = imageFile(p.data.date);
      const tmp = `${file}.tmp`;
      await writeFile(tmp, buf);
      await rename(tmp, file); // replace atomically — one capture per day
    } catch (err) {
      app.log.error({ err, date: p.data.date }, 'journal image write failed');
      return reply.status(500).send({ error: 'could not save the capture' });
    }

    const store = await load();
    const entry = store[p.data.date] ?? {};
    entry.capturedAt = Date.now();
    store[p.data.date] = entry;
    await save();
    return { ok: true, bytes: buf.length, capturedAt: entry.capturedAt };
  });

  app.get('/api/journal/day/:date/image', async (request, reply) => {
    const p = DateParam.safeParse(request.params);
    if (!p.success) return reply.status(400).send({ error: 'date must be YYYY-MM-DD' });
    try {
      const buf = await readFile(imageFile(p.data.date));
      return reply.type('image/png').header('cache-control', 'no-cache').send(buf);
    } catch {
      return reply.status(404).send({ error: 'no capture for that day' });
    }
  });

  app.delete('/api/journal/day/:date/image', async (request, reply) => {
    const p = DateParam.safeParse(request.params);
    if (!p.success) return reply.status(400).send({ error: 'date must be YYYY-MM-DD' });
    try { await unlink(imageFile(p.data.date)); } catch { /* already gone */ }
    const store = await load();
    if (store[p.data.date]) { delete store[p.data.date].capturedAt; await save(); }
    return { ok: true };
  });
}
