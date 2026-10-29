import type { DigestRow } from './types.js';

// What the digest page marks (plan § 2a): 3 or more retries, or a last line of
// `fail`. One place for the rule so every view that marks rows agrees (ADR 0001:
// a fetch and a screenshot must show the same thing — the page marks via these,
// the JSON returns the rows they are computed from).

const RETRY_MARK = 3;

export function hasManyRetries(row: DigestRow): boolean {
  return row.retries >= RETRY_MARK;
}

export function lastRunFailed(row: DigestRow): boolean {
  return row.lastStatus === 'fail';
}

export function needsAttention(row: DigestRow): boolean {
  return hasManyRetries(row) || lastRunFailed(row);
}
