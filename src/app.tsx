import { Hono } from 'hono';
import { boardNights } from './digest/nightCounts.js';
import { loadConfig, type RigConfig } from './config.js';
import { lane } from './lane.js';
import { readStatus } from './status.js';
import { Layout } from './views/layout.js';
import { StatusBoard } from './views/status.js';

export function createApp(config: RigConfig = loadConfig()) {
  const app = new Hono();

  app.get('/health', (c) => c.json({ ok: true, lane: lane().id }));

  app.get('/', (c) => {
    const status = readStatus(config);
    return c.html(
      <Layout title="status" lane={lane()}>
        {/* issue #4 (plan § 2c): each night links to its digest, ok/retry/fail beside it */}
        <StatusBoard status={status} nights={boardNights(config.runsDir, status.nights)} />
      </Layout>,
    );
  });

  return app;
}
