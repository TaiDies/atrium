// Unit tests that need no database: run with `npm test` in server/.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runFormula } from '../../web/src/database/formula.ts';
import { groupTogether } from '../../web/src/lib/groupTogether.ts';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { JSDOM } from 'jsdom';
import { safeHtml } from '../../web/src/office/slides/safeHtml.ts';
import createDOMPurify from '../../web/node_modules/dompurify/dist/purify.es.mjs';
import { ffmpegInput, INPUT_FORMATS } from '../src/ffmpegArgs.ts';
import { historyNotice } from '../src/historyNotice.ts';
import { shouldRenewTicket } from '../../web/src/lib/ticketRenewal.ts';
import { fallbackMessage, healthOk, isNetworkFailure, isUnreachable, outboxVerdict } from '../../web/src/lib/reachability.ts';
import { asyncCapable, jobState, aiTimeout, HELD_TIMEOUT_MS } from '../src/aiJobs.ts';
import { HttpError } from '../src/util.ts';
import { fetch as undiciFetch } from 'undici';
import { checkOutboundUrl, guardedAgent, isMetadata, isPrivate } from '../src/netGuard.ts';
import { deliveryError } from '../src/webhooks.ts';
import { linkedTitles, writeMarkdown } from '../src/markdownBlocks.ts';
import { pageMeta } from '../src/htmlMeta.ts';
import * as Y from 'yjs';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWriteStream } from 'node:fs';
import { Zip, ZipDeflate, zipSync } from 'fflate';
import { limiter, limitKey, loginDelayMs } from '../src/rateLimit.ts';
import { invitationBlock } from '../src/invitationRule.ts';
import { trustProxySetting } from '../src/config.ts';
import Fastify from 'fastify';
import { historyDaysSetting, trustProxySetting } from '../src/config.ts';
import { SERVER_VERSION } from '../src/updates.ts';
import { namedCells, normaliseCells } from '../src/rowCells.ts';
import { checkArgs } from '../src/routes/mcp.ts';
import { apiGuide } from '../src/apiGuide.ts';
import { guideFor } from '../src/aiGuide.ts';
import { handleError } from '../src/util.ts';
import { z } from 'zod';
import { esPatterns } from '../../web/src/i18n/es.ts';
import { frPatterns } from '../../web/src/i18n/fr.ts';
import { unzipToDisk } from '../src/unzipDisk.ts';

describe('rate limits', () => {
  it('slows sign-ins for a guessed account instead of refusing them', () => {
    assert.equal(loginDelayMs(5), 0);
    assert.equal(loginDelayMs(6), 500);
    assert.equal(loginDelayMs(500), 5000, 'never more than 5 s');
  });
  it('allows up to the limit, then blocks, per key', () => {
    const l = limiter(3, 60_000);
    assert.equal(l.take('a'), true);
    assert.equal(l.take('a'), true);
    assert.equal(l.take('a'), true);
    assert.equal(l.take('a'), false);
    assert.equal(l.take('b'), true, 'other keys are separate');
  });
  it('can be cleared', () => {
    const l = limiter(1, 60_000);
    l.hit('x');
    assert.equal(l.blocked('x'), true);
    l.clear('x');
    assert.equal(l.blocked('x'), false);
  });
});

describe('outbound address guard', () => {
  it('knows private and local addresses', () => {
    for (const ip of ['10.0.0.1', '127.0.0.1', '192.168.1.5', '172.16.0.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:10.1.2.3']) assert.equal(isPrivate(ip), true, ip);
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(isPrivate(ip), false, ip);
  });
  it('never allows cloud metadata or non-web addresses', async () => {
    await assert.rejects(checkOutboundUrl('http://169.254.169.254/latest/meta-data/', { private: 'allow', what: 'Test' }));
    await assert.rejects(checkOutboundUrl('http://metadata.google.internal/', { private: 'allow', what: 'Test' }));
    await assert.rejects(checkOutboundUrl('file:///etc/passwd', { private: 'allow', what: 'Test' }));
    await assert.rejects(checkOutboundUrl('not a url', { private: 'allow', what: 'Test' }));
  });
  it('blocks the local network when asked', async () => {
    await assert.rejects(checkOutboundUrl('http://127.0.0.1:5432/', { private: 'block', what: 'Test' }));
    await assert.rejects(checkOutboundUrl('http://10.0.0.5/', { private: 'block', what: 'Test' }));
  });
  it('allows the local network for self-hosting (the default)', async () => {
    const url = await checkOutboundUrl('http://127.0.0.1:11434/v1', { private: 'allow', what: 'Test' });
    assert.equal(url.port, '11434');
  });
});

describe('formulas', () => {
  const props: Record<string, number | string | boolean | null> = { Price: 4, Qty: 3, Done: true, Name: 'Box' };
  const ctx = { prop: (n: string) => props[n] ?? null };
  const value = (src: string) => {
    const r = runFormula(src, ctx);
    assert.ok('value' in r, `${src}: ${'error' in r ? r.error : ''}`);
    return r.value;
  };
  it('does arithmetic with properties', () => assert.equal(value('prop("Price") * prop("Qty")'), 12));
  it('respects precedence and brackets', () => {
    assert.equal(value('1 + 2 * 3'), 7);
    assert.equal(value('(1 + 2) * 3'), 9);
  });
  it('handles if and concat', () => {
    assert.equal(value('if(prop("Done"), "yes", "no")'), 'yes');
    assert.equal(value('concat(prop("Name"), "-", 1)'), 'Box-1');
  });
  it('rounds', () => assert.equal(value('round(2 / 3 * 100)'), 67));
  it('reports errors instead of throwing', () => {
    const r = runFormula('prop("Price" *', ctx);
    assert.ok('error' in r);
  });
});

describe('slash menu grouping', () => {
  it('keeps each group together, in first-seen order', () => {
    const items = [
      { title: 'Heading', group: 'Basic' },
      { title: 'Image', group: 'Media' },
      { title: 'Quote', group: 'Basic' },
      { title: 'Video', group: 'Media' },
      { title: 'Plain' },
    ];
    const out = groupTogether(items).map((i) => i.title);
    assert.deepEqual(out, ['Heading', 'Quote', 'Image', 'Video', 'Plain']);
  });
  it('never repeats a group heading', () => {
    const out = groupTogether([{ group: 'A' }, { group: 'B' }, { group: 'A' }, { group: 'B' }]);
    const runs = out.map((i) => i.group).filter((g, i, a) => i === 0 || a[i - 1] !== g);
    assert.equal(new Set(runs).size, runs.length);
  });
});

describe('zip import unpacking', () => {
  const withZip = async (files: Record<string, Uint8Array>, run: (zip: string, dir: string) => Promise<void>) => {
    const dir = mkdtempSync(join(tmpdir(), 'unzip-test-'));
    try {
      const zip = join(dir, 'in.zip');
      writeFileSync(zip, zipSync(files));
      await run(zip, dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  it('unpacks each entry to its own file on disk', () =>
    withZip({ 'a.txt': new TextEncoder().encode('hello'), 'sub/b.bin': new Uint8Array(70_000).fill(7) }, async (zip, dir) => {
      const out = await unzipToDisk(zip, dir, { maxBytes: 1e6, maxEntries: 10 });
      assert.equal(readFileSync(out.get('a.txt')!.file, 'utf8'), 'hello');
      assert.equal(out.get('sub/b.bin')!.size, 70_000);
    }));
  it('copes with thousands of tiny entries', () => {
    const lots: Record<string, Uint8Array> = {};
    for (let i = 0; i < 5000; i++) lots[`f${i}`] = new Uint8Array(i % 2);
    return withZip(lots, async (zip, dir) => {
      const out = await unzipToDisk(zip, dir, { maxBytes: 1e6, maxEntries: 10_000 });
      assert.equal(out.size, 5000);
    });
  });
  it('unpacks a zip bomb without memory growing much (the disk keeps up)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'unzip-bomb-'));
    try {
      // About 300 MB of zeros, which compresses to well under 1 MB, written as it's made.
      const zip = join(dir, 'bomb.zip');
      const out = createWriteStream(zip);
      const zipper = new Zip((err, data, final) => {
        if (!err) out.write(data);
        if (final) out.end();
      });
      const entry = new ZipDeflate('zeros.bin', { level: 9 });
      zipper.add(entry);
      const block = new Uint8Array(1 << 20);
      for (let i = 0; i < 300; i++) entry.push(block, i === 299);
      zipper.end();
      await new Promise((r) => out.once('close', r));
      const base = process.memoryUsage().rss;
      let peak = base;
      const timer = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 5);
      const result = await unzipToDisk(zip, dir, { maxBytes: 1024 ** 3, maxEntries: 10 });
      clearInterval(timer);
      assert.equal(result.get('zeros.bin')!.size, 300 * (1 << 20));
      assert.ok(peak - base < 150 * 1024 * 1024, `memory grew by ${Math.round((peak - base) / 1024 / 1024)} MB`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('refuses more entries than allowed', () =>
    withZip({ a: new Uint8Array(1), b: new Uint8Array(1), c: new Uint8Array(1) }, async (zip, dir) => {
      await assert.rejects(unzipToDisk(zip, dir, { maxBytes: 1e6, maxEntries: 2 }), (e: { status?: number }) => e.status === 413);
    }));
  it('stops a small zip that unpacks to too much, counting real bytes', () =>
    withZip({ zeros: new Uint8Array(5_000_000) }, async (zip, dir) => {
      await assert.rejects(unzipToDisk(zip, dir, { maxBytes: 1_000_000, maxEntries: 10 }), (e: { status?: number }) => e.status === 413);
    }));
  it('refuses something that is not a zip', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'unzip-test-'));
    try {
      writeFileSync(join(dir, 'x.zip'), 'not a zip at all');
      const out = await unzipToDisk(join(dir, 'x.zip'), dir, { maxBytes: 1e6, maxEntries: 10 }).catch((e) => e);
      assert.ok(out instanceof Map ? out.size === 0 : out.status === 400);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('outbound connections', () => {
  it('check the address they actually connect to', async () => {
    const server = createServer((_req, res) => res.end('ok')).listen(0);
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as { port: number }).port;
    try {
      // "localhost" resolves to a loopback address at connect time: refused when private addresses aren't allowed.
      const blocked = await undiciFetch(`http://localhost:${port}/`, { dispatcher: guardedAgent(false) }).then(
        () => null,
        (e: { cause?: { code?: string } }) => e.cause?.code,
      );
      assert.equal(blocked, 'EBLOCKEDADDRESS');
      const allowed = await undiciFetch(`http://localhost:${port}/`, { dispatcher: guardedAgent(true) });
      assert.equal(await allowed.text(), 'ok');
    } finally {
      server.close();
    }
  });
});

describe('slide text cleaning', () => {
  const purifier = createDOMPurify(new JSDOM('').window as never);
  const clean = (html: string) => safeHtml(html, purifier as never);
  it('keeps formatting', () => {
    assert.equal(clean('<b>Bold</b> <i>and</i> <span style="color: red">red</span>'), '<b>Bold</b> <i>and</i> <span style="color: red">red</span>');
  });
  it('removes scripts, event handlers and active content', () => {
    const out = clean('<img src=x onerror="alert(1)"><script>alert(2)</script><a href="javascript:alert(3)">x</a><iframe src="https://evil.example"></iframe><form><input></form><style>*{}</style>');
    assert.doesNotMatch(out, /onerror|<script|javascript:|<iframe|<form|<input|<style/i);
  });
});

describe('ffmpeg input', () => {
  it('reads only local files in real video and audio containers', () => {
    const args = ffmpegInput('/data/upload');
    assert.deepEqual(args.slice(0, 4), ['-protocol_whitelist', 'file', '-format_whitelist', INPUT_FORMATS]);
    assert.equal(args.at(-1), '/data/upload');
    for (const risky of ['hls', 'concat', 'image2', 'lavfi', 'tee', 'data']) assert.ok(!INPUT_FORMATS.split(',').includes(risky), risky);
  });
  it('refuses a playlist pretending to be a video (when ffmpeg is installed)', (t) => {
    const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
    if (spawnSync(ffmpeg, ['-version']).error) return t.skip('ffmpeg is not installed');
    const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-test-'));
    try {
      const fake = join(dir, 'video.mp4');
      writeFileSync(fake, ['#EXTM3U', '#EXT-X-TARGETDURATION:1', '#EXTINF:1,', 'http://127.0.0.1:9/segment.ts', '#EXT-X-ENDLIST', ''].join('\n'));
      const run = spawnSync(ffmpeg, ['-hide_banner', ...ffmpegInput(fake), '-f', 'null', '-'], { encoding: 'utf8', timeout: 20_000 });
      assert.notEqual(run.status, 0, 'ffmpeg should refuse it');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('page history notice', () => {
  it('says how much was removed and how to keep more', () => {
    const line = historyNotice(1234, 90, 10);
    assert.match(line, /removed 1234 snapshots older than 90 days/);
    assert.match(line, /newest 10/);
    assert.match(line, /HISTORY_DAYS/);
    assert.match(historyNotice(1, 30, 10), /1 snapshot older/);
  });
});

describe('live ticket renewal', () => {
  const min = 60_000;
  it('renews on the hourly timer every time', () => assert.equal(shouldRenewTicket('timer', 0, 1), true));
  it('renews on focus once the ticket is half an hour old (a computer waking from sleep)', () => {
    assert.equal(shouldRenewTicket('focus', 0, 10 * min), false);
    assert.equal(shouldRenewTicket('focus', 0, 5 * 60 * min), true);
  });
  it('renews when back online after a minute', () => {
    assert.equal(shouldRenewTicket('online', 0, 30_000), false);
    assert.equal(shouldRenewTicket('online', 0, 2 * min), true);
  });
  it('renews straight away when a connection is refused, but not in a loop', () => {
    assert.equal(shouldRenewTicket('refused', 0, 20_000), true);
    assert.equal(shouldRenewTicket('refused', 0, 5_000), false);
  });
});

describe('going offline only when the server is really unreachable', () => {
  const html = (status: number, headers: Record<string, string> = {}) => new Response('<html>Bad gateway</html>', { status, headers: { 'content-type': 'text/html', ...headers } });
  const up = async () => true;
  const down = async () => false;
  it('a 502 page from a proxy while the health check answers stays online', async () => {
    assert.equal(await isUnreachable(html(502), up), false);
    assert.equal(await isUnreachable(html(524), up), false, 'a proxy cutting a slow request');
  });
  it('a 502 page while the health check fails goes offline', async () => {
    assert.equal(await isUnreachable(html(502), down), true);
    assert.equal(await isUnreachable(html(503), down), true);
  });
  it("the apps' x-offline header goes offline without asking", async () => {
    let asked = false;
    assert.equal(await isUnreachable(new Response('{}', { status: 200, headers: { 'x-offline': '1' } }), async () => ((asked = true), true)), true);
    assert.equal(asked, false);
  });
  it("the server's own JSON errors and ordinary statuses never ask the health check", async () => {
    let asked = 0;
    const count = async () => (asked++, false);
    assert.equal(await isUnreachable(new Response(JSON.stringify({ error: 'x' }), { status: 502 }), count), false);
    assert.equal(await isUnreachable(new Response(JSON.stringify({ error: 'AI' }), { status: 424 }), count), false);
    assert.equal(await isUnreachable(html(500), count), false);
    assert.equal(asked, 0);
  });
  it('the health check gives up quickly and treats errors as down', async () => {
    const ok: typeof fetch = async () => new Response('{"status":"ok"}');
    const offline: typeof fetch = async () => new Response('{}', { headers: { 'x-offline': '1' } });
    const hangs: typeof fetch = (_u, init) => new Promise((_r, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    assert.equal(await healthOk(ok), true);
    assert.equal(await healthOk(offline), false);
    const t0 = Date.now();
    assert.equal(await healthOk(hangs, 50), false);
    assert.ok(Date.now() - t0 < 1000);
  });
  it('explains slow and gateway failures', () => {
    assert.match(fallbackMessage(524), /too long/);
    assert.match(fallbackMessage(502), /problem/);
    assert.equal(fallbackMessage(418), 'Request failed (418)');
  });
});

describe('background AI requests', () => {
  const reply = () => {
    const r = { statusCode: 200, body: undefined as unknown, code(c: number) { r.statusCode = c; return r; }, send(b: unknown) { r.body = b; return r; } };
    return r;
  };
  const request = (prefer?: string) => ({ headers: prefer ? { prefer } : {}, user: { id: 'u1' } }) as any;
  it('answers directly without "Prefer: respond-async"', async () => {
    const out = await asyncCapable(async () => ({ text: 'hi' }))(request(), reply() as any);
    assert.deepEqual(out, { text: 'hi' });
  });
  it('runs in the background with the longer timeout, and hands the answer to its owner only', async () => {
    let timeout = 0;
    const r = reply();
    await asyncCapable(async () => ((timeout = aiTimeout(300_000)), { text: 'later' }))(request('respond-async'), r as any);
    assert.equal(r.statusCode, 202);
    const id = (r.body as { job: string }).job;
    await new Promise((res) => setTimeout(res, 10));
    assert.equal(timeout, 300_000);
    assert.equal(aiTimeout(300_000), HELD_TIMEOUT_MS, 'outside a job: the short timeout');
    assert.deepEqual(jobState(id, 'u1'), { done: true, result: { text: 'later' } });
    assert.throws(() => jobState(id, 'someone else'), (e: HttpError) => e.status === 404);
  });
  it('keeps the status and message of a failed job', async () => {
    const r = reply();
    await asyncCapable(async () => {
      throw new HttpError(424, 'The AI service had a problem answering.');
    })(request('respond-async'), r as any);
    await new Promise((res) => setTimeout(res, 10));
    assert.throws(() => jobState((r.body as { job: string }).job, 'u1'), (e: HttpError) => e.status === 424 && /problem/.test(e.message));
  });
  it('keeps the held timeout under the 100 seconds proxies allow', () => {
    assert.ok(HELD_TIMEOUT_MS < 100_000);
  });
});

describe('outbound addresses in every form', () => {
  const blocked = [
    'http://127.0.0.1/', 'http://2130706433/', 'http://0x7f.1/', 'http://017700000001/', 'http://0177.0.0.1/', 'http://127.1/',
    'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/', 'http://[::127.0.0.1]/', 'http://[::7f00:1]/',
    'http://[64:ff9b::7f00:1]/', 'http://[2002:7f00:1::]/', 'http://[fec0::1]/', 'http://[fc00::1]/', 'http://[fd12::1]/',
    'http://[fe80::1]/', 'http://[::]/', 'http://0.0.0.0/', 'http://10.1.2.3/', 'http://192.168.0.1/', 'http://172.20.0.1/', 'http://100.64.0.1/',
    'http://[::ffff:10.0.0.1]/', 'http://[::ffff:192.168.1.1]/',
  ];
  it('refuses private and loopback addresses written any way', async () => {
    for (const u of blocked) {
      await assert.rejects(checkOutboundUrl(u, { private: 'block', what: 'Test' }), (e: HttpError) => e.status === 400, u);
    }
  });
  it('refuses cloud metadata even when private addresses are allowed', async () => {
    for (const u of ['http://169.254.169.254/', 'http://[::ffff:169.254.169.254]/', 'http://[::ffff:a9fe:a9fe]/', 'http://[fd00:ec2::254]/', 'http://2852039166/']) {
      await assert.rejects(checkOutboundUrl(u, { private: 'allow', what: 'Test' }), (e: HttpError) => e.status === 400, u);
    }
  });
  it('classifies addresses directly', () => {
    assert.equal(isPrivate('::ffff:7f00:1'), true);
    assert.equal(isPrivate('2002:0a00:0001::'), true);
    assert.equal(isPrivate('8.8.8.8'), false);
    assert.equal(isPrivate('2606:4700:4700::1111'), false);
    assert.equal(isMetadata('::ffff:a9fe:a9fe'), true);
    assert.equal(isMetadata('8.8.8.8'), false);
  });
  it('the guarded connection refuses IP literals that skip the lookup', async () => {
    const server = createServer((_q, r) => r.end('ok'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      for (const host of ['127.0.0.1', '[::ffff:127.0.0.1]', '[::ffff:7f00:1]']) {
        await assert.rejects(
          undiciFetch(`http://${host}:${port}/`, { dispatcher: guardedAgent(false) }),
          (e: { cause?: { code?: string } }) => e.cause?.code === 'EBLOCKEDADDRESS',
          host,
        );
      }
      const ok = await undiciFetch(`http://127.0.0.1:${port}/`, { dispatcher: guardedAgent(true) });
      assert.equal(await ok.text(), 'ok', 'allowed when private addresses are allowed');
    } finally {
      server.close();
    }
  });
  it('webhook errors never echo what an internal host said', () => {
    assert.equal(deliveryError(Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 10.0.0.5:6379 secret banner' } })), 'The address refused the connection');
    assert.equal(deliveryError(new Error('internal stack trace')), 'Could not connect to the address');
  });
});

describe('odd input stays fast', () => {
  const fast = (label: string, fn: () => void) => {
    const t0 = performance.now();
    fn();
    const ms = performance.now() - t0;
    assert.ok(ms < 1000, `${label} took ${Math.round(ms)} ms`);
  };
  it('Markdown with a million "[" and no "]"', () => {
    const md = '['.repeat(1_000_000);
    fast('linkedTitles', () => linkedTitles(md));
    fast('linkedTitles with one "]]" at the end', () => linkedTitles(`${md}]]`));
    fast('writing it into a page', () => writeMarkdown(new Y.Doc(), md, true));
    fast('a long line of "[a](" pieces', () => writeMarkdown(new Y.Doc(), '[a]('.repeat(250_000), true));
    fast('many "**" without a close', () => writeMarkdown(new Y.Doc(), `${'**a'.repeat(6000)}\n`.repeat(20), true));
  });
  it('still reads links and formatting', () => {
    assert.deepEqual(linkedTitles('See [[Plan]] and [[Notes|my notes]], not `[[code]]`'), ['Plan', 'Notes']);
  });
  it('link previews of hostile HTML', () => {
    const page = '<meta property="og:title"'.repeat(40_000) + '<title' + ' x'.repeat(200_000);
    fast('many unfinished meta tags', () => pageMeta(page));
    fast('a million "<"', () => pageMeta('<'.repeat(1_000_000)));
    fast('one enormous tag', () => pageMeta(`<meta ${'a="b" '.repeat(150_000)}>`));
  });
  it('still reads a normal page', () => {
    const m = pageMeta(`<html><head><title>Plain &amp; simple</title><meta property="og:description" content="About it"><meta name='og:image' content='/i.png'><link rel="shortcut icon" href="/f.ico"><meta property="og:site_name" content="Site"></head><body><meta property="og:title" content="late"></body>`);
    assert.deepEqual(m, { title: 'Plain & simple', description: 'About it', image: '/i.png', icon: '/f.ico', site: 'Site' });
  });
});

describe('settings and limits from 1.11.3', () => {
  it('trusts no proxy unless TRUST_PROXY says so', () => {
    assert.equal(trustProxySetting(undefined), false);
    assert.equal(trustProxySetting(''), false);
    assert.equal(trustProxySetting('loopback'), 'loopback');
    assert.equal(trustProxySetting('true'), true);
  });
  it('keeps all page history unless HISTORY_DAYS is a whole number', () => {
    assert.equal(historyDaysSetting(undefined), 0);
    assert.equal(historyDaysSetting('0'), 0);
    assert.equal(historyDaysSetting(' 90 '), 90);
    for (const bad of ['1.5', '-3', 'ninety', '90d']) assert.throws(() => historyDaysSetting(bad), /whole number/, bad);
  });
  it('counts IPv6 addresses per /64', () => {
    assert.equal(limitKey('2001:db8:1:2:aaaa::1'), limitKey('2001:db8:1:2:bbbb:cccc:dddd:eeee'));
    assert.notEqual(limitKey('2001:db8:1:2::1'), limitKey('2001:db8:1:3::1'));
    assert.equal(limitKey('::ffff:203.0.113.7'), '203.0.113.7');
    assert.equal(limitKey('203.0.113.7'), '203.0.113.7');
    assert.equal(limitKey('someone@example.com'), 'someone@example.com');
    const l = limiter(2, 60_000);
    l.hit('2001:db8:9:9::1');
    l.hit('2001:db8:9:9::2');
    assert.equal(l.blocked('2001:db8:9:9:ffff::3'), true, 'another address in the same /64 is blocked too');
  });
});

describe('offline changes and network errors', () => {
  it('keeps queued changes when signed out or when the server is busy', () => {
    assert.equal(outboxVerdict(200), 'done');
    assert.equal(outboxVerdict(204), 'done');
    assert.equal(outboxVerdict(401), 'wait-for-sign-in');
    for (const s of [408, 425, 429, 500, 502, 503, 504, 524]) assert.equal(outboxVerdict(s), 'retry-later', String(s));
    for (const s of [400, 403, 404, 409, 423]) assert.equal(outboxVerdict(s), 'refused', String(s));
  });
  it('only a network failure counts as offline', () => {
    assert.equal(isNetworkFailure(new TypeError('Failed to fetch')), true);
    assert.equal(isNetworkFailure(new DOMException('Stopped', 'AbortError')), false);
    assert.equal(isNetworkFailure(new Error('The app couldn’t send this request')), false);
  });
});

describe('versions and translations (1.11.4)', () => {
  it('every package and app file has the same version as server/package.json', () => {
    const r = spawnSync(process.execPath, ['../tools/set-version.mjs', '--check'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const server = JSON.parse(readFileSync('package.json', 'utf8')).version;
    assert.equal(SERVER_VERSION, server);
  });
  it('"1 month ago" is singular in Spanish and French', () => {
    const first = (patterns: [RegExp, string][], text: string) => {
      for (const [re, out] of patterns) if (re.test(text)) return text.replace(re, out);
      return text;
    };
    assert.equal(first(esPatterns, '1 month ago'), 'hace 1 mes');
    assert.equal(first(esPatterns, '3 months ago'), 'hace 3 meses');
    assert.equal(first(esPatterns, '1 day ago'), 'hace 1 día');
    assert.equal(first(frPatterns, '1 year ago'), 'il y a 1 an');
    assert.equal(first(frPatterns, '2 years ago'), 'il y a 2 ans');
  });
});

describe('card values through the API', () => {
  const fields = [
    { id: 'f1', name: 'Name', type: 'text', primary: true },
    { id: 'f2', name: 'Status', type: 'select', options: [{ id: 'o1', name: 'To do' }, { id: 'o2', name: 'Done' }] },
    { id: 'f3', name: 'Due', type: 'date' },
    { id: 'f4', name: 'Tags', type: 'multi_select', options: [{ id: 't1', name: 'Red' }] },
    { id: 'f5', name: 'Owner', type: 'person' },
    { id: 'f6', name: 'Total', type: 'formula' },
    { id: 'f7', name: 'Steps', type: 'checklist' },
    { id: 'f8', name: 'Hours', type: 'number' },
  ];
  it('takes names or ids, and option names', () => {
    const out = normaliseCells(fields, { Name: 'Plan', status: 'done', f3: 'today', Tags: ['Red'], Owner: ['u1'], Hours: 2 }, { members: new Set(['u1']), today: '2026-11-09' });
    assert.deepEqual(out, { f1: 'Plan', f2: 'o2', f3: '2026-11-09', f4: ['t1'], f5: ['u1'], f8: 2 });
  });
  it('refuses unknown properties, computed ones and wrong values, naming the property', () => {
    assert.throws(() => normaliseCells(fields, { Nope: 1 }), /no property “Nope”/);
    assert.throws(() => normaliseCells(fields, { Total: 3 }), /worked out by the app/);
    assert.throws(() => normaliseCells(fields, { Status: 'Maybe' }), /no option “Maybe”/);
    assert.throws(() => normaliseCells(fields, { Due: '09/11/2026' }), /“Due” \(date\)/);
    assert.throws(() => normaliseCells(fields, { Hours: '2' }), /a number/);
    assert.throws(() => normaliseCells(fields, { Owner: ['stranger'] }, { members: new Set(['u1']) }), /not members/);
  });
  it('makes checklist items and clears with null', () => {
    const out = normaliseCells(fields, { Steps: ['One', { text: 'Two', done: true }], Due: null });
    assert.equal((out.f7 as { text: string }[]).map((s) => s.text).join(','), 'One,Two');
    assert.equal(out.f3, null);
  });
  it('shows stored values by name', () => {
    assert.deepEqual(namedCells(fields, { f1: 'Plan', f2: 'o2', f4: ['t1'] }), { Name: 'Plan', Status: 'Done', Tags: ['Red'] });
  });
});

describe('MCP tool arguments', () => {
  const schema = { type: 'object', properties: { id: { type: 'string' }, group: { type: 'string' }, mode: { type: 'string', enum: ['append', 'replace'] }, values: { type: 'object' } }, required: ['group'] };
  it('refuses a missing required argument (no more clearing a group by leaving it out)', () => {
    assert.match(checkArgs(schema, { id: 'x' }) ?? '', /Missing "group"/);
  });
  it('checks types and allowed values, and ignores extra arguments', () => {
    assert.match(checkArgs(schema, { group: 3 }) ?? '', /should be a string/);
    assert.match(checkArgs(schema, { group: 'a', mode: 'merge' }) ?? '', /one of: append, replace/);
    assert.match(checkArgs(schema, { group: 'a', values: [1] }) ?? '', /an object/);
    assert.equal(checkArgs(schema, { group: 'a', extra: true }), null);
  });
});

describe('API guide and error messages', () => {
  it('documents tokens, background AI jobs, cards, webhook signing and MCP tools', () => {
    const g = apiGuide();
    for (const s of ['respond-async', '/api/ai/jobs/{jobId}', '/api/pages/{databaseId}/rows/batch', 'rotate-secret', 'X-Signature-V2', 'add_card', 'only possible in the app', 'af_', '423']) assert.ok(g.includes(s), s);
    assert.ok(!g.includes('"mode": "append" | "replace"}.\''), 'no stale rows');
  });
  it('names the field in zod errors', () => {
    let sent: { error: string; field?: string } | undefined;
    const reply = { code: () => reply, send: (b: { error: string; field?: string }) => ((sent = b), reply) };
    try {
      z.object({ cells: z.object({ Due: z.string() }) }).parse({ cells: { Due: 5 } });
    } catch (err) {
      handleError(err, {} as never, reply as never);
    }
    assert.equal(sent?.field, 'cells.Due');
    assert.match(sent?.error ?? '', /^cells\.Due: /);
  });
});

describe('the app guide by topic', () => {
  it('finds the right sections, at most three, and ignores filler words', () => {
    const verify = guideFor('how do I verify a page');
    assert.ok(verify.includes('Verify for 30 days'));
    assert.ok((verify.match(/^## /gm) ?? []).length <= 3);
    assert.match(guideFor('webhooks').split('\n')[0], /For developers/);
    assert.match(guideFor('the and how'), /Nothing in the guide mentions/);
  });
});

describe('accepting an invitation', () => {
  it('without email, a member invitation needs nothing but an owner invitation needs a confirmed address', () => {
    assert.equal(invitationBlock({ mail: false, verified: false, role: 'member' }), null);
    assert.equal(invitationBlock({ mail: false, verified: false, role: 'owner' }), 'admin');
    assert.equal(invitationBlock({ mail: false, verified: true, role: 'owner' }), null);
  });
  it('with email, an unconfirmed address must be confirmed first, whatever the role', () => {
    assert.equal(invitationBlock({ mail: true, verified: false, role: null }), 'confirm');
    assert.equal(invitationBlock({ mail: true, verified: false, role: 'member' }), 'confirm');
    assert.equal(invitationBlock({ mail: true, verified: true, role: 'owner' }), null);
  });
});

describe('visitor address behind proxies', () => {
  async function ipSeen(trust: string | undefined, headers: Record<string, string>) {
    const app = Fastify({ trustProxy: trustProxySetting(trust) });
    app.get('/', async (req) => ({ ip: req.ip }));
    const res = await app.inject({ url: '/', headers, remoteAddress: '172.21.0.1' });
    await app.close();
    return res.json().ip as string;
  }
  it('with no TRUST_PROXY a spoofed X-Forwarded-For does not change the limit key', async () => {
    for (const unset of [undefined, '', '  ', 'false']) {
      const plain = await ipSeen(unset, {});
      const spoofed = await ipSeen(unset, { 'x-forwarded-for': '1.2.3.4' });
      assert.equal(spoofed, '172.21.0.1');
      assert.equal(limitKey(spoofed), limitKey(plain));
    }
  });
  it("loopback does not trust Docker's bridge; the bridge range does", async () => {
    assert.equal(await ipSeen('loopback', { 'x-forwarded-for': '1.2.3.4' }), '172.21.0.1');
    assert.equal(await ipSeen('172.16.0.0/12', { 'x-forwarded-for': '1.2.3.4' }), '1.2.3.4');
  });
});

describe('stylesheet', () => {
  it('every app class the stylesheet styles is used by a component (renames once left phone rules dead)', async () => {
    const { readFileSync, readdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const root = join(import.meta.dirname, '../../web/src');
    const css = readFileSync(join(root, 'styles.css'), 'utf8');
    const code: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(dir, e.name));
        else if (/\.(tsx?|html)$/.test(e.name)) code.push(readFileSync(join(dir, e.name), 'utf8'));
      }
    };
    walk(root);
    const all = code.join(' ');
    const classes = [...new Set([...css.matchAll(/\.((?:af|atrium|ai)-[a-z0-9-]+)/g)].map((m) => m[1]))];
    const unused = classes.filter((c) => !all.includes(c));
    assert.deepEqual(unused, []);
  });
});
