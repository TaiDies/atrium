import { Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Spinner, toast, toastError } from '../components/ui';
import { useAiAvailable } from '../editor/AiSelection';
import { aiApi } from '../lib/api';
import { useDb } from './context';
import type { Field } from './model';

// "AI autofill" properties: the AI writes each card's value from the property's prompt.

async function fill(pageId: string, fieldId: string, rowIds: string[], overwrite: boolean) {
  return aiApi<{ filled: number; remaining: number }>(`/api/pages/${pageId}/fields/${fieldId}/ai-fill`, { method: 'POST', body: { rowIds, overwrite } });
}

/** In an empty cell: fill just this card. */
export function AiFillButton({ pageId, fieldId, rowId }: { pageId: string; fieldId: string; rowId: string }) {
  const ai = useAiAvailable();
  const [busy, setBusy] = useState(false);
  if (!ai) return null;
  return (
    <button
      onClick={async (e) => {
        e.stopPropagation();
        setBusy(true);
        try {
          await fill(pageId, fieldId, [rowId], true);
        } catch (err) {
          toastError(err);
        } finally {
          setBusy(false);
        }
      }}
      className="flex items-center gap-1 rounded px-1 text-xs text-faint hover:bg-hover hover:text-accent"
      title="Have the AI fill this in"
    >
      {busy ? <Spinner className="size-3" /> : <Sparkles size={12} />} Fill
    </button>
  );
}

/** The prompt, and filling every card, in the property's menu. */
export function AiFieldSettings({ field }: { field: Field }) {
  const { pageId, actions, locked } = useDb();
  const ai = useAiAvailable();
  const [prompt, setPrompt] = useState(field.aiPrompt ?? '');
  const [busy, setBusy] = useState<'empty' | 'all' | null>(null);
  useEffect(() => setPrompt(field.aiPrompt ?? ''), [field.aiPrompt]);

  const save = () => {
    if ((field.aiPrompt ?? '') !== prompt.trim()) actions.updateField(field.id, { aiPrompt: prompt.trim() || undefined });
  };

  const run = async (overwrite: boolean) => {
    save();
    setBusy(overwrite ? 'all' : 'empty');
    try {
      // Saved first, so the server reads the new prompt.
      await new Promise((r) => setTimeout(r, 400));
      let total = 0;
      for (let round = 0; round < 20; round++) {
        const { filled, remaining } = await fill(pageId, field.id, [], overwrite && round === 0);
        total += filled;
        if (!remaining || !filled) break;
        if (overwrite) break;
      }
      toast(total ? `Filled ${total} card${total === 1 ? '' : 's'}` : 'Nothing to fill');
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-1 mb-1 space-y-1.5 px-1.5 py-1 text-xs">
      <div className="text-sm text-fg">What should the AI write?</div>
      <textarea
        value={prompt}
        disabled={locked}
        onChange={(e) => setPrompt(e.target.value)}
        onBlur={save}
        rows={3}
        placeholder="e.g. Summarise the card in one sentence · Which topic is this? · Estimate the hours it needs"
        className="w-full resize-none rounded-md border border-line bg-surface px-2 py-1.5 text-xs text-fg outline-none focus:border-accent"
      />
      {ai ? (
        <div className="flex gap-1.5">
          <button
            disabled={!!busy || !prompt.trim() || locked}
            onClick={() => void run(false)}
            className="flex h-7 items-center gap-1 rounded-md bg-accent px-2 text-xs font-medium text-white disabled:opacity-50"
          >
            {busy === 'empty' ? <Spinner className="size-3" /> : <Sparkles size={12} />} Fill empty cards
          </button>
          <button
            disabled={!!busy || !prompt.trim() || locked}
            onClick={() => void run(true)}
            className="flex h-7 items-center gap-1 rounded-md border border-line px-2 text-xs hover:bg-hover disabled:opacity-50"
          >
            {busy === 'all' && <Spinner className="size-3" />} Redo all
          </button>
        </div>
      ) : (
        <p className="text-faint">Set up an AI connection (AI → Settings) to fill it in.</p>
      )}
      <p className="text-faint">The AI reads each card's other properties and its page. Values can be edited by hand.</p>
    </div>
  );
}
