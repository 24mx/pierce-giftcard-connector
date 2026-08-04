import { getConfig } from '../config/config';
import { LoyaltyApiError } from '../errors/loyalty-api.error';
import {
  LoyaltyBalanceRequest,
  LoyaltyBalanceResponse,
  LoyaltyErrorResponse,
  LoyaltyHoldRequest,
  LoyaltyHoldResponse,
  LoyaltyVoidRequest,
} from './types/loyalty.client.type';

export type LoyaltyClientOptions = {
  baseUrl: string;
  timeoutMs: number;
  /** Shared secret the backend expects. Omitted when the backend runs unsecured, as it does locally. */
  apiKey?: string;
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

  constructor(opts: LoyaltyClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs;
    this.apiKey = opts.apiKey;
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

    return this.send<LoyaltyBalanceResponse>(`/loyalty/giftcard/balance?${query.toString()}`, { method: 'GET' });
  }

  /**
   * Reserves points for a payment: the backend debits them immediately and refuses the call when the
   * balance cannot cover it (409) or when the reservation would leave less than EUR 1 payable by card
   * (400). Idempotent on `paymentId` — a replay returns the existing reservation and debits nothing
   * extra.
   */
  public async hold(request: LoyaltyHoldRequest): Promise<LoyaltyHoldResponse> {
    return this.send<LoyaltyHoldResponse>('/loyalty/giftcard/hold', {
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
    return this.send<LoyaltyHoldResponse>('/loyalty/giftcard/void', {
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
      throw new LoyaltyApiError({
        status: response.status,
        message: await this.readErrorMessage(response),
      });
    }

    return (await response.json()) as T;
  }

  private async readErrorMessage(response: Response): Promise<string> {
    try {
      const body = (await response.json()) as LoyaltyErrorResponse;
      return body?.error || `loyalty backend responded with ${response.status}`;
    } catch {
      return `loyalty backend responded with ${response.status}`;
    }
  }
}

export const LoyaltyAPI = (): LoyaltyClient => {
  return new LoyaltyClient({
    baseUrl: getConfig().loyaltyApiUrl,
    timeoutMs: Number(getConfig().loyaltyTimeoutMs),
    apiKey: getConfig().loyaltyApiKey || undefined,
  });
};
