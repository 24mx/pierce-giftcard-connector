import { getConfig } from '../config/config';
import { LoyaltyApiError } from '../errors/loyalty-api.error';
import {
  LoyaltyBalanceRequest,
  LoyaltyBalanceResponse,
  LoyaltyErrorResponse,
  LoyaltyHoldRequest,
  LoyaltyHoldResponse,
  LoyaltyLockRequest,
  LoyaltyReleaseRequest,
  LoyaltyReleaseResponse,
  LoyaltyVoidRequest,
} from './types/loyalty.client.type';

export type LoyaltyClientOptions = {
  baseUrl: string;
  timeoutMs: number;
  /** Shared secret the backend expects. Omitted when the backend runs unsecured, as it does locally. */
  apiKey?: string;
  /**
   * Cloudflare Access service token in front of the backend. Sent only when both halves are set, so a
   * backend reached without Cloudflare (locally, or through a tunnel from a laptop) still works.
   */
  accessClientId?: string;
  accessClientSecret?: string;
};

/**
 * HTTP client for the Pierce loyalty backend.
 *
 * The backend owns the points ledger; this connector is only a client of it. Redeeming debits the
 * points there and then (a provisional debit) and the order signal settles that debit, so there is
 * deliberately no capture call here.
 */
export class LoyaltyClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly apiKey?: string;
  private readonly accessHeaders: Record<string, string>;

  constructor(opts: LoyaltyClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs;
    this.apiKey = opts.apiKey;
    this.accessHeaders =
      opts.accessClientId && opts.accessClientSecret
        ? { 'cf-access-client-id': opts.accessClientId, 'cf-access-client-secret': opts.accessClientSecret }
        : {};
  }

  /**
   * Spendable points — the ledger balance itself. An open reservation has already been debited there,
   * so this number needs no netting and is what the checkout SDK may spend.
   */
  public async balance(request: LoyaltyBalanceRequest): Promise<LoyaltyBalanceResponse> {
    const query = new URLSearchParams({
      userId: request.userId,
      currency: request.currencyCode,
    });
    if (request.cartId !== undefined && request.cartTotal !== undefined) {
      query.set('cartId', request.cartId);
      query.set('cartTotal', String(request.cartTotal));
    }
    if (request.sessionExpiresAt !== undefined) {
      query.set('sessionExpiresAt', request.sessionExpiresAt);
    }

    return this.send<LoyaltyBalanceResponse>(`/loyalty/redemption/balance?${query.toString()}`, { method: 'GET' });
  }

  /**
   * Reserves points for a payment: the backend debits them immediately and refuses the call when the
   * balance cannot cover it (409) or when the reservation would leave less than EUR 1 payable by card
   * (400). Idempotent on `redemptionId` — a replay returns the existing reservation and debits nothing
   * extra.
   */
  public async hold(request: LoyaltyHoldRequest): Promise<LoyaltyHoldResponse> {
    return this.send<LoyaltyHoldResponse>('/loyalty/redemption/hold', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  /**
   * Releases a reservation, which credits the points back. This IS a ledger operation: skipping it
   * leaves the customer's points debited until the backend's reconciliation sweep recovers them at
   * TTL, so a failure here is worth an error rather than a shrug.
   */
  public async voidHold(request: LoyaltyVoidRequest): Promise<LoyaltyHoldResponse> {
    return this.send<LoyaltyHoldResponse>('/loyalty/redemption/void', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  /**
   * Gives a redemption back the only safe way: the backend takes the discount off the cart first,
   * then looks for an order, and credits the points only when no order can carry the discount. Use
   * this, never `voidHold`, for a cart that may carry the redemption.
   */
  public async release(request: LoyaltyReleaseRequest): Promise<LoyaltyReleaseResponse> {
    return this.send<LoyaltyReleaseResponse>('/loyalty/redemption/release', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  /**
   * Locks a reservation right before a checkout's final submission, so a second tab cannot
   * void-and-recreate it while a card leg elsewhere may already be reading its amount. The lock
   * expires on its own; there is no matching unlock call.
   */
  public async lock(request: LoyaltyLockRequest): Promise<LoyaltyHoldResponse> {
    return this.send<LoyaltyHoldResponse>('/loyalty/redemption/lock', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  private async send<T>(path: string, init: RequestInit): Promise<T> {
    let response: Response;

    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...(this.apiKey && { 'x-api-key': this.apiKey }),
          ...this.accessHeaders,
          ...init.headers,
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new LoyaltyApiError({
        status: 0,
        message: `loyalty backend is not reachable`,
        cause: e,
      });
    }

    if (!response.ok) {
      const body = await this.readErrorBody(response);
      throw new LoyaltyApiError({
        status: response.status,
        message: body?.error || `loyalty backend responded with ${response.status}`,
        body,
      });
    }

    return (await response.json()) as T;
  }

  private async readErrorBody(response: Response): Promise<LoyaltyErrorResponse | undefined> {
    try {
      return (await response.json()) as LoyaltyErrorResponse;
    } catch {
      return undefined;
    }
  }
}

export const LoyaltyAPI = (): LoyaltyClient => {
  return new LoyaltyClient({
    baseUrl: getConfig().loyaltyApiUrl,
    timeoutMs: Number(getConfig().loyaltyTimeoutMs),
    apiKey: getConfig().loyaltyApiKey || undefined,
    accessClientId: getConfig().loyaltyAccessClientId || undefined,
    accessClientSecret: getConfig().loyaltyAccessClientSecret || undefined,
  });
};
