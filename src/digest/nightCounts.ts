// Per-night status counts for the board link (plan § 2c, issue #4). Purely
// additive: the DigestRow shape (types.ts) carries no per-status totals, and
// that file is #1's contract, so this file parses the night's log itself, at
// the edge, the same way read.ts does.
//
// The line contract is kept identical to read.ts on purpose: a line counts as
// an event here exactly when it becomes a row line there. That way the board's
// ok + retry + fail always equals the digest's total runs for the night, and
// badLines matches NightDigest.badLines — the pages can't disagree (ADR 0001).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunStatus } from './types.js';

const NIGHT_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type NightCounts = {
  ok: number; // lines with status `ok`
  retry: number; // lines with status `retry`
  fail: number; // lines with status `fail`
  badLines: number; // lines that don't match the log contract — counted, never thrown
};

// One board row: a night on disk and its counts beside the digest link.
export type NightBoardRow = {
  night: string;
  // null = no file for this night: the board renders `—` (styleguide, missing
  // data). A file that exists but is empty is NOT null — it is all-zero counts.
  counts: NightCounts | null;
};

// Same accept rules as parseLine in read.ts (owner/error stay in: a line with
// a non-string owner is a bad line there, so it must be one here too).
function parseStatus(line: string): RunStatus | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const fields: Record<string, unknown> = { ...parsed };
  const { at, job, status, owner, error } = fields;
  if (typeof at !== 'string' || typeof job !== 'string') return null;
  if (owner !== undefined && owner !== null && typeof owner !== 'string') return null;
  if (error !== undefined && error !== null && typeof error !== 'string') return null;
  if (status === 'ok' || status === 'retry' || status === 'fail') return status;
  return null;
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT';
}

// Reads `<runsDir>/<night>.jsonl` and totals it per status.
// Missing file: returns null, never throws (see NightBoardRow.counts).
// A `night` that isn't YYYY-MM-DD is a caller error: throws TypeError.
export function nightCounts(runsDir: string, night: string): NightCounts | null {
  if (!NIGHT_PATTERN.test(night)) {
    throw new TypeError(`nightCounts: night must be YYYY-MM-DD, got "${night}"`);
  }

  let text: string;
  try {
    text = readFileSync(join(runsDir, `${night}.jsonl`), 'utf8');
  } catch (err) {
    if (isNotFound(err)) return null; // no such night on disk
    throw err;
  }

  const counts: NightCounts = { ok: 0, retry: 0, fail: 0, badLines: 0 };
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue; // a blank line is not a log line
    const status = parseStatus(line);
    if (status === null) counts.badLines += 1;
    else counts[status] += 1;
  }
  return counts;
}

// The board rows for the nights status.ts found on disk, in their order.
// The view stays pure (styleguide): the app calls this and passes the result in.
export function boardNights(runsDir: string, nights: readonly string[]): NightBoardRow[] {
  return nights.map((night) => ({ night, counts: nightCounts(runsDir, night) }));
}
