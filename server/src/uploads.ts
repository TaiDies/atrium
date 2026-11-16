import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync, readdirSync, statSync } from 'node:fs';
import { appendFile, open, readFile, rename, truncate, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireUser } from './auth.js';
import { config } from './config.js';
import { CHUNK_MB_MIN, getSettings } from './settings.js';
import { checkStorage, uploadLimitBytes } from './limits.js';
import { HttpError, parse } from './util.js';

// Uploads in pieces. Proxies in front of a server often cap how big one request may be (Cloudflare's
// tunnels and proxy: 100 MB), so the apps send a big file as several smaller requests:
//
//   POST   /api/uploads            {name, type, size}  → {id, chunkBytes}
//   PUT    /api/uploads/:id?offset=N   (application/octet-stream, the next piece)  → {received, size}
//   GET    /api/uploads/:id        → {received, size}   (to carry on after a dropped connection)
//   DELETE /api/uploads/:id        → stops it and throws the pieces away
//
// Once every byte has arrived, the request that would have carried the file names the upload instead
// (`?upload=<id>`) and gets it from takeUpload(). Pieces are kept with the stored files (same disk, so
// the finished file is moved into place rather than copied) and deleted after a day without activity.

/** The size of each piece the apps send: well under the 100 MB that proxies commonly allow, and small
 *  enough to arrive within their time limit (Cloudflare: 100 seconds) on a slow home connection. */
/** The settings for sending in pieces (admin panel → Limits), with the piece size kept in range. */
export async function chunkSettings() {
  const { uploads } = await getSettings();
  const mb = Math.max(CHUNK_MB_MIN, Math.round(Number(uploads?.chunkMb) || 16));
  return { chunked: !!uploads?.chunked, chunkMb: mb, chunkBytes: mb * 1024 * 1024 };
}
const IDLE_MS = 24 * 60 * 60 * 1000;
const partialDir = path.join(config.uploadDir, '.partial');
mkdirSync(partialDir, { recursive: true });

interface Upload {
  userId: string;
  name: string;
  type: string;
  size: number;
  received: number;
  file: string;
  touched: number;
  /** A piece is being written: another one for the same upload waits its turn. */
  busy: boolean;
  /** The piece size when it started (the setting may change meanwhile): bigger requests are refused. */
  pieceBytes: number;
}
const uploads = new Map<string, Upload>();

/** The largest file anything on this server accepts (each route then applies its own limit). */
const largest = () => Math.max(config.maxUploadBytes, config.maxImportBytes);

/** What a route gets from a finished upload. The caller owns `file` from then on (move or delete it). */
export interface TakenUpload {
  file: string;
  filename: string;
  mimetype: string;
  size: number;
}

/** The finished upload `id` started by `userId`, handed over once (later calls find nothing). */
export function takeUpload(id: string, userId: string): TakenUpload {
  const up = uploads.get(id);
  if (!up || up.userId !== userId) throw new HttpError(404, 'That upload has expired — please try again');
  if (up.busy || up.received !== up.size) throw new HttpError(409, 'That upload has not finished yet');
  uploads.delete(id);
  return { file: up.file, filename: up.name, mimetype: up.type, size: up.size };
}

/** The `?upload=` a request names, if any. */
export function uploadIdOf(req: FastifyRequest): string | null {
  const id = (req.query as { upload?: unknown } | undefined)?.upload;
  if (id === undefined) return null;
  return parse(z.object({ upload: z.uuid() }), { upload: id }).upload;
}

/** A finished upload's contents in memory, for routes that work on the whole file at once. */
export async function readUpload(id: string, userId: string, maxBytes: number): Promise<Buffer> {
  const up = takeUpload(id, userId);
  try {
    if (up.size > maxBytes) throw new HttpError(413, `Files must be smaller than ${Math.round(maxBytes / 1024 / 1024)} MB`);
    return await readFile(up.file);
  } finally {
    await unlink(up.file).catch(() => {});
  }
}

/**
 * The file a route was sent: either the usual multipart field, or a finished upload named with
 * `?upload=`. Either way it's written to `target`. Returns its name, type and size; throws 413 (and
 * leaves nothing behind) when it's bigger than `maxBytes`.
 */
export async function receiveFile(req: FastifyRequest, target: string, maxBytes: number): Promise<{ filename: string; mimetype: string; size: number }> {
  const id = uploadIdOf(req);
  const tooBig = () => new HttpError(413, `Files must be smaller than ${Math.round(maxBytes / 1024 / 1024)} MB`);
  if (id) {
    const up = takeUpload(id, req.user.id);
    if (up.size > maxBytes) {
      await unlink(up.file).catch(() => {});
      throw tooBig();
    }
    await rename(up.file, target).catch(async () => {
      // A target on another disk (e.g. the system's temporary folder): copy, then remove.
      await pipeline(createReadStream(up.file), createWriteStream(target));
      await unlink(up.file).catch(() => {});
    });
    return { filename: up.filename, mimetype: up.mimetype, size: up.size };
  }
  const file = await req.file({ limits: { fileSize: maxBytes } });
  if (!file) throw new HttpError(400, 'No file uploaded');
  let size = 0;
  (file.file as Readable).on('data', (chunk: Buffer) => (size += chunk.length));
  await pipeline(file.file, createWriteStream(target));
  if (file.file.truncated) {
    await unlink(target).catch(() => {});
    throw tooBig();
  }
  return { filename: file.filename, mimetype: file.mimetype, size };
}

async function drop(id: string) {
  const up = uploads.get(id);
  uploads.delete(id);
  if (up) await unlink(up.file).catch(() => {});
}

// Pieces of uploads nobody finished, and ones left over from before a restart.
function sweep() {
  const now = Date.now();
  for (const [id, up] of uploads) if (!up.busy && now - up.touched > IDLE_MS) void drop(id);
  for (const name of readdirSync(partialDir)) {
    if (uploads.has(name)) continue;
    const file = path.join(partialDir, name);
    try {
      if (now - statSync(file).mtimeMs > IDLE_MS) void unlink(file).catch(() => {});
    } catch {
      // Already gone.
    }
  }
}
sweep();
setInterval(sweep, 60 * 60 * 1000).unref();

const startBody = z.object({
  name: z.string().trim().min(1).max(255),
  type: z.string().max(200).default('application/octet-stream'),
  size: z.number().int().min(1),
  /** What the file is for, so a file that won't be accepted is refused before any of it is sent:
   * "file" (a new attachment: the person's upload limit and storage apply), "content" (new contents for
   * a stored file, or a file to convert: the upload limit applies) or "import" (a workspace export, which
   * may be bigger). Left out by older clients: only the overall cap applies. */
  kind: z.enum(['file', 'content', 'import']).optional(),
});
const idParam = z.object({ id: z.uuid() });

export async function uploadRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireUser);

  app.post('/uploads', async (req, reply) => {
    const body = parse(startBody, req.body);
    const pieces = await chunkSettings();
    if (!pieces.chunked) throw new HttpError(403, 'Sending files in pieces is turned off on this server (admin panel → Limits)');
    const cap = body.kind === 'file' || body.kind === 'content' ? await uploadLimitBytes(req.user.id) : body.kind === 'import' ? config.maxImportBytes : largest();
    if (body.size > cap) throw new HttpError(413, `Files must be smaller than ${Math.round(cap / 1024 / 1024)} MB`);
    if (body.kind === 'file') await checkStorage(req.user.id, body.size);
    // A handful at once per person is plenty (one per file being sent).
    const mine = [...uploads.values()].filter((u) => u.userId === req.user.id).length;
    if (mine >= 20) throw new HttpError(429, 'Too many uploads at once — wait for some to finish');
    const id = randomUUID();
    const file = path.join(partialDir, id);
    await (await open(file, 'w')).close();
    uploads.set(id, { userId: req.user.id, name: body.name, type: body.type || 'application/octet-stream', size: body.size, received: 0, file, touched: Date.now(), busy: false, pieceBytes: pieces.chunkBytes });
    return reply.code(201).send({ id, chunkBytes: pieces.chunkBytes });
  });

  const mine = (id: string, userId: string) => {
    const up = uploads.get(id);
    if (!up || up.userId !== userId) throw new HttpError(404, 'That upload has expired — please try again');
    return up;
  };

  app.get('/uploads/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const up = mine(id, req.user.id);
    return { received: up.received, size: up.size };
  });

  // A piece, written at `offset` (which must be where the last one ended). Room for a piece plus slack.
  // Pieces are as big as the admin chose, so the body limit is the largest file the server takes; a request
  // bigger than its upload's piece size is refused from its headers, before the body is read.
  const pieceSlack = 1024 * 1024;
  const tooBigPiece = async (req: FastifyRequest) => {
    const up = uploads.get(String((req.params as { id?: string }).id ?? ''));
    const length = Number(req.headers['content-length'] ?? 0);
    if (up && length > up.pieceBytes + pieceSlack) throw new HttpError(413, 'That piece is bigger than the piece size of this upload');
  };
  app.put('/uploads/:id', { bodyLimit: largest() + pieceSlack, onRequest: tooBigPiece }, async (req) => {
    const { id } = parse(idParam, req.params);
    const { offset } = parse(z.object({ offset: z.coerce.number().int().min(0) }), req.query);
    const up = mine(id, req.user.id);
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) throw new HttpError(400, 'Send the piece as application/octet-stream');
    if (up.busy) throw new HttpError(409, 'Another piece of this upload is still being written');
    // A piece sent again after a dropped reply (the server already has it) is just acknowledged.
    if (offset + req.body.length <= up.received) return { received: up.received, size: up.size };
    if (offset !== up.received) throw new HttpError(409, `Expected the piece at ${up.received}`);
    if (offset + req.body.length > up.size) throw new HttpError(400, 'That is more than the size given when the upload started');
    up.busy = true;
    try {
      await appendFile(up.file, req.body);
      up.received += req.body.length;
    } catch (err) {
      // Put the file back to what was there before this piece, so it can be sent again.
      await truncate(up.file, up.received).catch(() => {});
      throw err;
    } finally {
      up.busy = false;
      up.touched = Date.now();
    }
    return { received: up.received, size: up.size };
  });

  app.delete('/uploads/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    mine(id, req.user.id);
    await drop(id);
    return { ok: true };
  });
}
