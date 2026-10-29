import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readNight } from '../src/digest/read.js';
import type { NightDigest } from '../src/digest/types.js';

// runs/ is read-only; anything synthetic goes in a temp dir (AGENTS.md).
function tempRunsDir(): string {
  return mkdtempSync(join(tmpdir(), 'rig-digest-'));
}

function digestOf(runsDir: string, night: string): NightDigest {
  const digest = readNight(runsDir, night);
  if (digest === null) throw new Error(`expected a digest for ${night} in ${runsDir}`);
  return digest;
}

describe('readNight on runs/2026-10-28.jsonl (the fixture with one bad line)', () => {
  const digest = digestOf('runs', '2026-10-28');

  it('has exactly 5 job rows and counts the 1 unparseable line, never throwing', () => {
    expect(digest.night).toBe('2026-10-28');
    expect(digest.rows).toHaveLength(5);
    expect(digest.badLines).toBe(1);
  });

  it('aggregates each job: owner, runs, retries, last status/error, first/last time', () => {
    expect(digest.rows).toEqual([
      {
        job: 'digest/render',
        owner: null, // kept as a row; display renders '—'
        runs: 1,
        retries: 0,
        firstAt: '2026-10-29T05:41:09+01:00',
        lastAt: '2026-10-29T05:41:09+01:00',
        lastStatus: 'ok',
        lastError: null,
      },
      {
        job: 'fixtures/refresh',
        owner: 'rook',
        runs: 4,
        retries: 3,
        firstAt: '2026-10-29T01:30:00+01:00',
        lastAt: '2026-10-29T01:37:00+01:00',
        lastStatus: 'ok',
        lastError: null,
      },
      {
        job: 'lane/sync',
        owner: 'rook',
        runs: 8,
        retries: 1,
        firstAt: '2026-10-28T23:00:06+01:00',
        lastAt: '2026-10-29T05:00:04+01:00',
        lastStatus: 'ok',
        lastError: null,
      },
      {
        job: 'notes/backup',
        owner: 'lane-07',
        runs: 1,
        retries: 0,
        firstAt: '2026-10-29T04:00:01+01:00',
        lastAt: '2026-10-29T04:00:01+01:00',
        lastStatus: 'fail',
        lastError: 'quota exceeded',
      },
      {
        job: 'rig/rotate-logs',
        owner: 'lane-07',
        runs: 1,
        retries: 0,
        firstAt: '2026-10-28T23:00:02+01:00',
        lastAt: '2026-10-28T23:00:02+01:00',
        lastStatus: 'ok',
        lastError: null,
      },
    ]);
  });

  it('keeps the offsets in the times, never converts them', () => {
    for (const row of digest.rows) {
      expect(row.firstAt).toMatch(/\+01:00$/);
      expect(row.lastAt).toMatch(/\+01:00$/);
    }
  });
});

describe('readNight on runs/2026-10-27.jsonl (a clean night)', () => {
  it('renders too: 4 jobs, no bad lines', () => {
    const digest = digestOf('runs', '2026-10-27');
    expect(digest.badLines).toBe(0);
    expect(digest.rows.map((row) => row.job)).toEqual([
      'fixtures/refresh',
      'lane/sync',
      'notes/backup',
      'rig/rotate-logs',
    ]);
    const laneSync = digest.rows.find((row) => row.job === 'lane/sync');
    expect(laneSync).toMatchObject({ runs: 4, retries: 0, lastStatus: 'ok' });
  });
});

describe('readNight edge cases (temp dirs only)', () => {
  it('a night with no file returns null', () => {
    expect(readNight('runs', '2026-10-26')).toBeNull();
    expect(readNight(tempRunsDir(), '2026-10-28')).toBeNull(); // no such runs dir either
  });

  it('an empty file is a digest with no rows, not a missing night', () => {
    const dir = tempRunsDir();
    writeFileSync(join(dir, '2026-10-29.jsonl'), '');
    const digest = digestOf(dir, '2026-10-29');
    expect(digest.rows).toEqual([]);
    expect(digest.badLines).toBe(0);
  });

  it('counts lines that break the contract, keeps the good ones', () => {
    const dir = tempRunsDir();
    const lines = [
      '{"at":"2026-10-29T23:00:00+01:00","job":"a/one","status":"ok","owner":"rook"}',
      'not json at all, like the real truncated fixture',
      '{"at":"2026-10-29T23:01:00+01:00","job":"a/one","status":"skipped","owner":"rook"}', // unknown status
      '{"job":"a/two","status":"ok","owner":"rook"}', // no at
      '{"at":"2026-10-29T23:02:00+01:00","job":"a/three","status":"ok","owner":7}', // owner not string|null
      '"a string is not a log line"',
      '{"at":"2026-10-29T23:03:00+01:00","job":"a/one","status":"retry","owner":null,"error":"again"}',
      '', // blank line at end: not counted
    ];
    writeFileSync(join(dir, '2026-10-29.jsonl'), lines.join('\n') + '\n');
    const digest = digestOf(dir, '2026-10-29');
    expect(digest.badLines).toBe(5);
    // only a/one survives: a/three's single line had a non-string owner.
    expect(digest.rows).toHaveLength(1);
    expect(digest.rows[0]).toMatchObject({
      job: 'a/one',
      runs: 2,
      retries: 1,
      owner: null, // last line's owner wins
      lastStatus: 'retry',
      lastError: 'again',
    });
  });

  it('rejects a night that is not YYYY-MM-DD as a caller error', () => {
    expect(() => readNight('runs', '../../etc/passwd')).toThrow(TypeError);
    expect(() => readNight('runs', '28-10-2026')).toThrow(TypeError);
  });
});
