import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { addAiTokens } from './limits.js';
import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { one } from './db.js';
import { getSettings } from './settings.js';
import { HttpError } from './util.js';
import { checkOutboundUrl, outboundFetch } from './netGuard.js';
import { aiTimeout } from './aiJobs.js';

// The AI assistant's connection to a model. People can bring their own key; the admin can also set one
// for everybody, and then decides whether people may still use their own. Keys are stored encrypted
// and never sent back to the browser.

export const PROVIDERS = ['anthropic', 'openai', 'gemini'] as const;
export type Provider = (typeof PROVIDERS)[number];

/** Suggested models; any model the provider offers can be typed in (or picked from its list). */
export const DEFAULT_MODELS: Record<Provider, string> = {
  anthropic: 'claude-opus-5-5',
  openai: 'gpt-5',
  gemini: 'gemini-2.5-pro',
};

export interface Connection {
  provider: Provider;
  model: string;
  baseUrl: string | null;
  key: string | null;
  source: 'own' | 'shared';
  /** Whose request this is: the tokens it uses are counted for them. */
  userId?: string;
}

/** An answer and the tokens it took (prompt and reply together). */
interface Answer {
  text: string;
  tokens: number;
}

// ---------- keys at rest ----------

const secretKey = () => createHash('sha256').update(`${config.sessionSecret}:ai-keys`).digest();

export function encryptKey(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secretKey(), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}

export function decryptKey(stored: string | null): string | null {
  if (!stored) return null;
  try {
    const raw = Buffer.from(stored, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', secretKey(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    return null; // the server's secret changed; the key has to be entered again
  }
}

/** "sk-…abcd": enough to recognise a key without revealing it. */
export const maskKey = (key: string | null) => (key ? `${key.slice(0, 3)}…${key.slice(-4)}` : null);

// ---------- which connection a person uses ----------

export interface AiAccess {
  /** The server offers a connection to everyone. */
  shared: { provider: Provider; model: string } | null;
  /** Whether this person may use their own key (always, when the server offers none). */
  canUseOwn: boolean;
  own: { provider: Provider; model: string; baseUrl: string | null; keyHint: string | null; useOwn: boolean } | null;
  /** The connection their requests go through, if any. */
  active: Connection | null;
}

export async function aiAccess(userId: string): Promise<AiAccess> {
  const settings = await getSettings();
  const s = settings.ai;
  const shared: Connection | null =
    s && PROVIDERS.includes(s.provider as Provider)
      ? { provider: s.provider as Provider, model: s.model, baseUrl: s.baseUrl, key: decryptKey(s.keyEnc), source: 'shared' }
      : null;
  const canUseOwn = !shared || s!.allowOwn;
  const row = await one<{ provider: string; model: string; base_url: string | null; key_enc: string | null; use_own: boolean }>(
    'select provider, model, base_url, key_enc, use_own from ai_connections where user_id = $1',
    [userId],
  );
  const ownKey = row ? decryptKey(row.key_enc) : null;
  const own =
    row && PROVIDERS.includes(row.provider as Provider)
      ? { provider: row.provider as Provider, model: row.model, baseUrl: row.base_url, keyHint: maskKey(ownKey), useOwn: row.use_own }
      : null;
  let active: Connection | null = null;
  if (own && canUseOwn && (own.useOwn || !shared)) active = { provider: own.provider, model: own.model, baseUrl: own.baseUrl, key: ownKey, source: 'own' };
  else if (shared) active = { ...shared };
  if (active) active.userId = userId;
  return { shared: shared && { provider: shared.provider, model: shared.model }, canUseOwn, own, active };
}

// ---------- talking to the model ----------

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** Models that accept Anthropic's server-side fallback (a declined request is retried on another model). */
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

/** How long one AI answer may take in the background; while a request waits for it, see aiJobs.ts. */
const LONG_TIMEOUT_MS = 5 * 60_000;

// Problems on the AI service's side answer 424 (Failed Dependency), never 502/503/504: reverse
// proxies such as Cloudflare replace those with their own page, and the app reads that as the
// server being down.
export const UPSTREAM = 424;

function whoIs(provider: string) {
  return provider === 'anthropic' ? 'Anthropic' : provider === 'gemini' ? 'Google' : 'The AI service';
}

/** Said when the AI service didn't answer in time. */
export function tookTooLong(who = 'The AI service'): HttpError {
  return new HttpError(UPSTREAM, `${who} took too long to answer. Try again, or ask for something shorter.`);
}

const isTimeout = (err: unknown) => (err as { name?: string })?.name === 'TimeoutError' || (err as { name?: string })?.name === 'AbortError';

function trimSlash(url: string) {
  return url.replace(/\/+$/, '');
}

/** A clear message for a failed request, by status code. */
function failure(provider: string, status: number, detail: string): HttpError {
  const who = whoIs(provider);
  if (status === 401 || status === 403) return new HttpError(400, `${who} didn't accept the API key${detail ? `: ${detail}` : ''}`);
  if (status === 404) return new HttpError(400, `${who} doesn't know that model${detail ? `: ${detail}` : ''}. Check the model name in the AI settings.`);
  if (status === 429) return new HttpError(429, `${who} is rate-limiting this key or it's out of credit${detail ? `: ${detail}` : ''}`);
  if (status >= 500) return new HttpError(UPSTREAM, `${who} had a problem answering. Try again in a moment.`);
  return new HttpError(400, `${who} refused the request${detail ? `: ${detail}` : ''}`);
}

async function anthropic(c: Connection, system: string, turns: ChatTurn[]): Promise<Answer> {
  const limit = aiTimeout(LONG_TIMEOUT_MS);
  const client = new Anthropic({ apiKey: c.key ?? undefined, baseURL: c.baseUrl || undefined, timeout: limit, maxRetries: 2 });
  const fallback = FALLBACK_MODELS.has(c.model);
  try {
    // Streamed so long plans don't hit the HTTP timeout; only the finished message is used.
    const stream = client.beta.messages.stream({
      model: c.model,
      max_tokens: 16000,
      system,
      messages: turns,
      ...(fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
    }, { signal: AbortSignal.timeout(limit) }); // retries included
    const message = await stream.finalMessage();
    if (message.stop_reason === 'refusal') throw new HttpError(400, 'The model declined this request. Try rephrasing it.');
    const text = message.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('');
    if (message.stop_reason === 'max_tokens') throw new HttpError(400, 'The answer was too long and got cut off. Ask for a shorter plan, or split it up.');
    const u = message.usage as { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null };
    return { text, tokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) };
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (err instanceof Anthropic.APIConnectionTimeoutError || err instanceof Anthropic.APIUserAbortError || isTimeout(err)) throw tookTooLong('Anthropic');
    if (err instanceof Anthropic.APIConnectionError) throw new HttpError(UPSTREAM, "Couldn't reach Anthropic. Check the server's internet connection.");
    if (err instanceof Anthropic.APIError) throw failure('anthropic', err.status ?? 500, (err.error as { error?: { message?: string } })?.error?.message ?? '');
    throw err;
  }
}

async function postJson(url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal) {
  let res: Response;
  let data: Record<string, any> | null;
  try {
    res = await outboundFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal, redirect: 'error' }, { private: 'allow', what: 'AI service address' });
    data = (await res.json().catch((err) => (isTimeout(err) ? Promise.reject(err) : null))) as Record<string, any> | null;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (isTimeout(err) || signal.aborted) throw tookTooLong();
    throw new HttpError(UPSTREAM, `Couldn't reach ${new URL(url).host}. Check the address and the server's internet connection.`);
  }
  return { status: res.status, ok: res.ok, data };
}

async function openai(c: Connection, system: string, turns: ChatTurn[], json: boolean): Promise<Answer> {
  const base = trimSlash(c.baseUrl || 'https://api.openai.com/v1');
  const headers: Record<string, string> = c.key ? { Authorization: `Bearer ${c.key}` } : {};
  const body = { model: c.model, messages: [{ role: 'system', content: system }, ...turns] };
  // One deadline for the whole answer, the retry without JSON mode included.
  const signal = AbortSignal.timeout(aiTimeout(LONG_TIMEOUT_MS));
  let r = await postJson(`${base}/chat/completions`, headers, json ? { ...body, response_format: { type: 'json_object' } } : body, signal);
  // Some compatible servers don't support JSON mode; the prompt asks for JSON anyway.
  if (!r.ok && r.status === 400 && json) r = await postJson(`${base}/chat/completions`, headers, body, signal);
  if (!r.ok) throw failure('openai', r.status, r.data?.error?.message ?? '');
  const text = r.data?.choices?.[0]?.message?.content;
  if (typeof text !== 'string') throw new HttpError(UPSTREAM, 'The AI service sent an empty answer. Try again.');
  const u = r.data?.usage ?? {};
  return { text, tokens: Number(u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0)) || 0 };
}

async function gemini(c: Connection, system: string, turns: ChatTurn[], json: boolean): Promise<Answer> {
  const base = trimSlash(c.baseUrl || 'https://generativelanguage.googleapis.com/v1beta');
  const r = await postJson(`${base}/models/${encodeURIComponent(c.model)}:generateContent`, c.key ? { 'x-goog-api-key': c.key } : {}, {
    systemInstruction: { parts: [{ text: system }] },
    contents: turns.map((t) => ({ role: t.role === 'assistant' ? 'model' : 'user', parts: [{ text: t.content }] })),
    ...(json ? { generationConfig: { responseMimeType: 'application/json' } } : {}),
  }, AbortSignal.timeout(aiTimeout(LONG_TIMEOUT_MS)));
  if (!r.ok) throw failure('gemini', r.status, r.data?.error?.message ?? '');
  const candidate = r.data?.candidates?.[0];
  if (candidate?.finishReason === 'SAFETY') throw new HttpError(400, 'The model declined this request. Try rephrasing it.');
  const text = candidate?.content?.parts?.map((p: { text?: string }) => p.text ?? '').join('');
  if (!text) throw new HttpError(UPSTREAM, 'Google sent an empty answer. Try again.');
  const u = r.data?.usageMetadata ?? {};
  return { text, tokens: Number(u.totalTokenCount ?? (u.promptTokenCount ?? 0) + (u.candidatesTokenCount ?? 0)) || 0 };
}

/** Sends a conversation to the model and returns its text answer. */
/** A custom AI address is checked before anything is sent to it (see netGuard.ts). */
export async function checkBaseUrl(baseUrl: string | null | undefined) {
  if (baseUrl) await checkOutboundUrl(baseUrl, { private: 'allow', what: 'AI service address' });
}

export async function complete(c: Connection, system: string, turns: ChatTurn[], opts: { json?: boolean } = {}): Promise<string> {
  await checkBaseUrl(c.baseUrl);
  if (!c.key && c.provider !== 'openai') throw new HttpError(400, 'The AI connection has no API key');
  const answer = c.provider === 'anthropic' ? await anthropic(c, system, turns) : c.provider === 'gemini' ? await gemini(c, system, turns, !!opts.json) : await openai(c, system, turns, !!opts.json);
  // The tokens count towards the person's AI limits.
  if (c.userId && answer.tokens > 0) await addAiTokens(c.userId, answer.tokens).catch(() => {});
  return answer.text;
}

/** The models a key can use, for picking one in the settings. */
export async function listModels(c: Omit<Connection, 'source'>): Promise<string[]> {
  await checkBaseUrl(c.baseUrl);
  if (c.provider === 'anthropic') {
    const client = new Anthropic({ apiKey: c.key ?? undefined, baseURL: c.baseUrl || undefined, timeout: 20_000 });
    try {
      const ids: string[] = [];
      for await (const m of client.models.list()) ids.push(m.id);
      return ids;
    } catch (err) {
      if (err instanceof Anthropic.APIConnectionTimeoutError) throw tookTooLong('Anthropic');
      if (err instanceof Anthropic.APIConnectionError) throw new HttpError(UPSTREAM, "Couldn't reach Anthropic");
      if (err instanceof Anthropic.APIError) throw failure('anthropic', err.status ?? 500, '');
      throw err;
    }
  }
  const gemini = c.provider === 'gemini';
  const base = trimSlash(c.baseUrl || (gemini ? 'https://generativelanguage.googleapis.com/v1beta' : 'https://api.openai.com/v1'));
  let res: Response;
  try {
    res = await outboundFetch(`${base}/models`, {
      headers: gemini ? (c.key ? { 'x-goog-api-key': c.key } : {}) : c.key ? { Authorization: `Bearer ${c.key}` } : {},
      signal: AbortSignal.timeout(20_000),
      redirect: 'error',
    }, { private: 'allow', what: 'AI service address' });
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (isTimeout(err)) throw tookTooLong();
    throw new HttpError(UPSTREAM, `Couldn't reach ${new URL(base).host}`);
  }
  const data = (await res.json().catch(() => null)) as Record<string, any> | null;
  if (!res.ok) throw failure(c.provider, res.status, data?.error?.message ?? '');
  if (gemini) {
    return ((data?.models ?? []) as { name: string; supportedGenerationMethods?: string[] }[])
      .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
      .map((m) => m.name.replace(/^models\//, ''));
  }
  return ((data?.data ?? []) as { id: string }[]).map((m) => m.id).sort();
}
