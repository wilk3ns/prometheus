#!/usr/bin/env node
import { serve } from '@hono/node-server';
import { loadAiConfig, loadCoreConfig } from '@prometheus/config';
import { openCoreRuntime } from './bootstrap.js';
import { buildApp } from './http/app.js';

/** apps/core entry: Hono on @hono/node-server, loopback only (dev/test endpoints; ENG-T2 §1). */
async function main(): Promise<void> {
  const config = loadCoreConfig(process.env);
  const runtime = await openCoreRuntime(config, loadAiConfig(process.env));
  const server = serve(
    { fetch: buildApp(runtime).fetch, port: config.httpPort, hostname: '127.0.0.1' },
    (info) => console.log(JSON.stringify({ service: 'core', listening: `http://127.0.0.1:${info.port}` })),
  );
  const stop = (): void => {
    server.close();
    void runtime.close();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
  process.exitCode = 1;
});
