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
import { fetch as undiciFetch } from 'undici';
import { checkOutboundUrl, guardedAgent, isPrivate } from '../src/netGuard.ts';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWriteStream } from 'node:fs';
import { Zip, ZipDeflate, zipSync } from 'fflate';
import { limiter, loginDelayMs } from '../src/rateLimit.ts';
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
