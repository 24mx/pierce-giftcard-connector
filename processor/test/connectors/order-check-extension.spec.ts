import { afterAll, afterEach, beforeAll, describe, expect, test } from '@jest/globals';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { ClientBuilder } from '@commercetools/ts-client';
import { createApiBuilderFromCtpClient } from '@commercetools/platform-sdk';
import {
  ensureOrderCheckExtension,
  ORDER_CHECK_EXTENSION_KEY,
  removeOrderCheckExtension,
} from '../../src/connectors/order-check-extension';

const AUTH = 'https://auth.test';
const API = 'https://api.test';
const PROJECT = 'test-project';
const EXTENSION = `${API}/${PROJECT}/extensions/key=${ORDER_CHECK_EXTENSION_KEY}`;

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

const ENABLED = {
  enabled: true,
  serviceUrl: 'https://service.connect.test/',
  authHeader: 'Basic c2VjcmV0',
  syncPointsField: 'loyaltySyncPoints',
};

const destination = {
  type: 'HTTP',
  url: 'https://service.connect.test/order-check',
  authentication: { type: 'AuthorizationHeader', headerValue: 'Basic c2VjcmV0' },
};
const triggers = [
  { resourceTypeId: 'order', actions: ['Create'], condition: 'custom(fields(loyaltySyncPoints is defined))' },
];

describe('order-check-extension', () => {
  const server = setupServer(
    http.post(`${AUTH}/oauth/token`, () =>
      HttpResponse.json({ access_token: 't', expires_in: 3600, scope: 's', token_type: 'Bearer' }),
    ),
  );
  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());

  test('registers the extension on order creation, only for carts that carry a sync record', async () => {
    let created: unknown;
    server.use(
      http.get(EXTENSION, notFound),
      http.post(`${API}/${PROJECT}/extensions`, async ({ request }) => {
        created = await request.json();
        return HttpResponse.json({ id: 'ext', version: 1 });
      }),
    );

    await ensureOrderCheckExtension(client(), ENABLED, silent);

    expect(created).toStrictEqual({ key: ORDER_CHECK_EXTENSION_KEY, destination, triggers });
  });

  test('converges an existing extension onto the current destination and trigger', async () => {
    let updated: unknown;
    server.use(
      http.get(EXTENSION, () => HttpResponse.json({ id: 'ext', version: 3, key: ORDER_CHECK_EXTENSION_KEY })),
      http.post(EXTENSION, async ({ request }) => {
        updated = await request.json();
        return HttpResponse.json({ id: 'ext', version: 4 });
      }),
    );

    await ensureOrderCheckExtension(client(), ENABLED, silent);

    expect(updated).toStrictEqual({
      version: 3,
      actions: [
        { action: 'changeDestination', destination },
        { action: 'changeTriggers', triggers },
      ],
    });
  });

  test('removes the extension when the check is turned off', async () => {
    const deleted: string[] = [];
    server.use(
      http.get(EXTENSION, () => HttpResponse.json({ id: 'ext', version: 3, key: ORDER_CHECK_EXTENSION_KEY })),
      http.delete(EXTENSION, ({ request }) => {
        deleted.push(new URL(request.url).searchParams.get('version') ?? '');
        return HttpResponse.json({ id: 'ext', version: 3 });
      }),
    );

    await ensureOrderCheckExtension(client(), { ...ENABLED, enabled: false }, silent);

    expect(deleted).toStrictEqual(['3']);
  });

  test('does nothing when the check is off and no extension exists', async () => {
    server.use(http.get(EXTENSION, notFound));

    await expect(removeOrderCheckExtension(client(), silent)).resolves.toBeUndefined();
  });

  test.each([
    [{ serviceUrl: '' }, 'CONNECT_SERVICE_URL'],
    [{ authHeader: '' }, 'ORDER_CHECK_AUTH_HEADER'],
  ])('refuses to register without %o', async (missing, name) => {
    await expect(ensureOrderCheckExtension(client(), { ...ENABLED, ...missing }, silent)).rejects.toThrow(name);
  });
});
