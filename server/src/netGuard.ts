import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent, buildConnector, fetch as undiciFetch } from 'undici';
import { config } from './config.js';
import { HttpError } from './util.js';

// Addresses the server fetches because someone typed them in (webhooks, an AI service's address, link
// previews) must not become a way into the machine or the network it runs on.

/** An IPv6 address as its eight 16-bit groups (null when it isn't one). */
function groups6(ip: string): number[] | null {
  let v = ip.toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (isIP(v) !== 6) return null;
  // A dotted IPv4 tail (::ffff:1.2.3.4) becomes two groups.
  const tail = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (tail) {
    const [a, b, c, d] = tail.slice(1).map(Number);
    v = v.slice(0, tail.index) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, rest] = v.includes('::') ? v.split('::') : [v, null];
  const h = head ? head.split(':') : [];
  const r = rest === null ? [] : rest ? rest.split(':') : [];
  const fill = rest === null ? [] : new Array(8 - h.length - r.length).fill('0');
  const all = [...h, ...fill, ...r].map((x) => parseInt(x, 16));
  return all.length === 8 && all.every((n) => n >= 0 && n <= 0xffff) ? all : null;
}

/**
 * The IPv4 address inside an IPv6 one, for the forms that reach an IPv4 host: mapped (::ffff:a.b.c.d),
 * the old compatible form (::a.b.c.d), NAT64 (64:ff9b::/96) and 6to4 (2002:AABB:CCDD::).
 */
function embedded4(g: number[]): string | null {
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  if (g.slice(0, 5).every((n) => n === 0) && (g[5] === 0xffff || g[5] === 0)) return v4(g[6], g[7]);
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((n) => n === 0)) return v4(g[6], g[7]);
  if (g[0] === 0x2002) return v4(g[1], g[2]);
  return null;
}

function private4(ip: string): boolean {
  const [a, b, c] = ip.split('.').map(Number);
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 198 && (b === 18 || b === 19)) // benchmarking
  );
}

/** Cloud metadata addresses, where a server's credentials live: never fetched. */
export function isMetadata(ip: string): boolean {
  if (isIP(ip) === 4) return ip.startsWith('169.254.');
  const g = groups6(ip);
  if (!g) return false;
  if (g[0] === 0xfd00 && g[1] === 0x0ec2) return true;
  const v4 = embedded4(g);
  return !!v4 && v4.startsWith('169.254.');
}

/** Addresses on this machine or the local network (in any of the forms an IPv6 address can carry one). */
export function isPrivate(ip: string): boolean {
  if (isIP(ip) === 4) return private4(ip);
  const g = groups6(ip);
  if (!g) return true; // not an address we understand: refuse
  if (g.every((n) => n === 0)) return true; // ::
  if (g.slice(0, 7).every((n) => n === 0) && g[7] === 1) return true; // ::1
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0) return true; // link-local, old site-local
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2002 || (g[0] === 0x64 && g[1] === 0xff9b)) return true; // 6to4 and NAT64 reach IPv4 hosts we can't see
  if (g[0] === 0x2001 && g[1] === 0) return true; // Teredo
  if (g[0] === 0x100 && g.slice(1, 4).every((n) => n === 0)) return true; // discard prefix
  const v4 = embedded4(g);
  return v4 !== null; // mapped or compatible forms are IPv4 underneath: never as a literal
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

/** Why an address may not be connected to, or null when it may. */
function refusal(ip: string, allowPrivate: boolean): string | null {
  if (isMetadata(ip)) return "that address can't be used";
  if (!allowPrivate && isPrivate(ip)) return "addresses on the local network aren't allowed on this server";
  return null;
}

/**
 * Connections that check the address they actually connect to. Looking a name up once to check it and
 * again to connect leaves a gap (DNS rebinding: the name answers a public address first, then a private
 * one); here the check happens in the lookup the connection itself uses.
 */
export function guardedAgent(allowPrivate: boolean) {
  const lookup = (hostname: string, options: object, cb: (err: Error | null, address: string | LookupAddress[], family?: number) => void) => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return cb(err, '');
      const bad = addresses.map((a) => refusal(a.address, allowPrivate)).find(Boolean);
      if (bad) return cb(Object.assign(new Error(bad), { code: 'EBLOCKEDADDRESS' }), '');
      if ((options as { all?: boolean }).all) return cb(null, addresses);
      cb(null, addresses[0].address, addresses[0].family);
    });
  };
  const connect = buildConnector({ lookup } as never);
  return new Agent({
    // An address written as an IP skips the lookup, so it's checked here before connecting.
    connect(opts, cb) {
      const host = String(opts.hostname ?? '').replace(/^\[|\]$/g, '');
      const bad = isIP(host) ? refusal(host, allowPrivate) : null;
      if (bad) return cb(Object.assign(new Error(bad), { code: 'EBLOCKEDADDRESS' }), null);
      return connect(opts, cb);
    },
  });
}

/** fetch through the guarded connections, never following redirects (for SDKs that take a fetch). */
export function guardedFetch(allowPrivate: boolean): typeof fetch {
  const dispatcher = allowPrivate && config.allowPrivateUrls ? agents.allow : agents.block;
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    undiciFetch(input as never, { ...(init as object), redirect: 'error', dispatcher } as never)) as unknown as typeof fetch;
}

const agents = { allow: guardedAgent(true), block: guardedAgent(false) };

/**
 * fetch for addresses people typed in: checked like checkOutboundUrl first (for a clear message), then
 * connected through an agent that checks the address it really connects to. Redirects aren't followed
 * (each hop would need checking): callers that want them handle them.
 */
export async function outboundFetch(raw: string, init: RequestInit & { redirect?: 'error' | 'manual' }, opts: { private: 'allow' | 'block'; what: string }): Promise<Response> {
  const url = await checkOutboundUrl(raw, opts);
  const allowPrivate = opts.private === 'allow' && config.allowPrivateUrls;
  try {
    return (await undiciFetch(url, { ...(init as object), redirect: init.redirect ?? 'error', dispatcher: allowPrivate ? agents.allow : agents.block } as never)) as unknown as Response;
  } catch (err) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    if (cause?.code === 'EBLOCKEDADDRESS') throw new HttpError(400, `${opts.what}: ${cause.message}`);
    throw err;
  }
}
