import type { AppEditor } from './schema';

type AnyBlock = AppEditor['document'][number];

/**
 * Checking (or unchecking) a to-do also checks every to-do nested inside it. Attachments and other
 * blocks nested in a checked to-do are dimmed by CSS (see `.bn-block-group` rules in styles.css).
 * Only local edits cascade; remote ones already arrive with their children updated.
 */
export function cascadeChecklists(editor: AppEditor) {
  return editor.onChange((_, { getChanges }) => {
    const toggled = getChanges().filter(
      (c) =>
        c.type === 'update' &&
        c.source.type !== 'yjs-remote' &&
        c.block.type === 'checkListItem' &&
        (c.block.props as { checked?: boolean }).checked !== (c.prevBlock.props as { checked?: boolean }).checked,
    );
    if (!toggled.length) return;

    const updates: { id: string; checked: boolean }[] = [];
    const walk = (blocks: AnyBlock[], checked: boolean) => {
      for (const b of blocks) {
        if (b.type === 'checkListItem' && (b.props as { checked: boolean }).checked !== checked) updates.push({ id: b.id, checked });
        walk(b.children as AnyBlock[], checked);
      }
    };
    for (const change of toggled) {
      const current = editor.getBlock(change.block.id);
      if (current) walk(current.children as AnyBlock[], (current.props as { checked: boolean }).checked);
    }
    if (!updates.length) return;
    editor.transact(() => {
      for (const u of updates) editor.updateBlock(u.id, { props: { checked: u.checked } } as never);
    });
  }, false);
}
