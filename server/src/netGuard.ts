import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { config } from './config.js';
import { HttpError } from './util.js';

// Addresses the server fetches because someone typed them in (webhooks, an AI service's address, link
// previews) must not become a way into the machine or the network it runs on.

/** Cloud metadata addresses, where a server's credentials live: never fetched. */
function isMetadata(ip: string): boolean {
  const v = ip.toLowerCase();
  if (v.startsWith('fd00:ec2:')) return true;
  const mapped = /::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  const v4 = mapped ? mapped[1] : v;
  return v4.startsWith('169.254.');
}

/** Addresses on this machine or the local network. */
export function isPrivate(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::' || v.startsWith('fe80') || v.startsWith('fc') || v.startsWith('fd')) return true;
    const mapped = /::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    return mapped ? isPrivate(mapped[1]) : false;
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

/**
 * Checks an address before the server fetches it: web addresses only, never cloud metadata, and local
 * network addresses only when allowed (`private`: "allow" follows ALLOW_PRIVATE_URLS, which is on for
 * self-hosting so a local Ollama or n8n works, and should be off on a shared, hosted server).
 */
export async function checkOutboundUrl(raw: string, opts: { private: 'allow' | 'block'; what: string }): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, `${opts.what}: that isn't a valid address`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new HttpError(400, `${opts.what}: only http and https addresses work`);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host.toLowerCase() === 'metadata.google.internal') throw new HttpError(400, `${opts.what}: that address can't be used`);
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (!addresses.length) throw new HttpError(400, `${opts.what}: that address could not be found`);
  if (addresses.some((a) => isMetadata(a.address))) throw new HttpError(400, `${opts.what}: that address can't be used`);
  const allowPrivate = opts.private === 'allow' && config.allowPrivateUrls;
  if (!allowPrivate && addresses.some((a) => isPrivate(a.address))) throw new HttpError(400, `${opts.what}: addresses on the local network aren't allowed on this server`);
  return url;
}
