import type { Api } from './api.js';
import type { Clock } from './clock.js';
import type { Store } from './store.js';

/**
 * One session per login, kept in Postgres and reused across restarts, because every extra
 * accessTokenRequest opens another session and a third one closes the oldest. A lost session is
 * detected with auth/me and replaced; a send that failed on it stays UNKNOWN and goes through the
 * resolver like any other, so eviction never turns into a blind re-send.
 */
export class Sessions {
  private readonly renewHold = new Map<string, number>();

  constructor(
    private readonly store: Store,
    private readonly api: Api,
    private readonly clock: Clock,
    private readonly renewMarginMs: number,
  ) {}

  /** A usable token for this login, or null when the login is stopped. */
  async ensure(name: string): Promise<string | null> {
    const login = await this.store.login(name);
    if (login.state !== 'ACTIVE') return null;
    const token = login.access_token;
    if (!token) return this.authenticate(name, 'first');

    if (login.suspect) {
      const me = await this.api.get('auth/me', token);
      if (me.status === 429) return this.stop(name, 'http_429', 'auth/me answered 429');
      if (me.status === 200) {
        await this.store.setSuspect(name, false);
        return token;
      }
      return this.replace(name, `auth/me answered ${me.status || me.network}`);
    }

    const now = this.clock.now();
    if (now >= (login.token_expires_at ?? 0) - this.renewMarginMs && now >= (this.renewHold.get(name) ?? 0)) {
      const renewed = await this.api.get('auth/renewaccesstoken', token);
      if (renewed.status === 429) return this.stop(name, 'http_429', 'renewaccesstoken answered 429');
      if (renewed.json?.['p-captcha']) return this.stop(name, 'p_captcha', 'renewaccesstoken answered p-captcha');
      if (renewed.json?.['p-ticket']) {
        // Renewals are the first limit a large fleet meets. The token still works: wait, do not open a session.
        this.renewHold.set(name, now + Number(renewed.json['p-time'] ?? 0) * 1000);
        return token;
      }
      if (renewed.status === 200 && renewed.json?.accessToken) {
        await this.store.storeToken(name, renewed.json.accessToken, Date.parse(renewed.json.expirationTime), 'renewal');
        return renewed.json.accessToken as string;
      }
      return this.replace(name, `renewaccesstoken answered ${renewed.status || renewed.network}`);
    }
    return token;
  }

  /** Every login gets its session before any work starts, so a crash never loses a fresh one. */
  async ensureAll(): Promise<void> {
    const logins = await this.store.logins();
    await Promise.all(logins.map((l) => this.ensure(l.name)));
  }

  /** Renews tokens close to expiry, also on logins with nothing to send right now. */
  async renewDue(): Promise<void> {
    const due = await this.store.logins();
    const limit = this.clock.now() + this.renewMarginMs;
    await Promise.all(
      due.filter((l) => l.state === 'ACTIVE' && l.token_expires_at !== null && l.token_expires_at <= limit).map((l) => this.ensure(l.name)),
    );
  }

  private async replace(name: string, why: string): Promise<string | null> {
    await this.store.alert(this.clock.now(), name, 'session_lost', why);
    return this.authenticate(name, 'reauth');
  }

  private async authenticate(name: string, kind: 'first' | 'reauth'): Promise<string | null> {
    const login = await this.store.login(name);
    const raw = await this.api.request('POST', 'auth/accesstokenrequest', undefined, {
      name,
      password: login.password,
      appId: 'trade-copier-proof',
      appVersion: '0.1.0',
    });
    if (raw.status === 429) return this.stop(name, 'http_429', 'accesstokenrequest answered 429');
    if (raw.status === 200 && raw.json?.accessToken) {
      await this.store.storeToken(name, raw.json.accessToken, Date.parse(raw.json.expirationTime), kind);
      return raw.json.accessToken as string;
    }
    // Only 5 failed token requests an hour are allowed per /24: stop here rather than burn them.
    return this.stop(name, 'auth_failed', `accesstokenrequest answered ${raw.status || raw.network}: ${raw.json?.errorText ?? ''}`);
  }

  private async stop(name: string, reason: string, detail: string): Promise<null> {
    await this.store.blockLogin(this.clock.now(), name, reason, detail);
    return null;
  }
}
