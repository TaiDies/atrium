import DOMPurify, { type DOMPurify as Purifier } from 'dompurify';

/** What slide text may contain: formatting stays; scripts, event handlers, forms and embedded content go. */
const OPTIONS = { USE_PROFILES: { html: true }, FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe', 'object', 'embed'] };

/**
 * Slide text is HTML that anyone editing the presentation (or a .pptx file) can write, so it is cleaned
 * before it's shown or saved. `purifier` is for tests outside a browser.
 */
export function safeHtml(html: string, purifier: Purifier = DOMPurify): string {
  return purifier.sanitize(html, OPTIONS) as string;
}
