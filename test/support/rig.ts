import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { inject } from 'vitest';
import { makeBook, type Book } from '../../sim/book.js';
import type { FaultRule } from '../../sim/faults.js';
import { Simulator } from '../../sim/simulator.js';
import { VirtualClock } from '../../src/clock.js';
import type { CrashPoint } from '../../src/crash.js';
import { Engine, type EngineOptions, type Sizing } from '../../src/engine.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export interface RigOptions {
  logins?: number;
  accounts?: number;
  plan?: FaultRule[];
  sizing?: (accountId: number) => Sizing;
  evictStatus?: number;
  config?: Partial<EngineOptions>;
  /** Leave the engine unstarted, for tests that run it in a child process. */
  noEngine?: boolean;
}

export interface Rig {
  clock: VirtualClock;
  book: Book;
  sim: Simulator;
  engine: Engine;
  databaseUrl: string;
  close: () => Promise<void>;
}

export async function resetDatabase(url: string): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('drop schema public cascade; create schema public;');
  } finally {
    await client.end();
  }
}

export async function rig(opts: RigOptions = {}): Promise<Rig> {
  const databaseUrl = inject('databaseUrl');
  await resetDatabase(databaseUrl);
  const clock = new VirtualClock();
  const book = makeBook({ logins: opts.logins ?? 1, accounts: opts.accounts ?? 3 });
  const sim = new Simulator({
    clock,
    book,
    ...(opts.plan ? { plan: opts.plan } : {}),
    ...(opts.evictStatus ? { evictStatus: opts.evictStatus } : {}),
  });
  await sim.listen();
  const engine = new Engine({
    databaseUrl,
    clock,
    apiUrl: `${sim.url}/v1`,
    wsUrl: sim.wsUrl,
    book,
    ...(opts.sizing ? { sizing: opts.sizing } : {}),
    ...opts.config,
  });
  await engine.init();
  if (!opts.noEngine) await engine.start();
  return {
    clock,
    book,
    sim,
    engine,
    databaseUrl,
    close: async () => {
      await engine.stop();
      await sim.close();
    },
  };
}

export interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  completed: boolean;
  crashedAt: string | undefined;
  output: string;
}

/** Run the engine in a separate OS process: `node --import tsx src/run-engine.ts`. */
export function runEngineProcess(r: Rig, opts: { crashAt?: CrashPoint; crashAfter?: number } = {}): Promise<ChildExit> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/run-engine.ts'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        DATABASE_URL: r.databaseUrl,
        SIM_URL: r.sim.url,
        SIM_WS_URL: r.sim.wsUrl,
        BOOK: JSON.stringify(r.book),
        CRASH_AT: opts.crashAt ?? '',
        CRASH_AFTER: String(opts.crashAfter ?? 0),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (d: Buffer) => (output += d.toString()));
    child.stderr.on('data', (d: Buffer) => (output += d.toString()));
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      resolve({
        code,
        signal,
        completed: output.includes('engine: idle'),
        crashedAt: /crash: (\w+)/.exec(output)?.[1],
        output,
      });
    });
  });
}

/** How the OS reports a process that SIGKILLed itself: a signal on POSIX, exit code 1 on Windows. */
export function killedBySigkill(exit: ChildExit): boolean {
  return process.platform === 'win32' ? exit.code === 1 && exit.signal === null : exit.signal === 'SIGKILL';
}
