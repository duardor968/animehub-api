import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';

const database = process.env.TEST_DATABASE_URL;
if (!database) throw new Error('TEST_DATABASE_URL is required');
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(database).hostname)) {
  throw new Error('The shutdown test requires an isolated local test database');
}

const port = process.env.SHUTDOWN_TEST_PORT ?? '18080';
const child = spawn(process.execPath, ['dist/main.js'], {
  env: {
    ...process.env,
    DATABASE_URL: database,
    PORT: port,
    JOBS_ENABLED: 'true',
    ANIMEAV1_BASE_URL: 'http://127.0.0.1:9',
    LOG_LEVEL: 'silent',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
let exited = false;
for (const stream of [child.stdout, child.stderr]) {
  stream.on('data', (chunk) => {
    output = `${output}${chunk}`.slice(-16000);
  });
}
const completion = new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', (code, signal) => {
    exited = true;
    resolve({ code, signal });
  });
});

try {
  let ready = false;
  const deadline = performance.now() + 30000;
  while (performance.now() < deadline && !exited) {
    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/v1/health/ready`,
        { signal: AbortSignal.timeout(1000) },
      );
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      // The server may still be starting.
    }
    await delay(100);
  }
  if (!ready) throw new Error('API did not become ready');
  const started = performance.now();
  child.kill('SIGTERM');
  const timeout = new AbortController();
  let result;
  try {
    result = await Promise.race([
      completion,
      delay(40000, null, { signal: timeout.signal }).then(() => {
        throw new Error('API did not stop within 40 seconds');
      }),
    ]);
  } finally {
    timeout.abort();
  }
  if (result.code !== 0 && result.signal !== 'SIGTERM') {
    throw new Error(`Unexpected API exit: ${JSON.stringify(result)}`);
  }
  console.log(
    `API reached database readiness with jobs enabled and stopped after SIGTERM in ${Math.round(performance.now() - started)} ms.`,
  );
} catch (error) {
  if (!exited) child.kill('SIGKILL');
  await completion;
  console.error(output);
  throw error;
}
