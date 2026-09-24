import { SystemEnv } from './env';

export type ProcessorReply<T> = { status: number; body: T };

/** Non-2xx replies of the four routes: `status.state` is the error key. */
export type ProcessorError = { status: { state: string; errors: { code: string; message: string }[] } };

export const processor = (env: SystemEnv) => ({
  async post<T>(path: string, sessionId: string, body: unknown): Promise<ProcessorReply<T>> {
    const response = await fetch(`${env.processorUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Id': sessionId },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as T };
  },
});
