/**
 * All time in the engine and the simulator comes from one injected clock, so penalties, token
 * expiry and grace windows are deterministic. Waiting is `advanceTo`: a virtual clock jumps, a
 * real deployment would sleep. Nothing here reads the wall clock.
 */
export interface Clock {
  now(): number;
  advanceTo(t: number): Promise<void>;
}

/** Fixed start, so report timestamps never vary between runs. */
export const EPOCH = Date.UTC(2026, 10, 2, 14, 30, 0);

export class VirtualClock implements Clock {
  constructor(private t: number = EPOCH) {}
  now(): number {
    return this.t;
  }
  async advanceTo(t: number): Promise<void> {
    if (t > this.t) this.t = t;
  }
}

/**
 * The same clock seen from another process: the crash tests run the engine in a child process
 * while the simulator lives in the test process. Only one side advances at a time, so the cached
 * value stays correct between calls.
 */
export class RemoteClock implements Clock {
  private t = 0;
  constructor(private readonly controlUrl: string) {}
  async sync(): Promise<void> {
    const res = await fetch(`${this.controlUrl}/__control/clock`);
    this.t = ((await res.json()) as { now: number }).now;
  }
  now(): number {
    return this.t;
  }
  async advanceTo(t: number): Promise<void> {
    if (t <= this.t) return;
    await fetch(`${this.controlUrl}/__control/clock`, { method: 'POST', body: JSON.stringify({ to: t }) });
    this.t = t;
  }
}
