// Unit tests that need no database: run with `npm test` in server/.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runFormula } from '../../web/src/database/formula.ts';
import { groupTogether } from '../../web/src/lib/groupTogether.ts';
import { checkOutboundUrl, isPrivate } from '../src/netGuard.ts';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync } from 'fflate';
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
