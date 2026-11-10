import { toast, toastError } from '../components/ui';
import { downloadUrl } from './api';
import { androidCall, hasAndroidBridge } from './androidBridge';

// Saving files and printing. Browsers do both themselves; the Android app's web view does neither
// (links with `download` and print() are ignored there), so in the app they go through MainActivity:
// files are handed over in pieces and written to Downloads, and printing uses Android's print service.
// Both use the app's privileged channel, which only the app's own top-level page gets (androidBridge.ts).

interface AndroidSave {
  saveBegin(name: string, mime: string): Promise<string>;
  saveChunk(id: string, base64: string): Promise<boolean>;
  saveEnd(id: string): Promise<string>;
  saveAbort(id: string): Promise<void>;
  printHtml(html: string, title: string): Promise<void>;
}

const androidSave: AndroidSave = {
  saveBegin: (name, mime) => androidCall<string>('saveBegin', name, mime),
  saveChunk: (id, data) => androidCall<boolean>('saveChunk', id, data),
  saveEnd: (id) => androidCall<string>('saveEnd', id),
  saveAbort: (id) => androidCall<void>('saveAbort', id),
  printHtml: (html, title) => androidCall<void>('printHtml', html, title),
};

function android(): AndroidSave | null {
  return hasAndroidBridge() ? androidSave : null;
}

/** Whether downloads and printing go through the Android app. */
export const savesNatively = () => android() !== null;

const CHUNK = 384 * 1024;

function base64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const cleanName = (name: string) => name.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'download';

async function saveOnAndroid(bridge: AndroidSave, blob: Blob, name: string) {
  const id = await bridge.saveBegin(cleanName(name), blob.type || 'application/octet-stream');
  if (!id) throw new Error('Could not save the file on this device');
  try {
    for (let at = 0; at < blob.size; at += CHUNK) {
      const part = new Uint8Array(await blob.slice(at, at + CHUNK).arrayBuffer());
      if (!(await bridge.saveChunk(id, base64(part)))) throw new Error('Could not save the file on this device');
    }
  } catch (err) {
    await bridge.saveAbort(id).catch(() => {});
    throw err;
  }
  const error = await bridge.saveEnd(id);
  if (error) throw new Error(error);
  toast(`Saved “${cleanName(name)}” to Downloads`);
}

/** Saves a file the app made (an export, a picture…) to the device. */
export async function saveBlob(blob: Blob, name: string) {
  const bridge = android();
  if (bridge) return saveOnAndroid(bridge, blob, name).catch(toastError);
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  document.body.append(a);
  nativeClick.call(a);
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 30_000);
}

/** The file name a response suggests (Content-Disposition), if any. */
function suggestedName(res: Response): string | null {
  const cd = res.headers.get('content-disposition') ?? '';
  const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  if (star) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      // fall through
    }
  }
  return /filename="?([^";]+)"?/i.exec(cd)?.[1] ?? null;
}

/** Downloads a file from the server (an attachment, an export) to the device. */
export async function saveUrl(url: string, name?: string) {
  const bridge = android();
  if (!bridge) {
    const a = document.createElement('a');
    a.href = downloadUrl(url);
    if (name) a.download = name;
    document.body.append(a);
    nativeClick.call(a);
    a.remove();
    return;
  }
  try {
    toast('Downloading…');
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? 'Could not download the file');
    const blob = await res.blob();
    await saveOnAndroid(bridge, blob, name || suggestedName(res) || decodeURIComponent(url.split('?')[0].split('/').pop() ?? '') || 'download');
  } catch (err) {
    toastError(err);
  }
}

/** Pictures from this server written into the page, since the Android print view can't sign in to fetch them. */
async function inlineImages(html: string): Promise<string> {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const img of Array.from(doc.querySelectorAll('img'))) {
    const src = img.getAttribute('src') ?? '';
    if (!src || src.startsWith('data:')) continue;
    const url = new URL(src, location.origin);
    if (url.origin !== location.origin) continue;
    try {
      const blob = await (await fetch(url.toString(), { credentials: 'same-origin' })).blob();
      img.setAttribute(
        'src',
        await new Promise<string>((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result));
          r.onerror = () => reject(r.error);
          r.readAsDataURL(blob);
        }),
      );
    } catch {
      img.remove();
    }
  }
  return `<!DOCTYPE html>${doc.documentElement.outerHTML}`;
}

/** Opens the print window for a complete HTML page. */
export async function printDocument(html: string, title: string) {
  const bridge = android();
  if (bridge) {
    try {
      await bridge.printHtml(await inlineImages(html), title || 'Document');
    } catch (err) {
      toastError(err);
    }
    return;
  }
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
  document.body.appendChild(frame);
  frame.contentDocument!.open();
  frame.contentDocument!.write(html);
  frame.contentDocument!.close();
  setTimeout(() => {
    frame.contentWindow!.focus();
    frame.contentWindow!.print();
    setTimeout(() => frame.remove(), 60_000);
  }, 400);
}

const nativeClick = HTMLAnchorElement.prototype.click;

/**
 * In the Android app, links that download (`<a download>`), whether tapped or clicked from code, are
 * saved through the app instead of being ignored. Call once at start-up.
 */
export function installAndroidDownloads() {
  if (!android()) return;
  const handle = (a: HTMLAnchorElement) => {
    const href = a.getAttribute('href');
    if (!href) return false;
    const name = a.getAttribute('download') || undefined;
    if (href.startsWith('blob:') || href.startsWith('data:')) {
      void fetch(href)
        .then((r) => r.blob())
        .then((b) => saveBlob(b, name ?? 'download'))
        .catch(toastError);
    } else void saveUrl(href, name);
    return true;
  };
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    if (this.hasAttribute('download') && handle(this)) return;
    nativeClick.call(this);
  };
  document.addEventListener(
    'click',
    (e) => {
      const a = (e.target as Element | null)?.closest?.('a[download]') as HTMLAnchorElement | null;
      if (a && handle(a)) e.preventDefault();
    },
    true,
  );
}
