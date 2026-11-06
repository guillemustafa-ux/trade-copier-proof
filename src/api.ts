/** Thin REST client. A network failure is a value, never an exception: the sender has to classify it. */
export interface Raw {
  /** 0 when no response arrived at all. */
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any;
  network?: string;
}

export class Api {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
  ) {}

  async request(method: 'GET' | 'POST', path: string, token?: string, body?: unknown): Promise<Raw> {
    try {
      const res = await fetch(`${this.baseUrl}/${path}`, {
        method,
        signal: AbortSignal.timeout(this.timeoutMs), // a real-time limit: the clock is virtual, sockets are not
        headers: {
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      return { status: res.status, json: parseJson(text) };
    } catch (reason) {
      return { status: 0, json: undefined, network: reason instanceof Error ? reason.name : 'network' };
    }
  }

  get(path: string, token?: string): Promise<Raw> {
    return this.request('GET', path, token);
  }
}

function parseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export type PlaceOutcome =
  | { kind: 'placed'; orderId: number }
  | { kind: 'rejected'; reason: string }
  | { kind: 'penalty'; ticket: string; waitMs: number }
  | { kind: 'captcha' }
  | { kind: 'lockout' }
  /** The order may or may not exist. `suspect`: the failure may also mean the session is gone. */
  | { kind: 'ambiguous'; why: string; suspect: boolean };

export function classifyPlace(r: Raw): PlaceOutcome {
  if (r.status === 0) return { kind: 'ambiguous', why: r.network ?? 'no response', suspect: false };
  if (r.status === 429) return { kind: 'lockout' };
  if (r.status === 423) return { kind: 'captcha' };
  // Documented for evicted tokens: "408, 429, or 500 level errors". Nothing says the order was not placed.
  if (r.status === 408 || r.status === 401 || r.status >= 500) return { kind: 'ambiguous', why: `http ${r.status}`, suspect: true };
  if (r.status !== 200) return { kind: 'rejected', reason: `http ${r.status}` };
  // A penalty comes back as a 200: "the request was not handled". Always read the body first.
  if (r.json?.['p-ticket']) {
    if (r.json['p-captcha']) return { kind: 'captcha' };
    return { kind: 'penalty', ticket: r.json['p-ticket'], waitMs: Number(r.json['p-time'] ?? 0) * 1000 };
  }
  const reason = r.json?.failureReason;
  if (r.json?.orderId != null && (reason === undefined || reason === 'Success')) return { kind: 'placed', orderId: r.json.orderId };
  if (reason) return { kind: 'rejected', reason };
  if (r.json?.errorText) return { kind: 'rejected', reason: r.json.errorText };
  return { kind: 'ambiguous', why: 'a 200 without an order id', suspect: false };
}
