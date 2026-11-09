import type { FastifyReply, FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  return schema.parse(data);
}

export const idParams = z.object({ id: z.uuid() });

export const email = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ message: 'Enter a valid email address' }));

export function escapeLike(s: string) {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

const COLORS = ['#e8590c', '#d6336c', '#ae3ec9', '#7048e8', '#4263eb', '#1c7ed6', '#1098ad', '#0ca678', '#37b24d', '#f59f00'];

export function colorFor(seed: string) {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

/** Turns errors into JSON replies: expected ones with their message, anything else as a logged 500. */
export function handleError(err: any, req: FastifyRequest, reply: FastifyReply) {
  if (err instanceof ZodError) {
    // Zod's own wording ("Invalid input: expected string…") doesn't say which field: name it.
    const issue = err.issues[0];
    const where = issue?.path?.length ? issue.path.join('.') : '';
    const generic = /^(Invalid|Expected|Too (big|small)|Unrecognized|Required)/.test(issue?.message ?? '');
    return reply.code(400).send({ error: issue ? (where && generic ? `${where}: ${issue.message}` : issue.message) : 'Invalid request', ...(where ? { field: where } : {}) });
  }
  if (err instanceof HttpError) {
    return reply.code(err.status).send({ error: err.message });
  }
  if (err?.code === '22P02') return reply.code(400).send({ error: 'Invalid identifier' });
  if (typeof err?.statusCode === 'number' && err.statusCode < 500) {
    return reply.code(err.statusCode).send({ error: err.message });
  }
  req.log.error(err);
  return reply.code(500).send({ error: 'Something went wrong' });
}
