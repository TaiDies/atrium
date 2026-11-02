const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

export function timeAgo(iso: string | Date): string {
  const then = new Date(iso).getTime();
  const seconds = Math.round((then - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return 'just now';
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(seconds / 3600), 'hour');
  if (abs < 86400 * 7) return rtf.format(Math.round(seconds / 86400), 'day');
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return 'Good evening';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}
