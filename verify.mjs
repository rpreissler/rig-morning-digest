// verify.mjs — the lane's own closing gate. No model, no prompt: it boots the service,
// reads the nights from runs/, and asserts that the page, the JSON and the log on disk
// agree. Run it before closing an issue; exit 0 means every check held.
//
//   node verify.mjs            # every night on disk
//   node verify.mjs 2026-10-28 # one night
//
// Needs Node 22 or newer. Reads .env for LANE_ID and LANE_MARKER, never prints them.
// The row model below is a second, independent implementation of the log contract, on
// purpose: it re-derives the expected rows from the raw file instead of importing
// src/digest/read.ts, so a change to the reader has to be matched here to stay green.

import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';

const NIGHT_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES = new Set(['ok', 'retry', 'fail']);

let failures = 0;
let checks = 0;
function check(name, ok, detail = '') {
  checks += 1;
  if (ok) console.log(`PASS ${name}`);
  else {
    failures += 1;
    console.log(`FAIL ${name}${detail ? `: ${detail}` : ''}`);
  }
}

// ---- .env ----

function readEnv(file) {
  const out = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

// ---- the log contract, re-derived here ----

function parseLine(line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { at, job, status, owner, error } = parsed;
  if (typeof at !== 'string' || typeof job !== 'string') return null;
  if (typeof status !== 'string' || !STATUSES.has(status)) return null;
  const strOrNull = (v) => (v === undefined || v === null ? null : typeof v === 'string' ? v : undefined);
  if (strOrNull(owner) === undefined || strOrNull(error) === undefined) return null;
  return { at, job, status, owner: strOrNull(owner), error: strOrNull(error) };
}

function expectedDigest(runsDir, night) {
  let text;
  try {
    text = readFileSync(`${runsDir}/${night}.jsonl`, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  const byJob = new Map();
  let badLines = 0;
  const counts = { ok: 0, retry: 0, fail: 0 };
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const run = parseLine(line);
    if (run === null) {
      badLines += 1;
      continue;
    }
    counts[run.status] += 1;
    const row = byJob.get(run.job);
    if (row === undefined) {
      byJob.set(run.job, {
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
      row.owner = run.owner;
      row.lastAt = run.at;
      row.lastStatus = run.status;
      row.lastError = run.error;
    }
  }
  const rows = [...byJob.values()].sort((a, b) => (a.job < b.job ? -1 : a.job > b.job ? 1 : 0));
  return { night, rows, badLines, counts };
}

// ---- page reading ----

function decodeEntities(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function digestRows(html) {
  const body = html.match(/<tbody>([\s\S]*?)<\/tbody>/);
  if (body === null) return [];
  return (body[1].match(/<tr[\s\S]*?<\/tr>/g) ?? []).map((tr) => ({
    warn: /<tr[^>]*\bclass="warn"/.test(tr),
    cells: (tr.match(/<td[^>]*>([\s\S]*?)<\/td>/g) ?? []).map((td) =>
      decodeEntities(td.replace(/^<td[^>]*>/, '').replace(/<\/td>$/, '').trim()),
    ),
  }));
}

function boardNights(html) {
  const out = [];
  for (const m of html.matchAll(/<a href="\/digest\/(\d{4}-\d{2}-\d{2})">[^<]*<\/a>[\s\S]*?(?=<li>|<\/ul>)/g)) {
    const counts = m[0].match(/ok (\d+) · retry (\d+) · fail (\d+)/);
    out.push({
      night: m[1],
      counts: counts ? { ok: Number(counts[1]), retry: Number(counts[2]), fail: Number(counts[3]) } : null,
    });
  }
  return out;
}

// ---- server ----

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function waitUntilHealthy(base, ms) {
  const deadline = Date.now() + ms;
  return (async () => {
    for (;;) {
      try {
        const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) });
        if (res.ok) return await res.json();
      } catch {
        // not up yet
      }
      if (Date.now() > deadline) return null;
      await new Promise((r) => setTimeout(r, 100));
    }
  })();
}

async function startServer(env, port) {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'src/server.ts'],
    {
      env: { ...process.env, ...env, PORT: String(port), LANE_MARKER: env.LANE_MARKER ?? '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const log = [];
  child.stdout.on('data', (d) => log.push(String(d)));
  child.stderr.on('data', (d) => log.push(String(d)));
  const stop = () => {
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 2000).unref();
  };
  return { stop, output: () => log.join('').trim() };
}

// ---- main ----

const [, , nightArg] = process.argv;
if (Number(process.versions.node.split('.')[0]) < 22) {
  console.log('FAIL node 22 or newer: this harness runs node ' + process.versions.node);
  console.log('result: fail');
  process.exit(1);
}

const env = readEnv('.env');
if ((env.LANE_MARKER ?? '').trim() === '') {
  console.log('note: LANE_MARKER is not set in .env — the banner reads "no marker set"');
}
const marker = (env.LANE_MARKER ?? '').trim() || 'no marker set';

const runsDir = JSON.parse(readFileSync('rig.json', 'utf8')).runsDir ?? 'runs';
const onDisk = readdirSync(runsDir)
  .filter((f) => NIGHT_PATTERN.test(f.slice(0, 10)) && f.endsWith('.jsonl'))
  .map((f) => f.slice(0, 10))
  .sort();
const nights = nightArg === undefined ? onDisk : [nightArg];

const port = await freePort();
const server = await startServer(env, port);
const base = `http://127.0.0.1:${port}`;

try {
  const health = await waitUntilHealthy(base, 10000);
  if (health === null) {
    check('service starts and answers /health', false, server.output() || 'no response in 10s');
    console.log('result: fail');
    process.exit(1);
  }
  check('service starts and answers /health', health.ok === true, JSON.stringify(health));
  if ((env.LANE_ID ?? '').trim() !== '') {
    check('health names the lane from .env', health.lane === env.LANE_ID.trim(), `got ${health.lane}`);
  }

  for (const night of nights) {
    if (!NIGHT_PATTERN.test(night)) {
      console.log(`FAIL night ${night} is not YYYY-MM-DD`);
      failures += 1;
      continue;
    }
    const want = expectedDigest(runsDir, night);

    const jsonRes = await fetch(`${base}/api/digest/${night}`);
    if (want === null) {
      check(`${night} missing log → JSON 404, never 500`, jsonRes.status === 404, `got ${jsonRes.status}`);
      const pageRes = await fetch(`${base}/digest/${night}`);
      check(`${night} missing log → page 404, never 500`, pageRes.status === 404, `got ${pageRes.status}`);
      continue;
    }
    if (!jsonRes.ok) {
      check(`${night} JSON digest`, false, `HTTP ${jsonRes.status}`);
      continue;
    }
    const got = await jsonRes.json();

    check(
      `${night} rows match the log, job by job`,
      JSON.stringify(got.rows) === JSON.stringify(want.rows),
      `want ${want.rows.length} rows / got ${got.rows.length}`,
    );
    check(
      `${night} rows sorted by job`,
      got.rows.every((r, i, a) => i === 0 || a[i - 1].job <= r.job),
    );
    check(`${night} badLines match`, got.badLines === want.badLines, `want ${want.badLines} / got ${got.badLines}`);
    check(
      `${night} runs, retries and status stay in range`,
      got.rows.every((r) => r.runs >= 1 && r.retries >= 0 && r.retries <= r.runs && STATUSES.has(r.lastStatus)),
    );
    check(
      `${night} firstAt is never after lastAt`,
      got.rows.every((r) => new Date(r.firstAt).getTime() <= new Date(r.lastAt).getTime()),
    );

    const pageRes = await fetch(`${base}/digest/${night}`);
    const html = await pageRes.text();
    check(`${night} page answers 200`, pageRes.status === 200, `got ${pageRes.status}`);
    const rows = digestRows(html);
    check(
      `${night} page shows the same rows in the same order as the JSON`,
      rows.length === got.rows.length && rows.every((r, i) => r.cells[0] === got.rows[i].job),
      `page ${rows.length} / json ${got.rows.length}`,
    );
    check(
      `${night} page cells carry runs, retries and last status of each row`,
      rows.every((r, i) => {
        const row = got.rows[i];
        if (row === undefined) return false;
        const marked = row.retries >= 3 || row.lastStatus === 'fail';
        const retriesCell = String(row.retries) + (row.retries >= 3 ? ' (!)' : '');
        const statusCell = row.lastStatus + (row.lastStatus === 'fail' ? ' (!)' : '');
        return r.cells[2] === String(row.runs) && r.cells[3] === retriesCell && r.cells[4] === statusCell && r.warn === marked;
      }),
    );
    const markerHits = html.split(marker).length - 1;
    check(`${night} page carries the lane marker exactly once`, markerHits === 1, `found ${markerHits}`);

    check(`${night} page links back to the status board`, /href="\/"/.test(html));
  }

  const boardRes = await fetch(`${base}/`);
  const boardHtml = await boardRes.text();
  check('status board answers 200', boardRes.status === 200, `got ${boardRes.status}`);
  const listed = boardNights(boardHtml);
  check(
    'board lists every night on disk',
    nights.every((n) => onDisk.includes(n) === listed.some((l) => l.night === n)),
    `disk ${onDisk.join(', ')} / board ${listed.map((l) => l.night).join(', ')}`,
  );
  for (const l of listed) {
    const want = expectedDigest(runsDir, l.night);
    if (want === null) {
      check(`board ${l.night} with no file shows —`, l.counts === null);
      continue;
    }
    check(
      `board ${l.night} counts equal the log`,
      l.counts !== null && l.counts.ok === want.counts.ok && l.counts.retry === want.counts.retry && l.counts.fail === want.counts.fail,
      `want ok ${want.counts.ok} retry ${want.counts.retry} fail ${want.counts.fail}`,
    );
    check(
      `board ${l.night} counts equal the digest rows (${l.night})`,
      l.counts !== null && want.rows.reduce((s, r) => s + r.runs, 0) === l.counts.ok + l.counts.retry + l.counts.fail,
    );
  }
  const boardMarkerHits = boardHtml.split(marker).length - 1;
  check(`board carries the lane marker exactly once`, boardMarkerHits === 1, `found ${boardMarkerHits}`);

  // A plain `..` never reaches the service: the URL layer resolves it before the request
  // goes out. So traversal is tested in its encoded form, which does arrive as `../`.
  for (const bad of [
    '2026-13-45',
    'not-a-night',
    '..%2F..%2Frig.json',
    '%2e%2e%2fruns%2f2026-10-28.jsonl',
    '2026-10-28%00',
    '2026-10-28%2f..%2f..%2fetc%2fpasswd',
  ]) {
    const res = await fetch(`${base}/api/digest/${bad}`);
    check(`JSON ${bad} → 404, never 500`, res.status === 404, `got ${res.status}`);
  }

  // The URL layer folds `<night>/../<other>` to `<other>` before the request leaves, so a
  // path that looks like traversal is a plain read of another night. Assert it can only ever
  // answer with a night page, never with file contents.
  const foldTarget = onDisk.includes(nights[0]) ? onDisk.filter((n) => n !== nights[0])[0] ?? nights[0] : onDisk[0];
  const foldedRes = await fetch(`${base}/digest/${nights[0]}/../${foldTarget}`);
  const foldedText = await foldedRes.text();
  check(
    'a folded path answers with a night page or nothing, never with a file',
    foldedRes.status === 404 || /<span class="marker">|no digest for/.test(foldedText),
    `got ${foldedRes.status}`,
  );
} finally {
  server.stop();
}

console.log(failures === 0 ? `result: ok (${checks} checks)` : `result: fail (${failures} of ${checks} checks)`);
process.exit(failures === 0 ? 0 : 1);
