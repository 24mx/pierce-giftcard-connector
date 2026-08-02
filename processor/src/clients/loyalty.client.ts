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
 * The backend owns the points ledger; this connector is only a client of it. Points are held at
 * redeem and debited by the backend itself once an order exists, so there is deliberately no
 * capture call here.
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

  /** Spendable points: ledger balance minus every open hold. */
  public async balance(request: LoyaltyBalanceRequest): Promise<LoyaltyBalanceResponse> {
    const query = new URLSearchParams({
      userId: request.userId,
      currency: request.currencyCode,
    });

    return this.send<LoyaltyBalanceResponse>(`/loyalty/giftcard/balance?${query.toString()}`, { method: 'GET' });
  }

  /**
   * Withholds points for a payment. Idempotent on `paymentId`: a replay returns the existing hold
   * and withholds nothing extra. Nothing is debited here - the backend books the debit itself once
   * an order exists.
   */
  public async hold(request: LoyaltyHoldRequest): Promise<LoyaltyHoldResponse> {
    return this.send<LoyaltyHoldResponse>('/loyalty/giftcard/hold', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }

  /**
   * Closes a hold early so the points stop being withheld now rather than at TTL. Not a ledger
   * operation - correctness does not depend on it, a hold ages out on its own.
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
