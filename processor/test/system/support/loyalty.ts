import { SystemEnv } from './env';

type BalanceResponse = { points: number };
type ReleaseResponse = { released: string[]; locked: string[] };

/** The backend's test-facing surface; every call carries the shared X-Api-Key. */
export const loyalty = (env: SystemEnv) => {
  const call = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const response = await fetch(`${env.loyaltyApiUrl}${path}`, {
      ...init,
      headers: { 'X-Api-Key': env.loyaltyApiKey, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    });
    if (!response.ok) {
      throw new Error(`loyalty ${path} failed: ${response.status} ${await response.text()}`);
    }
    return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
  };

  return {
    grant: (email: string, points: number) =>
      call<void>('/loyalty/demo/points', {
        method: 'POST',
        body: JSON.stringify({ userId: email.toLowerCase(), points, reason: 'system test' }),
      }),

    balance: (email: string) =>
      call<BalanceResponse>(
        `/loyalty/redemption/balance?userId=${encodeURIComponent(email.toLowerCase())}&currency=${env.currency}`,
      ),

    releaseAll: (email: string) =>
      call<ReleaseResponse>('/loyalty/redemption/test-hooks/holds/release', {
        method: 'POST',
        body: JSON.stringify({ userId: email.toLowerCase() }),
      }),

    /** One reconciliation pass now, narrowed to this customer's holds so nobody else's checkout is touched. */
    sweepFor: (email: string, ttlMinutes = 0) =>
      call<void>(
        `/loyalty/redemption/test-hooks/sweep?ttlMinutes=${ttlMinutes}&userId=${encodeURIComponent(email.toLowerCase())}`,
        { method: 'POST' },
      ),
  };
};
