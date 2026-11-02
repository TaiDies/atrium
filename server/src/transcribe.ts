import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Connection } from './ai.js';
import { config } from './config.js';
import { HttpError } from './util.js';

// Turning recorded speech (an audio or video attachment) into text, through the person's AI connection:
// OpenAI-compatible services use their speech-to-text endpoint, Gemini listens to the file itself.
// Claude doesn't take audio.

/** Largest recording sent: OpenAI's endpoint takes 25 MB; Gemini takes 20 MB inline. */
const MAX_BYTES = { openai: 25 * 1024 * 1024, gemini: 20 * 1024 * 1024 };

const trimSlash = (url: string) => url.replace(/\/+$/, '');

/** The speech-to-text model for an OpenAI-compatible address (AI_TRANSCRIBE_MODEL overrides it). */
function speechModel(baseUrl: string) {
  if (process.env.AI_TRANSCRIBE_MODEL) return process.env.AI_TRANSCRIBE_MODEL;
  if (/groq\.com/i.test(baseUrl)) return 'whisper-large-v3-turbo';
  return 'whisper-1';
}

export async function transcribeFile(c: Connection, file: { id: string; filename: string; mime_type: string; size: string }): Promise<string> {
  if (c.provider === 'anthropic') {
    throw new HttpError(400, 'Claude can’t listen to audio. To transcribe, connect OpenAI, Groq (OpenAI-compatible) or Google Gemini in AI → Settings.');
  }
  const limit = MAX_BYTES[c.provider];
  if (Number(file.size) > limit) throw new HttpError(400, `That recording is too long to transcribe at once (up to ${Math.round(limit / 1024 / 1024)} MB)`);
  const data = await readFile(path.join(config.uploadDir, file.id));
  const mime = file.mime_type || 'audio/mpeg';

  if (c.provider === 'gemini') {
    const base = trimSlash(c.baseUrl || 'https://generativelanguage.googleapis.com/v1beta');
    const res = await fetch(`${base}/models/${encodeURIComponent(c.model)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(c.key ? { 'x-goog-api-key': c.key } : {}) },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              { inline_data: { mime_type: mime, data: data.toString('base64') } },
              { text: 'Transcribe this recording word for word, in its own language. Start a new paragraph when the speaker or topic changes. Reply with only the transcript.' },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(10 * 60_000),
    });
    const json = (await res.json().catch(() => null)) as { candidates?: { content?: { parts?: { text?: string }[] } }[]; error?: { message?: string } } | null;
    if (!res.ok) throw new HttpError(res.status === 401 || res.status === 403 ? 400 : 502, `Google couldn't transcribe it${json?.error?.message ? `: ${json.error.message}` : ''}`);
    const text = json?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    if (!text.trim()) throw new HttpError(502, 'Google sent back no words');
    return text.trim();
  }

  const base = trimSlash(c.baseUrl || 'https://api.openai.com/v1');
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(data)], { type: mime }), file.filename || 'recording');
  form.append('model', speechModel(base));
  form.append('response_format', 'json');
  const res = await fetch(`${base}/audio/transcriptions`, {
    method: 'POST',
    headers: c.key ? { Authorization: `Bearer ${c.key}` } : {},
    body: form,
    signal: AbortSignal.timeout(10 * 60_000),
  });
  const json = (await res.json().catch(() => null)) as { text?: string; error?: { message?: string } } | null;
  if (res.status === 404) throw new HttpError(400, 'This AI service has no speech-to-text. Use OpenAI, Groq or Gemini to transcribe.');
  if (!res.ok) throw new HttpError(res.status === 401 || res.status === 403 ? 400 : 502, `The AI service couldn't transcribe it${json?.error?.message ? `: ${json.error.message}` : ''}`);
  if (!json?.text?.trim()) throw new HttpError(502, 'The AI service sent back no words');
  return json.text.trim();
}
