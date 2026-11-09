// Reading a web page's title, description, image and icon for link previews, from HTML a stranger
// wrote. No regular expression here runs over the whole page: tags are found with indexOf and only
// each short tag is looked at, so a page full of half-written tags can't make it slow.

/** Most of a page that is read: the <head> is near the start. */
export const MAX_HTML = 256 * 1024;
/** Longest tag looked at. */
const MAX_TAG = 4096;

const decode = (s: string) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d{1,7});/g, (_, n) => {
      const code = Number(n);
      return code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .trim();

/** The attributes of one short tag ("<meta property='og:title' content='…'>"). */
function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]{0,40})\s*=\s*(?:"([^"]{0,2000})"|'([^']{0,2000})'|([^\s"'>]{1,2000}))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag))) {
    const key = m[1].toLowerCase();
    if (!(key in out)) out[key] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return out;
}

/** Every <name …> tag in the HTML, as attributes. */
function tags(html: string, name: string): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  const lower = html.toLowerCase();
  const open = `<${name}`;
  let at = 0;
  while (out.length < 500) {
    const start = lower.indexOf(open, at);
    if (start < 0) break;
    const after = lower.charCodeAt(start + open.length);
    // "<metadata" isn't "<meta": the name must end here.
    if (!(after === 32 || after === 9 || after === 10 || after === 13 || after === 47 || after === 62)) {
      at = start + open.length;
      continue;
    }
    const end = lower.indexOf('>', start);
    if (end < 0) break;
    if (end - start <= MAX_TAG) out.push(attributes(html.slice(start + open.length, end)));
    at = end + 1;
  }
  return out;
}

export interface PageMeta {
  title: string;
  description: string;
  image: string;
  icon: string;
  site: string;
}

/** Title, description, image and icon address (as written) of a page. */
export function pageMeta(raw: string): PageMeta {
  let html = raw.slice(0, MAX_HTML);
  const headEnd = html.toLowerCase().indexOf('</head>');
  if (headEnd >= 0) html = html.slice(0, headEnd);
  const metas = tags(html, 'meta');
  const meta = (names: string[]) => {
    for (const name of names) {
      const tag = metas.find((t) => (t.property ?? t.name ?? '').toLowerCase() === name && t.content);
      if (tag) return decode(tag.content);
    }
    return '';
  };
  let title = meta(['og:title', 'twitter:title']);
  if (!title) {
    const lower = html.toLowerCase();
    const open = lower.indexOf('<title');
    const gt = open >= 0 ? lower.indexOf('>', open) : -1;
    const close = gt >= 0 ? lower.indexOf('</title>', gt) : -1;
    if (close > gt && close - gt < 4000) title = decode(html.slice(gt + 1, close));
  }
  const icon = tags(html, 'link').find((t) => /(^|\s)(shortcut\s+)?icon(\s|$)|apple-touch-icon/i.test((t.rel ?? '').slice(0, 100)) && t.href)?.href ?? '';
  return {
    title,
    description: meta(['og:description', 'twitter:description', 'description']).slice(0, 300),
    image: meta(['og:image', 'twitter:image']),
    icon: icon ? decode(icon) : '',
    site: meta(['og:site_name']),
  };
}
