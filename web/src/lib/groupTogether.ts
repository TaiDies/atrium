/**
 * Keeps each group's items next to each other, groups in the order they first appear. The menu shows
 * a heading whenever the group changes and tracks headings by name, so a group split in two showed
 * its heading twice and left copies behind as the list changed while typing.
 */
export function groupTogether<T extends { group?: string }>(items: T[]): T[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = item.group ?? '';
    const list = groups.get(key);
    if (list) list.push(item);
    else groups.set(key, [item]);
  }
  return [...groups.values()].flat();
}
