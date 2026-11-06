import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, rename, stat, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireMember } from '../access.js';
import { requireUser } from '../auth.js';
import { config } from '../config.js';
import { one, query } from '../db.js';
import { queueFileText } from '../fileText.js';
import { checkStorage } from '../limits.js';
import { HttpError, idParams, parse } from '../util.js';
import { emit } from '../webhooks.js';

// Quick video edits for the file viewer: trim to a part, take the sound out, turn it. ffmpeg does
// the work on the server, so it's the same on a phone as on a computer. The result replaces the
// file, or is saved as a copy next to it in Files.

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
/** At most this many edits run at once; the rest wait their turn. */
const MAX_RUNNING = 2;
let running = 0;
const waiting: (() => void)[] = [];

async function turn() {
  if (running >= MAX_RUNNING) await new Promise<void>((resolve) => waiting.push(resolve));
  running++;
}
function done() {
  running--;
  waiting.shift()?.();
}

function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-2000)));
    // A long video on a slow server: give up after 15 minutes rather than hang.
    const timer = setTimeout(() => child.kill('SIGKILL'), 15 * 60_000);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new HttpError(503, (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'Video editing needs ffmpeg on the server' : e.message));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new HttpError(422, `This video couldn't be edited${err ? `: ${err.trim().split('\n').pop()}` : ''}`));
    });
  });
}

/** Moves the result into place (copying when the temp folder is on another drive). */
const moveInto = (from: string, to: string) => rename(from, to).catch(() => copyFile(from, to));

const editBody = z.object({
  /** Keep from here to `end` (seconds); null keeps the whole length. */
  start: z.number().min(0).max(1e6).default(0),
  end: z.number().min(0).max(1e6).nullable().default(null),
  mute: z.boolean().default(false),
  /** Loudness in percent (100 = as it is, up to 300). */
  volume: z.number().min(0).max(300).default(100),
  /** Turn clockwise by this much. */
  rotate: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).default(0),
  flip: z.boolean().default(false),
  /** Save as a new file instead of replacing this one. */
  asCopy: z.boolean().default(false),
});

export async function mediaRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireUser);

  app.post('/files/:id/video-edit', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const body = parse(editBody, req.body);
    const file = await one<{ workspace_id: string; filename: string; mime_type: string; size: string; uploaded_by: string | null }>(
      'select workspace_id, filename, mime_type, size, uploaded_by from files where id = $1',
      [id],
    );
    if (!file) throw new HttpError(404, 'File not found');
    await requireMember(req.user.id, file.workspace_id);
    if (body.end !== null && body.end <= body.start + 0.1) throw new HttpError(400, 'The end must come after the start');

    const filters: string[] = [];
    if (body.rotate === 90) filters.push('transpose=1');
    else if (body.rotate === 270) filters.push('transpose=2');
    else if (body.rotate === 180) filters.push('hflip,vflip');
    if (body.flip) filters.push('hflip');
    // Even sizes, which the H.264 encoder needs.
    filters.push('scale=trunc(iw/2)*2:trunc(ih/2)*2');

    const out = path.join(os.tmpdir(), `atrium-edit-${randomUUID()}.mp4`);
    const args = ['-i', path.join(config.uploadDir, id)];
    // Seeking after the input is exact to the frame (and still quick for short clips).
    if (body.start > 0) args.push('-ss', String(body.start));
    if (body.end !== null) args.push('-to', String(body.end));
    args.push('-vf', filters.join(','), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p');
    if (body.mute || body.volume === 0) args.push('-an');
    else {
      if (body.volume !== 100) args.push('-af', `volume=${(body.volume / 100).toFixed(2)}`);
      args.push('-c:a', 'aac', '-b:a', '160k');
    }
    args.push('-movflags', '+faststart', out);

    await turn();
    try {
      await ffmpeg(args);
    } finally {
      done();
    }

    try {
      const size = (await stat(out)).size;
      const base = file.filename.replace(/\.[^.]+$/, '');
      if (body.asCopy) {
        await checkStorage(req.user.id, size);
        const copyId = randomUUID();
        await moveInto(out, path.join(config.uploadDir, copyId));
        const name = `${base} (edited).mp4`;
        await query('insert into files (id, workspace_id, uploaded_by, filename, mime_type, size) values ($1, $2, $3, $4, $5, $6)', [
          copyId,
          file.workspace_id,
          req.user.id,
          name,
          'video/mp4',
          size,
        ]);
        queueFileText(copyId);
        emit(file.workspace_id, 'file.uploaded', { id: copyId, url: `/api/files/${copyId}` });
        return reply.code(201).send({ id: copyId, url: `/api/files/${copyId}`, name, size });
      }
      if (file.uploaded_by) await checkStorage(file.uploaded_by, size, Number(file.size));
      const target = path.join(config.uploadDir, id);
      await moveInto(out, target);
      const name = `${base}.mp4`;
      await query('update files set filename = $2, mime_type = $3, size = $4, updated_at = now() where id = $1', [id, name, 'video/mp4', size]);
      // Where people stopped in it no longer matches the new video.
      await query('delete from file_positions where file_id = $1', [id]);
      queueFileText(id);
      return { id, url: `/api/files/${id}`, name, size };
    } finally {
      await unlink(out).catch(() => {});
    }
  });
}
