import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { nightCounts } from '../src/digest/nightCounts.js';

// runs/ is read-only; anything synthetic goes in a temp dir (AGENTS.md).
function tempRunsDir(): string {
  return mkdtempSync(join(tmpdir(), 'rig-night-counts-'));
}

describe('nightCounts on the runs/ fixtures', () => {
  it('2026-10-28: per-status totals over the 15 good lines, the 1 bad line counted', () => {
    expect(nightCounts('runs', '2026-10-28')).toEqual({ ok: 10, retry: 4, fail: 1, badLines: 1 });
  });

  it('2026-10-27: a clean night, nothing bad', () => {
    expect(nightCounts('runs', '2026-10-27')).toEqual({ ok: 7, retry: 0, fail: 0, badLines: 0 });
  });
});

describe('nightCounts edge cases (temp dirs only)', () => {
  it('a night with no file returns null; an empty file returns zeros, not null', () => {
    expect(nightCounts('runs', '2026-10-26')).toBeNull();
    const dir = tempRunsDir();
    writeFileSync(join(dir, '2026-10-29.jsonl'), '');
    expect(nightCounts(dir, '2026-10-29')).toEqual({ ok: 0, retry: 0, fail: 0, badLines: 0 });
  });

  it('counts lines that break the contract, same lines read.ts would reject', () => {
    const dir = tempRunsDir();
    const lines = [
      '{"at":"2026-10-29T23:00:00+01:00","job":"a/one","status":"ok","owner":"rook"}',
      '{"at":"2026-10-29T23:01:00+01:00","job":"a/one","status":"fail","owner":null,"error":"boom"}',
      'not json at all, like the real truncated fixture',
      '{"at":"2026-10-29T23:02:00+01:00","job":"a/two","status":"skipped","owner":"rook"}', // unknown status
      '{"job":"a/three","status":"retry","owner":"rook"}', // no at
      '{"at":"2026-10-29T23:03:00+01:00","job":"a/four","status":"retry","owner":7}', // owner not string|null
      '', // blank line at end: not counted
    ];
    writeFileSync(join(dir, '2026-10-29.jsonl'), lines.join('\n') + '\n');
    expect(nightCounts(dir, '2026-10-29')).toEqual({ ok: 1, retry: 0, fail: 1, badLines: 4 });
  });

  it('rejects a night that is not YYYY-MM-DD as a caller error', () => {
    expect(() => nightCounts('runs', '../../etc/passwd')).toThrow(TypeError);
    expect(() => nightCounts('runs', '28-10-2026')).toThrow(TypeError);
  });
});

describe('status board (plan § 2c)', () => {
  const config = { adapter: 'shim', installed: '2026-10-29T14:06:00+01:00', beatEverySeconds: 60, runsDir: 'runs' };

  it('links each night on disk to its digest with its counts beside it', async () => {
    const res = await createApp(config).request('/');
    const html = await res.text();
    expect(html).toContain('<a href="/digest/2026-10-28">2026-10-28</a>');
    expect(html).toContain('ok 10 · retry 4 · fail 1');
    expect(html).toContain('<a href="/digest/2026-10-27">2026-10-27</a>');
    expect(html).toContain('ok 7 · retry 0 · fail 0');
  });

  it('an empty night renders its counts as 0s, not as missing', async () => {
    const dir = tempRunsDir();
    writeFileSync(join(dir, '2026-10-29.jsonl'), '');
    const res = await createApp({ ...config, runsDir: dir }).request('/');
    const html = await res.text();
    expect(html).toContain('<a href="/digest/2026-10-29">2026-10-29</a>');
    expect(html).toContain('ok 0 · retry 0 · fail 0');
  });
});
