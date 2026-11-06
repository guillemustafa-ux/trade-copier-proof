import { writeSync } from 'node:fs';

/**
 * Fault injection for the crash tests. The engine process kills itself with SIGKILL at the
 * selected point: no `finally`, no shutdown hook, no chance to write anything else. A thrown
 * exception would let cleanup code run, which is exactly what a real crash does not.
 */
export const CRASH_POINTS = ['after_intent_write', 'after_send_before_ack', 'after_ack_before_commit', 'mid_fanout'] as const;
export type CrashPoint = (typeof CRASH_POINTS)[number];

export function crashNow(point: CrashPoint): void {
  writeSync(2, `crash: ${point}\n`); // synchronous, so the marker is out before the process dies
  process.kill(process.pid, 'SIGKILL');
}
