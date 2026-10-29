import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DigestRow, ReadNight, RunStatus } from './types.js';

const NIGHT_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// One run-log line after parsing at the edge; null means "doesn't match the
// contract" and the caller counts it as a bad line.
type RunLine = {
  at: string;
  job: string;
  status: RunStatus;
  owner: string | null;
  error: string | null;
};

function isRunStatus(value: string): value is RunStatus {
  return value === 'ok' || value === 'retry' || value === 'fail';
}

function parseLine(line: string): RunLine | null {
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
  if (typeof status !== 'string' || !isRunStatus(status)) return null;
  if (owner !== undefined && owner !== null && typeof owner !== 'string') return null;
  if (error !== undefined && error !== null && typeof error !== 'string') return null;
  return { at, job, status, owner: typeof owner === 'string' ? owner : null, error: typeof error === 'string' ? error : null };
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT';
}

// Aggregation is in file order (an append log is chronological): a row's
// firstAt/lastAt/lastStatus/lastError come from its job's first and last line.
export const readNight: ReadNight = (runsDir, night) => {
  if (!NIGHT_PATTERN.test(night)) {
    throw new TypeError(`readNight: night must be YYYY-MM-DD, got "${night}"`);
  }

  let text: string;
  try {
    text = readFileSync(join(runsDir, `${night}.jsonl`), 'utf8');
  } catch (err) {
    if (isNotFound(err)) return null; // no such night — see types.ts
    throw err;
  }

  const rows = new Map<string, DigestRow>();
  let badLines = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue; // a blank line is not a log line
    const run = parseLine(line);
    if (run === null) {
      badLines += 1;
      continue;
    }
    const row = rows.get(run.job);
    if (row === undefined) {
      rows.set(run.job, {
        job: run.job,
        owner: run.owner,
        runs: 1,
        retries: run.status === 'retry' ? 1 : 0,
        firstAt: run.at,
        lastAt: run.at,
        lastStatus: run.status,
        lastError: run.error,
      });
    } else {
      row.runs += 1;
      if (run.status === 'retry') row.retries += 1;
      row.owner = run.owner; // current owner = owner on the job's last line
      row.lastAt = run.at;
      row.lastStatus = run.status;
      row.lastError = run.error;
    }
  }

  return {
    night,
    rows: [...rows.values()].sort((a, b) => (a.job < b.job ? -1 : a.job > b.job ? 1 : 0)),
    badLines,
  };
};
