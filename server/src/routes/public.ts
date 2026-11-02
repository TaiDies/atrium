import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { readPublicForm, submitPublicForm } from '../collab.js';
import { HttpError, parse } from '../util.js';

const params = z.object({ pageId: z.uuid(), viewId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) });

/** Endpoints that work without an account: published forms. */
export async function publicRoutes(app: FastifyInstance) {
  app.get('/public/forms/:pageId/:viewId', async (req) => {
    const { pageId, viewId } = parse(params, req.params);
    const form = await readPublicForm(pageId, viewId);
    if (!form) throw new HttpError(404, 'This form is not available');
    return { form };
  });

  app.post('/public/forms/:pageId/:viewId', { bodyLimit: 64 * 1024 }, async (req, reply) => {
    const { pageId, viewId } = parse(params, req.params);
    const body = parse(z.object({ values: z.record(z.string(), z.unknown()) }), req.body);
    const error = await submitPublicForm(pageId, viewId, body.values);
    if (error === 'not-found') throw new HttpError(404, 'This form is not available');
    if (error) throw new HttpError(400, error);
    return reply.code(201).send({ ok: true });
  });
}
