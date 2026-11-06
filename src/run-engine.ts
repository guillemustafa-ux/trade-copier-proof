import type { Book } from '../sim/book.js';
import { RemoteClock } from './clock.js';
import type { CrashPoint } from './crash.js';
import { Engine } from './engine.js';

/** One engine process for the crash tests: start, work until idle, exit. All state is in Postgres. */
const env = (name: string) => (process.env[name] || '').replace(/"/g, '');

const simUrl = env('SIM_URL');
const clock = new RemoteClock(simUrl);
await clock.sync();

const crashAt = env('CRASH_AT') as CrashPoint | '';
const engine = new Engine({
  databaseUrl: env('DATABASE_URL'),
  clock,
  apiUrl: `${simUrl}/v1`,
  wsUrl: env('SIM_WS_URL'),
  book: JSON.parse(process.env.BOOK ?? '{}') as Book,
  concurrency: 1, // one request per login at a time, so each checkpoint interrupts a fan-out in progress
  ...(crashAt ? { crash: { at: crashAt, after: Number(env('CRASH_AFTER')) } } : {}),
});
await engine.init();
await engine.start();
await engine.runUntilIdle();
console.log('engine: idle');
await engine.stop();
