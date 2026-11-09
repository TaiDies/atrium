import { guideRows } from './apiGuide.js';

// GET /api/openapi.json: every route the server really has (collected as Fastify registers them), with
// the API guide's description where it has one. Routes only the app itself uses are listed in APP_ONLY;
// a route in neither shows up in "x-missing-from-guide", and the integration tests fail on it, so a new
// endpoint can't be added without deciding whether the guide should describe it.

export const registered: { method: string; url: string }[] = [];

export function recordRoute(route: { method: string | string[]; url: string }) {
  for (const m of Array.isArray(route.method) ? route.method : [route.method]) {
    if (m === 'HEAD' || m === 'OPTIONS') continue;
    if (!route.url.startsWith('/api/')) continue;
    registered.push({ method: m, url: route.url });
  }
}

/** "/api/pages/:id/rows" and "/api/pages/{databaseId}/rows?x=1" both become "/api/pages/{}/rows". */
export const shape = (path: string) =>
  path
    .split('?')[0]
    .replace(/\{[^}]+\}|:[A-Za-z_]+/g, '{}')
    .replace(/\/$/, '');

/**
 * Routes the app uses that aren't part of the documented API (they may change between versions). Each
 * entry is a path shape, optionally after a method ("DELETE /api/…"); a trailing "*" covers everything under it.
 */
export const APP_ONLY: string[] = [
  // Signing in, the account and its settings: the app's own screens (most are refused to API tokens).
  '/api/auth/*',
  '/api/invitations*',
  '/api/notifications*',
  'DELETE /api/workspaces/{}',
  'PATCH /api/workspaces/{}/members/{}',
  'DELETE /api/workspaces/{}/members/{}',
  // The AI assistant's chats and connection settings.
  '/api/ai/chats/*',
  '/api/ai/connection',
  '/api/ai/models',
  '/api/ai/status',
  '/api/workspaces/{}/ai/chats',
  // Chat and meeting details beyond the documented basics.
  '/api/chats/{}*',
  '/api/chat-messages/*',
  '/api/meetings/{}/*',
  'PATCH /api/meetings/{}',
  '/api/meeting-tasks/*',
  // Editor plumbing: live documents, previews, positions and sidebars.
  '/api/pages/{}/content',
  '/api/pages/{}/append',
  '/api/pages/{}/database',
  '/api/pages/{}/outline',
  '/api/pages/{}/own-content',
  '/api/pages/{}/own-events',
  '/api/pages/{}/rows/files',
  '/api/pages/{}/rows/previews',
  '/api/pages/{}/rows/tasks',
  '/api/pages/{}/rows/{}/content',
  '/api/pages/{}/rows/{}/copy',
  '/api/pages/{}/rows/{}/repeat',
  '/api/pages/{}/stats',
  '/api/pages/{}/study-sources',
  '/api/pages/{}/template',
  '/api/pages/{}/graph-group',
  '/api/workspaces/{}/graph/style',
  '/api/workspaces/{}/sidebar-order',
  '/api/workspaces/{}/synced-blocks',
  '/api/workspaces/{}/online',
  '/api/link-preview',
  // Files: viewers, office editing, conversions, notes and video editing.
  '/api/files/{}/*',
  '/api/file-positions',
  '/api/office/status',
  '/api/workspaces/{}/office',
  '/api/workspaces/{}/convert',
  '/api/workspaces/{}/notes',
  '/api/workspaces/{}/files/unused*',
  '/api/whiteboards/{}/place',
  '/api/whiteboards/{}/preview',
  // Calendar internals: the .ics feed itself (its address is from GET …/calendar/feed), placing and paths.
  '/api/calendar/feed/{}',
  '/api/workspaces/{}/calendar/feed/reset',
  '/api/workspaces/{}/events/unplaced',
  '/api/events/{}/paths*',
  '/api/events/{}/place',
  // Published pages and public forms, read by visitors without signing in.
  '/api/public/*',
];

const appOnly = (method: string, s: string) =>
  APP_ONLY.some((entry) => {
    const [m, p] = entry.includes(' ') ? entry.split(' ') : [null, entry];
    if (m && m !== method) return false;
    return p.endsWith('*') ? s.startsWith(p.slice(0, -1)) : s === p;
  });

export function openapi(version: string, appName: string) {
  const docs = new Map<string, { what: string; who: string }>();
  for (const r of guideRows()) for (const m of r.methods) docs.set(`${m} ${shape(r.path)}`, { what: r.what, who: r.who });
  const paths: Record<string, Record<string, unknown>> = {};
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const { method, url } of registered) {
    const key = `${method} ${shape(url)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const doc = docs.get(key);
    const internal = !doc && appOnly(method, shape(url));
    if (!doc && !internal) missing.push(key);
    const openPath = url.replace(/:([A-Za-z_]+)/g, '{$1}');
    const params = [...url.matchAll(/:([A-Za-z_]+)/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
    (paths[openPath] ??= {})[method.toLowerCase()] = {
      ...(doc ? { summary: doc.what, description: `Who: ${doc.who}` } : { summary: internal ? 'Used by the app itself; not part of the documented API.' : 'Not described yet.' }),
      ...(internal ? { 'x-internal': true } : {}),
      ...(params.length ? { parameters: params } : {}),
      responses: { default: { description: 'JSON. Errors: {"error": "message"} with a 4xx/5xx status.' } },
    };
  }
  return {
    openapi: '3.1.0',
    info: { title: `${appName} API`, version, description: 'Generated from the server\'s routes. The guide with examples is at /api/docs.' },
    components: { securitySchemes: { token: { type: 'http', scheme: 'bearer', description: 'A personal API token (atr_…) from Settings → API & webhooks.' } } },
    security: [{ token: [] }],
    paths,
    'x-missing-from-guide': missing.sort(),
    'x-guide-without-route': [...docs.keys()].filter((k) => !seen.has(k)).sort(),
  };
}
