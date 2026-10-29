import type { DigestRow, NightDigest } from '../digest/types.js';
import { hasManyRetries, lastRunFailed, needsAttention } from '../digest/mark.js';

// The digest page (plan § 2a): one table, one row per job, sorted by job —
// readNight already sorts. Times render raw from the log, offsets kept (styleguide).
const DASH = '—'; // missing data never shows as an empty cell (styleguide)

function DigestRowView({ row }: { row: DigestRow }) {
  return (
    <tr class={needsAttention(row) ? 'warn' : undefined}>
      <td>{row.job}</td>
      <td>{row.owner ?? DASH}</td>
      <td>{row.runs}</td>
      <td>
        {row.retries}
        {hasManyRetries(row) ? ' (!)' : ''}
      </td>
      <td>
        {row.lastStatus}
        {lastRunFailed(row) ? ' (!)' : ''}
      </td>
      <td>{row.lastError ?? DASH}</td>
      <td>{row.firstAt}</td>
      <td>{row.lastAt}</td>
    </tr>
  );
}

export function DigestPage({ digest }: { digest: NightDigest }) {
  return (
    <>
      <h1>digest · {digest.night}</h1>
      {digest.rows.length === 0 ? (
        <p class="mute">nothing ran</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>job</th>
              <th>owner</th>
              <th>runs</th>
              <th>retries</th>
              <th>last status</th>
              <th>last error</th>
              <th>first</th>
              <th>last</th>
            </tr>
          </thead>
          <tbody>
            {digest.rows.map((row) => (
              <DigestRowView row={row} />
            ))}
          </tbody>
        </table>
      )}
      {digest.badLines > 0 && (
        <p class="mute">
          {digest.badLines} {digest.badLines === 1 ? 'line' : 'lines'} did not parse and {digest.badLines === 1 ? 'was' : 'were'} not counted.
        </p>
      )}
      <p>
        <a href="/">status board</a>
      </p>
    </>
  );
}

// 404 body: no file for a well-formed night, or a `:night` that isn't one.
export function NoDigest({ night }: { night: string }) {
  return (
    <>
      <h1>digest</h1>
      <p class="warn">no digest for {night}</p>
      <p class="mute">
        A night is <code>YYYY-MM-DD</code>. The <a href="/">status board</a> lists the nights on disk.
      </p>
    </>
  );
}
