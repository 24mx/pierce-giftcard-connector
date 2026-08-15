import { LoyaltyErrorResponse } from '../clients/types/loyalty.client.type';

/**
 * Raised whenever a call to the loyalty backend does not end in a 2xx response.
 *
 * `status` carries the HTTP status code so that callers can tell the backend's rejections apart:
 * 409 means not enough points, 400 a currency the ledger does not settle, and 404 on void that the
 * hold is already gone. A transport failure (connection refused, timeout) has no status, and is
 * reported as 0.
 */
export class LoyaltyApiError extends Error {
  public readonly status: number;
  public readonly body?: LoyaltyErrorResponse;

  constructor(opts: { status: number; message: string; body?: LoyaltyErrorResponse; cause?: unknown }) {
    super(opts.message, { cause: opts.cause });
    this.name = 'LoyaltyApiError';
    this.status = opts.status;
    this.body = opts.body;
  }
}
