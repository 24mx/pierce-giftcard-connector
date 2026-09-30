import { log } from '../libs/logger';

/** What this client needs from the payments SDK's session service: the raw session by id. */
export type SessionReader = {
  verifySession(sessionId: string): Promise<unknown>;
};

/**
 * When the commercetools Checkout session a request runs under expires. The loyalty backend's sweep
 * leaves a cart alone until the latest session reported for it has expired, because the storefront
 * renews sessions on the same cart and a payment may be running against any live one.
 */
export interface SessionExpiryClient {
  /** The session's `expiryAt` (ISO-8601), or null when it cannot be read - never a reason to fail. */
  expiryOf(sessionId: string): Promise<string | null>;
}

export class CommercetoolsSessionExpiryClient implements SessionExpiryClient {
  constructor(private readonly sessions: SessionReader) {}

  public async expiryOf(sessionId: string): Promise<string | null> {
    try {
      // The SDK's Session type omits expiryAt, but the Sessions API returns it.
      const session = (await this.sessions.verifySession(sessionId)) as { expiryAt?: unknown };
      return typeof session.expiryAt === 'string' ? session.expiryAt : null;
    } catch (e) {
      log.warn('Could not read the checkout session expiry; the backend falls back to the hold age.', {
        error: e instanceof Error ? e.message : String(e),
      });
      return null;
    }
  }
}
