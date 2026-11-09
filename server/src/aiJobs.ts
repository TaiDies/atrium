import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { HttpError } from './util.js';

// AI work that can take longer than a reverse proxy keeps a request open (Cloudflare gives up after
// about 100 seconds). A request that sends "Prefer: respond-async" gets 202 and a job id straight
// away; the work carries on here and the app asks GET /api/ai/jobs/:id until it's done. Requests
// without the header (older apps) are answered directly, as before.

/** How long one AI call may take while a request waits for it (under the proxies' ~100 seconds). */
export const HELD_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS) || 90_000;

interface Job {
  userId: string;
  done: boolean;
  result?: unknown;
  error?: { status: number; message: string };
  finishedAt?: number;
}

const jobs = new Map<string, Job>();
const background = new AsyncLocalStorage<true>();
/** A finished job's answer is kept this long for the app to collect. */
const KEEP_MS = 10 * 60_000;
const MAX_RUNNING_PER_USER = 4;

/** Whether the current code runs as a background job (no request waiting on it). */
export const inBackground = () => background.getStore() === true;

/** How long an AI call may take here: `held` while a request waits, `long` in the background. */
export const aiTimeout = (long: number) => (inBackground() ? long : HELD_TIMEOUT_MS);

/** Runs `fn` as background work (for answers saved elsewhere, such as the assistant chat). */
export const runInBackground = <T>(fn: () => Promise<T>) => background.run(true, fn);

function sweep(now = Date.now()) {
  for (const [id, job] of jobs) if (job.finishedAt && now - job.finishedAt > KEEP_MS) jobs.delete(id);
}

function errorOf(err: unknown): { status: number; message: string } {
  if (err instanceof HttpError) return { status: err.status, message: err.message };
  if (err instanceof ZodError) return { status: 400, message: err.issues[0]?.message ?? 'Invalid request' };
  const e = err as { statusCode?: number; message?: string };
  if (typeof e?.statusCode === 'number' && e.statusCode < 500) return { status: e.statusCode, message: e.message ?? 'Request failed' };
  console.error('An AI job failed', err);
  return { status: 500, message: 'Something went wrong' };
}

/**
 * Wraps a route handler so it can run in the background when the app asks for that
 * ("Prefer: respond-async"); otherwise it answers as usual.
 */
export function asyncCapable<R extends FastifyRequest>(handler: (req: R) => Promise<unknown>) {
  return async (req: R, reply: FastifyReply) => {
    if (!/\brespond-async\b/i.test(String(req.headers.prefer ?? ''))) return handler(req);
    sweep();
    const userId = (req as { user?: { id: string } }).user?.id ?? '';
    let running = 0;
    for (const j of jobs.values()) if (j.userId === userId && !j.done) running++;
    if (running >= MAX_RUNNING_PER_USER) throw new HttpError(429, 'Several AI requests are already running. Wait for one to finish.');
    const id = randomUUID();
    const job: Job = { userId, done: false };
    jobs.set(id, job);
    void runInBackground(() => handler(req))
      .then(
        (result) => (job.result = result),
        (err) => (job.error = errorOf(err)),
      )
      .finally(() => {
        job.done = true;
        job.finishedAt = Date.now();
      });
    return reply.code(202).send({ job: id });
  };
}

/** A job's state, for its owner: not done yet, its answer, or its error (thrown with its status). */
export function jobState(id: string, userId: string): { done: false } | { done: true; result: unknown } {
  sweep();
  const job = jobs.get(id);
  if (!job || job.userId !== userId) throw new HttpError(404, 'That AI request is no longer available. Try again.');
  if (!job.done) return { done: false };
  if (job.error) throw new HttpError(job.error.status, job.error.message);
  return { done: true, result: job.result };
}
