import { afterAll, afterEach, beforeAll, describe, expect, test } from '@jest/globals';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { ClientBuilder } from '@commercetools/ts-client';
import { createApiBuilderFromCtpClient } from '@commercetools/platform-sdk';
import { RETIRED_ORDER_CHECK_EXTENSION_KEY, removeRetiredOrderCheck } from '../../src/connectors/retired-order-check';

const AUTH = 'https://auth.test';
const API = 'https://api.test';
const PROJECT = 'test-project';
const EXTENSION = `${API}/${PROJECT}/extensions/key=${RETIRED_ORDER_CHECK_EXTENSION_KEY}`;

const lateBoundFetch = (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init);
const client = () =>
  createApiBuilderFromCtpClient(
    new ClientBuilder()
      .withClientCredentialsFlow({
        host: AUTH,
        projectKey: PROJECT,
        credentials: { clientId: 'id', clientSecret: 'secret' },
        httpClient: lateBoundFetch,
      })
      .withHttpMiddleware({ host: API, httpClient: lateBoundFetch })
      .build(),
  ).withProjectKey({ projectKey: PROJECT });
const silent = { info: () => undefined };
const notFound = () =>
  HttpResponse.json(
    { statusCode: 404, message: 'not found', errors: [{ code: 'ResourceNotFound', message: 'not found' }] },
    { status: 404 },
  );

describe('retired-order-check', () => {
  const server = setupServer(
    http.post(`${AUTH}/oauth/token`, () =>
      HttpResponse.json({ access_token: 't', expires_in: 3600, scope: 's', token_type: 'Bearer' }),
    ),
  );
  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());

  test('deletes an order-check extension left by an earlier version', async () => {
    let deletedVersion: string | null = null;
    server.use(
      http.get(EXTENSION, () =>
        HttpResponse.json({
          id: 'ext-1',
          key: RETIRED_ORDER_CHECK_EXTENSION_KEY,
          version: 3,
          destination: { type: 'HTTP', url: 'https://old.connect.test/order-check' },
          triggers: [],
        }),
      ),
      http.delete(EXTENSION, ({ request }) => {
        deletedVersion = new URL(request.url).searchParams.get('version');
        return HttpResponse.json({ id: 'ext-1', version: 3 });
      }),
    );

    await removeRetiredOrderCheck(client(), silent);

    expect(deletedVersion).toBe('3');
  });

  test('does nothing when no order-check extension exists', async () => {
    server.use(http.get(EXTENSION, notFound));

    await expect(removeRetiredOrderCheck(client(), silent)).resolves.toBeUndefined();
  });
});
