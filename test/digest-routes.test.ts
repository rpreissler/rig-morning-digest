import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { RigConfig } from '../src/config.js';
import { readNight } from '../src/digest/read.js';
import { nightCounts } from '../src/digest/nightCounts.js';
import type { NightDigest } from '../src/digest/types.js';

// Route tests for plan § 2d: the digest page (#2) and its JSON (#3) through
// app.request() (styleguide). runs/ is read-only (AGENTS.md): every fixture
// here is a synthetic night file in one temp dir, removed in afterAll.

const tempDir = mkdtempSync(join(tmpdir(), 'rig-digest-routes-'));

const NORMAL = '2026-10-28'; // a night with rows
const EMPTY = '2026-10-30'; // a file that exists but is empty: "nothing ran"
const BAD = '2026-10-31'; // good lines beside lines that break the contract
const MISSING = '2026-11-01'; // no file at all → 404

const config: RigConfig = {
  adapter: 'shim',
  installed: '2026-10-29T14:06:00+01:00',
  beatEverySeconds: 60,
  runsDir: tempDir,
};
const app = createApp(config);

beforeAll(() => {
  writeFileSync(
    join(tempDir, `${NORMAL}.jsonl`),
    [
      `{"at":"${NORMAL}T23:10:00+01:00","job":"build/api","status":"ok","owner":"rook"}`,
      `{"at":"${NORMAL}T23:20:00+01:00","job":"build/ui","status":"retry","owner":"lane-07"}`,
      `{"at":"${NORMAL}T23:25:00+01:00","job":"build/ui","status":"ok","owner":"lane-07"}`,
      `{"at":"${NORMAL}T23:30:00+01:00","job":"clean/tmp","status":"fail","owner":null,"error":"locked"}`,
      '',
    ].join('\n'),
  );
  writeFileSync(join(tempDir, `${EMPTY}.jsonl`), '');
  writeFileSync(
    join(tempDir, `${BAD}.jsonl`),
    [
      `{"at":"${BAD}T01:00:00+01:00","job":"night/report","status":"ok","owner":"rook"}`,
      'this line is not json, like a real truncated write',
      `{"at":"${BAD}T01:02:00+01:00","job":"night/report","status":"retry","owner":"rook"}`,
      `{"at":"${BAD}T01:03:00+01:00","job":"night/report","status":"ok","owner":"rook"}`,
      '{"job":"missing/at","status":"ok"}', // no at
      '',
    ].join('\n'),
  );
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true }); // the mkdtemp root
});

// The page's job column, in row order: the first <td> of each body row.
function jobsInPage(html: string): string[] {
  const body = html.match(/<tbody>([\s\S]*?)<\/tbody>/);
  if (body === null) return [];
  return [...body[1].matchAll(/<tr[^>]*>\s*<td>([^<]+)<\/td>/g)].map((m) => m[1] ?? '');
}

// The board's "ok N · retry N · fail N" beside each night link, keyed by night.
function boardCounts(html: string): Map<string, { ok: number; retry: number; fail: number }> {
  const rows = new Map<string, { ok: number; retry: number; fail: number }>();
  for (const li of html.split('<li>')) {
    const night = li.match(/<a href="\/digest\/([\d-]+)">/)?.[1];
    const counts = li.match(/ok (\d+) · retry (\d+) · fail (\d+)/);
    if (night !== undefined && counts !== null) {
      rows.set(night, { ok: Number(counts[1]), retry: Number(counts[2]), fail: Number(counts[3]) });
    }
  }
  return rows;
}

describe('GET /digest/:night (the page, plan § 2a)', () => {
  it('renders a normal night: 200, one row per job sorted by job', async () => {
    const res = await app.request(`/digest/${NORMAL}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain(`digest · ${NORMAL}`);
    expect(jobsInPage(html)).toEqual(['build/api', 'build/ui', 'clean/tmp']);
    expect(html).toContain('—'); // null owner shows as —, never an empty cell (styleguide)
    expect(html).toContain('class="warn"'); // the fail row is marked (plan § 2a)
  });

  it('404 for a night with no file', async () => {
    const res = await app.request(`/digest/${MISSING}`);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain(`no digest for ${MISSING}`);
  });

  it('an empty night is a 200 that says "nothing ran", not a missing night', async () => {
    const res = await app.request(`/digest/${EMPTY}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('nothing ran');
    expect(jobsInPage(html)).toEqual([]);
  });

  it('a night with a bad line still renders: good rows present, bad lines counted not thrown', async () => {
    const res = await app.request(`/digest/${BAD}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(jobsInPage(html)).toEqual(['night/report']);
    expect(html).toContain('2 lines did not parse and were not counted');
  });

  it('a bad :night format is a 404, never a 500', async () => {
    for (const bad of ['x', '28-10-2026', encodeURIComponent('../etc/passwd')]) {
      const res = await app.request(`/digest/${bad}`);
      expect(res.status, `night "${bad}"`).toBe(404);
      // reaches the route handler: readNight's TypeError is caught, NoDigest renders
      expect(await res.text(), `body for "${bad}"`).toContain(`no digest for ${decodeURIComponent(bad)}`);
    }
    // the raw form normalizes away from the route before matching; still a 404, never a 500
    const raw = await app.request('/digest/../etc/passwd');
    expect(raw.status).toBe(404);
  });
});

describe('GET /api/digest/:night (the JSON, plan § 2b)', () => {
  it('200 on a normal night with the reader\'s rows, sorted by job', async () => {
    const jsonRes = await app.request(`/api/digest/${NORMAL}`);
    expect(jsonRes.status).toBe(200);
    expect(jsonRes.headers.get('content-type')).toContain('application/json');
    const digest = (await jsonRes.json()) as NightDigest;
    expect(digest.night).toBe(NORMAL);
    expect(digest.badLines).toBe(0);
    expect(digest.rows.map((row) => row.job)).toEqual(['build/api', 'build/ui', 'clean/tmp']);
    const ui = digest.rows.find((row) => row.job === 'build/ui');
    expect(ui).toMatchObject({ owner: 'lane-07', runs: 2, retries: 1, lastStatus: 'ok' });
  });

  it('404 for a night with no file', async () => {
    const res = await app.request(`/api/digest/${MISSING}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: `no digest for ${MISSING}` });
  });

  it('an empty night answers 200 with empty rows', async () => {
    const res = await app.request(`/api/digest/${EMPTY}`);
    expect(res.status).toBe(200);
    const digest = (await res.json()) as NightDigest;
    expect(digest.rows).toEqual([]);
    expect(digest.badLines).toBe(0);
  });

  it('a night with a bad line still answers: rows for the good lines, badLines counted', async () => {
    const res = await app.request(`/api/digest/${BAD}`);
    expect(res.status).toBe(200);
    const digest = (await res.json()) as NightDigest;
    expect(digest.rows.map((row) => row.job)).toEqual(['night/report']);
    expect(digest.rows[0]).toMatchObject({ runs: 3, retries: 1, lastStatus: 'ok' });
    expect(digest.badLines).toBe(2);
  });

  it('a bad :night format is a 404, never a 500', async () => {
    for (const bad of ['x', '28-10-2026', encodeURIComponent('../etc/passwd')]) {
      const res = await app.request(`/api/digest/${bad}`);
      expect(res.status, `night "${bad}"`).toBe(404);
      // reaches the route handler: readNight's TypeError is caught, not thrown
      expect(await res.json(), `body for "${bad}"`).toEqual({ error: 'night must be YYYY-MM-DD' });
    }
    // the raw form normalizes away from the route before matching; still a 404, never a 500
    const raw = await app.request('/api/digest/../etc/passwd');
    expect(raw.status).toBe(404);
  });
});

describe('page and JSON never disagree (ADR 0001)', () => {
  it('same jobs, same order, for every kind of night', async () => {
    for (const night of [NORMAL, EMPTY, BAD]) {
      const page = await app.request(`/digest/${night}`);
      const json = await app.request(`/api/digest/${night}`);
      expect(page.status).toBe(200);
      expect(json.status).toBe(200);
      const digest = (await json.json()) as NightDigest;
      const fromReader = readNight(tempDir, night);
      if (fromReader === null) throw new Error(`expected a digest for ${night}`);
      expect(jobsInPage(await page.text()), `jobs on the page for ${night}`).toEqual(
        digest.rows.map((row) => row.job),
      );
      expect(digest.rows, `JSON rows for ${night}`).toEqual(fromReader.rows);
      expect(digest.badLines, `badLines for ${night}`).toBe(fromReader.badLines);
    }
  });

  it('the board\'s counts agree with the digest rows (ok + retry + fail = Σ runs, badLines equal)', async () => {
    const res = await app.request('/');
    expect(res.status).toBe(200);
    const board = boardCounts(await res.text());
    for (const night of [NORMAL, EMPTY, BAD]) {
      const digest = readNight(tempDir, night);
      const counts = board.get(night);
      if (digest === null || counts === undefined) throw new Error(`expected ${night} on both`);
      const totalRuns = digest.rows.reduce((sum, row) => sum + row.runs, 0);
      expect(counts.ok + counts.retry + counts.fail, `Σ runs for ${night}`).toBe(totalRuns);
      const reader = nightCounts(tempDir, night);
      if (reader === null) throw new Error(`expected counts for ${night}`);
      expect(reader.badLines, `badLines agree for ${night}`).toBe(digest.badLines);
    }
  });
});
