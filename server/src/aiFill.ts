import * as Y from 'yjs';
import { aiAccess, complete } from './ai.js';
import { jobSignal } from './aiJobs.js';
import { editDoc, readDoc } from './blocks.js';
import { config } from './config.js';
import { fieldsOf, type FieldInfo } from './docIndex.js';
import { useAi } from './limits.js';
import { docToMarkdown } from './readable.js';
import { HttpError } from './util.js';

// "AI autofill" properties: each card's value is written by the AI from the property's prompt, the
// card's other properties and the text in the card's page.

/** Cards filled per request (each is one AI call). */
export const MAX_FILL = 25;

interface RowSnapshot {
  id: string;
  cells: Record<string, unknown>;
}

/** A cell as words, for the AI to read. */
function cellText(field: FieldInfo & { options?: { id: string; name: string }[] }, value: unknown): string {
  if (value === undefined || value === null || value === '') return '';
  const name = (id: unknown) => field.options?.find((o) => o.id === id)?.name ?? '';
  switch (field.type) {
    case 'select':
      return name(value);
    case 'multi_select':
      return Array.isArray(value) ? value.map(name).filter(Boolean).join(', ') : '';
    case 'checkbox':
      return value ? 'yes' : 'no';
    case 'checklist':
      return Array.isArray(value) ? value.map((c: { text?: string; done?: boolean }) => `${c.done ? '[x]' : '[ ]'} ${c.text ?? ''}`).join('; ') : '';
    case 'media':
      return Array.isArray(value) ? value.map((m: { name?: string }) => m.name ?? '').join(', ') : '';
    case 'person':
    case 'relation':
      return '';
    default:
      return typeof value === 'object' ? JSON.stringify(value) : String(value);
  }
}

/**
 * Fills the AI property `fieldId` for the given cards (all of them when `rowIds` is empty), skipping
 * ones that already have a value unless `overwrite`. Returns how many were filled.
 */
export async function fillAiField(userId: string, pageId: string, fieldId: string, rowIds: string[], overwrite: boolean): Promise<{ filled: number; remaining: number }> {
  const a = await aiAccess(userId);
  if (!a.active) throw new HttpError(400, 'Set up an AI connection first (AI → Settings)');
  const snapshot = await readDoc(pageId, null, (doc) => {
    const fields = fieldsOf(doc) as (FieldInfo & { prompt?: string; options?: { id: string; name: string }[] })[];
    const rows: RowSnapshot[] = doc
      .getArray<Y.Map<unknown>>('rows')
      .toArray()
      .filter((r) => r instanceof Y.Map)
      .map((r) => {
        const cells = r.get('cells');
        return { id: String(r.get('id')), cells: cells instanceof Y.Map ? (cells.toJSON() as Record<string, unknown>) : {} };
      });
    return { fields, rows };
  });
  const field = snapshot.fields.find((f) => f.id === fieldId);
  if (!field || field.type !== 'ai') throw new HttpError(404, 'AI property not found');
  const prompt = (field as { aiPrompt?: string }).aiPrompt?.trim();
  if (!prompt) throw new HttpError(400, 'Write what the AI should fill in first (in the property’s menu)');
  const wanted = snapshot.rows.filter((r) => (rowIds.length ? rowIds.includes(r.id) : true) && (overwrite || !String(r.cells[fieldId] ?? '').trim()));
  const batch = wanted.slice(0, MAX_FILL);
  const primary = snapshot.fields.find((f) => f.primary) ?? snapshot.fields[0];
  const others = snapshot.fields.filter((f) => f.id !== fieldId);

  const system = `You fill in one property of a card in a database in ${config.appName}. You are given the card's other properties and the text of its page.
Reply with ONLY the value for the property — no label, no quotes, no explanation. Keep it short (a word, a phrase or a sentence or two) unless the instruction asks for more. If the card doesn't have enough information, give your best short guess, or reply "—".`;
  const values = new Map<string, string>();
  const cancelled = jobSignal();
  for (const row of batch) {
    if (cancelled?.aborted) return { filled: 0, remaining: wanted.length }; // stopped: nothing is written
    await useAi(userId);
    const title = primary ? cellText(primary, row.cells[primary.id]) : '';
    const props = others
      .map((f) => [f.name, cellText(f, row.cells[f.id])] as const)
      .filter(([, v]) => v)
      .map(([k, v]) => `- ${k}: ${v}`)
      .join('\n');
    const body = await readDoc(pageId, row.id, (doc) =>
      docToMarkdown(doc, title, { pageLink: () => ({ title: 'a page', href: null }), fileLink: () => null, eventLabel: () => null, boardLabel: () => null }),
    ).catch(() => '');
    const content = `Property to fill: "${field.name}"\nInstruction: ${prompt}\n\n<card>\n${props || '(no other properties)'}\n</card>\n${body.trim().split('\n').length > 2 ? `\n<page>\n${body.slice(0, 12_000)}\n</page>` : ''}`;
    const answer = (await complete(a.active, system, [{ role: 'user', content }])).trim().replace(/^["“](.*)["”]$/s, '$1');
    values.set(row.id, answer.slice(0, 5000));
  }
  if (values.size && !cancelled?.aborted) {
    await editDoc(
      pageId,
      null,
      (doc) => {
        for (const r of doc.getArray<Y.Map<unknown>>('rows').toArray()) {
          if (!(r instanceof Y.Map)) continue;
          const v = values.get(String(r.get('id')));
          const cells = r.get('cells');
          if (v === undefined || !(cells instanceof Y.Map)) continue;
          cells.set(fieldId, v);
          r.set('updatedAt', Date.now());
        }
      },
      { editor: userId },
    );
  }
  return { filled: values.size, remaining: wanted.length - batch.length };
}
