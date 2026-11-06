/** How a lost response looks to the caller: a reset connection, silence, or a 500. */
export type LostMode = 'reset' | 'timeout' | 'http500';

export type Fault =
  /** The order is accepted and the response never arrives. `visibleAfterMs` also delays its visibility. */
  | { kind: 'lostAfterAccept'; mode?: LostMode; visibleAfterMs?: number }
  /** The response never arrives and the order was never accepted. */
  | { kind: 'lostBeforeAccept'; mode?: LostMode }
  /** The response is normal, but the order stays out of order/deps and positions for a while. */
  | { kind: 'delayedVisibility'; delayMs: number }
  /** A 200 body carrying p-ticket and p-time; the request was not handled. */
  | { kind: 'penalty'; pTime: number }
  /** A 200 body with p-captcha: true; every later placement on that login answers 423. */
  | { kind: 'captcha' }
  /** HTTP 429 with an empty body; every call on that login answers 429 and resets the hour. */
  | { kind: 'lockout429' }
  /** Two other sessions open first, so this login's oldest session is closed before the request is handled. */
  | { kind: 'evict' }
  /** The token expires right now. */
  | { kind: 'expireToken' }
  /** A 200 with failureReason and no order, for example a locked account. */
  | { kind: 'reject'; reason: string }
  /** The order is accepted and fills only partly; the remainder stays Working. */
  | { kind: 'partialFill'; filled: number };

/**
 * One planned fault. It matches by account or by login and, with `nth`, only the n-th call of
 * that endpoint for that key. Keys are identities, not arrival order across logins, so the same
 * plan does the same thing however concurrent requests interleave.
 */
export interface FaultRule {
  accountId?: number;
  login?: string;
  nth?: number;
  /** Defaults to order/placeorder. For other endpoints only lostBeforeAccept applies. */
  endpoint?: string;
  fault: Fault;
}
