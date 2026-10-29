import { Hono } from 'hono';
import { loadConfig, type RigConfig } from './config.js';
import { readNight } from './digest/read.js';
import type { NightDigest } from './digest/types.js';
import { lane } from './lane.js';
import { readStatus } from './status.js';
import { DigestPage, NoDigest } from './views/digest.js';
import { Layout } from './views/layout.js';
import { StatusBoard } from './views/status.js';

export function createApp(config: RigConfig = loadConfig()) {
  const app = new Hono();

  app.get('/health', (c) => c.json({ ok: true, lane: lane().id }));

  app.get('/', (c) =>
    c.html(
      <Layout title="status" lane={lane()}>
        <StatusBoard status={readStatus(config)} />
      </Layout>,
    ),
  );

  app.get('/digest/:night', (c) => {
    const night = c.req.param('night');
    let digest: NightDigest | null = null;
    try {
      digest = readNight(config.runsDir, night);
    } catch (err) {
      // A bad :night isn't a 500: readNight throws TypeError on non-YYYY-MM-DD.
      if (!(err instanceof TypeError)) throw err;
    }
    if (digest === null) {
      return c.html(
        <Layout title="digest" lane={lane()}>
          <NoDigest night={night} />
        </Layout>,
        404,
      );
    }
    return c.html(
      <Layout title={`digest · ${night}`} lane={lane()}>
        <DigestPage digest={digest} />
      </Layout>,
    );
  });

  // Plan § 2b. The reader's rows verbatim, in the reader's order (sorted by job):
  // the page and this JSON must never disagree (ADR 0001). A night with no file
  // and a night that isn't YYYY-MM-DD (readNight throws TypeError) are both 404,
  // never 500.
  app.get('/api/digest/:night', (c) => {
    const night = c.req.param('night');
    try {
      const digest = readNight(config.runsDir, night);
      if (digest === null) return c.json({ error: `no digest for ${night}` }, 404);
      return c.json(digest);
    } catch (err) {
      if (err instanceof TypeError) return c.json({ error: 'night must be YYYY-MM-DD' }, 404);
      throw err;
    }
  });

  return app;
}
