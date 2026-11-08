import { runRequest } from './scope.js';
import { existsSync } from 'node:fs';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { backfillFileText } from './fileText.js';
import { attachCollab, hocuspocus } from './collab.js';
import { config } from './config.js';
import { migrate, pool } from './db.js';
import { authRoutes } from './routes/auth.js';
import { fileRoutes } from './routes/files.js';
import { noteRoutes } from './routes/notes.js';
import { calendarRoutes } from './routes/calendar.js';
import { feedRoutes } from './routes/feeds.js';
import { flashcardRoutes } from './routes/flashcards.js';
import { apiRoutes } from './routes/api.js';
import { graphRoutes } from './routes/graph.js';
import { chatRoutes } from './routes/chat.js';
import { meetingRoutes } from './routes/meetings.js';
import { attachLive } from './live.js';
import { mcpRoutes } from './routes/mcp.js';
import { whiteboardRoutes } from './routes/whiteboards.js';
import { transferRoutes } from './routes/transfer.js';
import { officeRoutes } from './routes/office.js';
import { mediaRoutes } from './routes/media.js';
import { statsRoutes } from './routes/stats.js';
import { startScheduler } from './scheduler.js';
import { backfillDocIndex } from './docIndex.js';
import { pageRoutes } from './routes/pages.js';
import { publicRoutes } from './routes/public.js';
import { workspaceRoutes } from './routes/workspaces.js';
import { taskRoutes } from './routes/tasks.js';
import { notificationRoutes } from './routes/notifications.js';
import { templateRoutes } from './routes/templates.js';
import { extraRoutes } from './routes/extras.js';
import { historyRoutes } from './routes/history.js';
import { teamspaceRoutes } from './routes/teamspaces.js';
import { socialRoutes } from './routes/social.js';
import { publicPageRoutes, publishRoutes, shareIndexable } from './routes/publish.js';
import { aiRoutes } from './routes/ai.js';
import { databaseRoutes } from './routes/databases.js';
import { startAdminServer } from './admin.js';
import { handleError } from './util.js';

/** Bumped with each release; the apps show it and can warn about very old servers. */
import { SERVER_VERSION, startUpdateChecks } from './updates.js';

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  bodyLimit: 2 * 1024 * 1024,
  trustProxy: true,
});
// Each request runs in its own context, so an API token limited to one workspace holds for all of it.
app.addHook('onRequest', (_req, _reply, done) => runRequest(done));
// Headers that make the browser stricter with every reply: no guessing file types, no showing the app
// inside other sites' frames, links don't leak full addresses, and HTTPS sticks once it's in use.
app.addHook('onSend', async (_req, reply) => {
  if (!reply.hasHeader('X-Content-Type-Options')) reply.header('X-Content-Type-Options', 'nosniff');
  if (!reply.hasHeader('X-Frame-Options')) reply.header('X-Frame-Options', 'SAMEORIGIN');
  reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  reply.header('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self), geolocation=()');
  if (config.secureCookies) reply.header('Strict-Transport-Security', 'max-age=15552000');
});

await app.register(cookie);
await app.register(multipart, { limits: { fileSize: config.maxUploadBytes, files: 1 } });
app.decorateRequest('user', null as any);
app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 50 * 1024 * 1024 }, (_req, body, done) => done(null, body));

app.setErrorHandler(handleError);

app.get('/api/health', { logLevel: 'silent' }, async () => ({ status: 'ok' }));
// What the desktop and phone apps check when someone types in this server's address.
app.get('/api/server/info', async () => ({ app: 'atrium', name: config.appName, version: SERVER_VERSION, api: 1 }));
await app.register(
  async (api) => {
    await api.register(authRoutes);
    await api.register(workspaceRoutes);
    await api.register(pageRoutes);
    await api.register(fileRoutes);
    await api.register(noteRoutes);
    await api.register(calendarRoutes);
    await api.register(whiteboardRoutes);
    await api.register(transferRoutes);
    await api.register(officeRoutes);
    await api.register(mediaRoutes);
    await api.register(statsRoutes);
    await api.register(publicRoutes);
    await api.register(taskRoutes);
    await api.register(notificationRoutes);
    await api.register(aiRoutes);
    await api.register(databaseRoutes);
    await api.register(templateRoutes);
    await api.register(publishRoutes);
    await api.register(publicPageRoutes);
    await api.register(extraRoutes);
    await api.register(historyRoutes);
    await api.register(teamspaceRoutes);
    await api.register(socialRoutes);
    await api.register(feedRoutes);
    await api.register(flashcardRoutes);
    await api.register(apiRoutes);
    await api.register(graphRoutes);
    await api.register(chatRoutes);
    await api.register(meetingRoutes);
    await api.register(mcpRoutes);
  },
  { prefix: '/api' },
);

if (existsSync(config.webDir)) {
  await app.register(fastifyStatic, {
    root: config.webDir,
    wildcard: false,
    // The admin panel's page is only served on the admin port.
    allowedPath: (pathName) => !pathName.startsWith('/admin'),
    setHeaders(res, filePath) {
      const hashed = /[\\/]assets[\\/]/.test(filePath);
      res.header('Cache-Control', hashed ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  });
  app.setNotFoundHandler(async (req, reply) => {
    if (req.method !== 'GET' || req.url.startsWith('/api/')) {
      return reply.code(404).send({ error: 'Not found' });
    }
    // Published pages stay out of search engines unless their owner allows it; the app itself always does.
    if (!(await shareIndexable(req.url))) reply.header('X-Robots-Tag', 'noindex, nofollow');
    return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
  });
} else {
  app.log.warn(`Web app not found at ${config.webDir}; serving the API only`);
}

attachCollab(app.server);
attachLive(app.server);
await migrate();
// Record which pages use which files, events and whiteboards, and every dated card and block; runs in the background.
backfillDocIndex().catch((err) => app.log.error(err, 'Could not index documents'));
backfillFileText().catch((err) => app.log.error(err, 'Could not read file text'));
// Move repeating cards and events to their next date (checked every minute).
startScheduler();
startUpdateChecks();
await app.listen({ port: config.port, host: config.host });
const admin = config.admin.enabled ? await startAdminServer() : null;

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    app.log.info(`${signal} received, shutting down`);
    hocuspocus.flushPendingStores();
    await new Promise((r) => setTimeout(r, 500));
    await app.close();
    await admin?.close();
    await pool.end();
    process.exit(0);
  });
}
