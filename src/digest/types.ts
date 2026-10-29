// The morning digest contract (plan § 1). Everything in plan § 2 builds against this file.

// One line of the night's run log, aggregated. Times stay the raw strings from the
// log — the offset is kept, never converted (styleguide).
export type DigestRow = {
  job: string;
  // `null` when the log has no owner. Keep the row; display renders it as `—`.
  owner: string | null;
  runs: number; // lines counted for this job
  retries: number; // lines with status `retry`
  // first / last line of the job in file order (an append log is chronological):
  firstAt: string;
  lastAt: string;
  lastStatus: RunStatus; // status of the job's last line
  lastError: string | null; // error on that same line, `null` if it had none
};

export type RunStatus = 'ok' | 'retry' | 'fail';

export type NightDigest = {
  night: string; // the `YYYY-MM-DD` that was read
  rows: DigestRow[]; // one row per job, sorted by job name
  badLines: number; // lines that didn't parse — counted, never thrown
};

// Reads `<runsDir>/<night>.jsonl`.
//
// Missing file: returns `null`, never throws. That is the caller's signal for
// "no such night" (plan § 2a maps it to a 404). A file that exists but is
// empty returns a digest with `rows: []` and `badLines: 0` — "nothing ran" is
// the caller's rendering, not a missing night.
//
// Lines that don't match the log contract (`at`/`job`/`status`/`owner` with a
// bad shape, unparseable JSON) are counted in `badLines`, never thrown: the
// night still renders. A blank line is not a log line and is not counted.
// `owner` may be `null`; a missing `error` reads as `null`.
//
// A `night` that isn't `YYYY-MM-DD` is a caller error: throws `TypeError`.
export type ReadNight = (runsDir: string, night: string) => NightDigest | null;
