/** The line logged the first time page history pruning removes anything (after upgrading to 1.11). */
export function historyNotice(removed: number, days: number, keep: number): string {
  return (
    `Page history: removed ${removed} snapshot${removed === 1 ? '' : 's'} older than ${days} days ` +
    `(the newest ${keep} of every page and card are always kept). This now runs daily; ` +
    `set HISTORY_DAYS in .env to keep history longer.`
  );
}
