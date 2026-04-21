import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/modules/private-account/exchange-connections.service', () => ({
  listExchangeConnections: vi.fn(async () => []),
  getExchangeConnection: vi.fn(async () => ({
    id: 'conn-1',
    exchange: 'upbit',
    exchangeName: '업비트',
    label: 'Primary Upbit',
    apiKeyMasked: 'abc***xyz',
    hasSecretKey: true,
    hasPassphrase: false,
    credentialFields: [
      { key: 'apiKey', label: 'Access Key', required: true, masked: true },
      { key: 'secretKey', label: 'Secret Key', required: true, masked: true },
    ],
    capabilities: {
      canTestConnection: true,
      canReadPortfolio: true,
      canPlaceOrder: true,
      canCancelOrder: true,
      canReadOpenOrders: true,
      canReadFills: true,
    },
    validation: {
      status: 'verified',
      mode: 'live_api',
      canUsePrivateApi: true,
      code: 'verified',
      message: '업비트 연결이 확인되었습니다.',
      checkedAt: '2026-04-21T00:00:00.000Z',
    },
    lastTestResult: {
      exchange: 'upbit',
      success: true,
      status: 'verified',
      mode: 'live_api',
      code: 'verified',
      message: '업비트 연결이 확인되었습니다.',
      checkedAt: '2026-04-21T00:00:00.000Z',
    },
    operational: {
      connectionStatus: 'active',
      lastSyncAt: '2026-04-21T00:00:00.000Z',
      lastErrorCode: null,
      lastErrorSummary: null,
      failureReason: null,
      isTestConnectionResult: true,
    },
    createdAt: '2026-04-21T00:00:00.000Z',
    updatedAt: '2026-04-21T00:00:00.000Z',
  })),
  testExchangeConnection: vi.fn(async () => ({
    exchange: 'upbit',
    success: false,
    status: 'invalid',
    mode: 'live_api',
    code: 'insufficient_permissions',
    message: 'API 키 권한이 부족합니다.',
    checkedAt: '2026-04-21T00:00:00.000Z',
    details: {
      upstreamStatus: 403,
    },
  })),
  createExchangeConnection: vi.fn(),
  updateExchangeConnection: vi.fn(),
  removeExchangeConnection: vi.fn(),
  validateStoredExchangeConnection: vi.fn(async () => ({
    id: 'conn-1',
    exchange: 'upbit',
    exchangeName: '업비트',
    label: 'Primary Upbit',
    apiKeyMasked: 'abc***xyz',
    hasSecretKey: true,
    hasPassphrase: false,
    credentialFields: [
      { key: 'apiKey', label: 'Access Key', required: true, masked: true },
      { key: 'secretKey', label: 'Secret Key', required: true, masked: true },
    ],
    capabilities: {
      canTestConnection: true,
      canReadPortfolio: true,
      canPlaceOrder: true,
      canCancelOrder: true,
      canReadOpenOrders: true,
      canReadFills: true,
    },
    validation: {
      status: 'verified',
      mode: 'live_api',
      canUsePrivateApi: true,
      code: 'verified',
      message: '업비트 연결이 확인되었습니다.',
      checkedAt: '2026-04-21T00:05:00.000Z',
    },
    lastTestResult: {
      exchange: 'upbit',
      success: true,
      status: 'verified',
      mode: 'live_api',
      code: 'verified',
      message: '업비트 연결이 확인되었습니다.',
      checkedAt: '2026-04-21T00:05:00.000Z',
    },
    operational: {
      connectionStatus: 'active',
      lastSyncAt: '2026-04-21T00:05:00.000Z',
      lastErrorCode: null,
      lastErrorSummary: null,
      failureReason: null,
      isTestConnectionResult: true,
    },
    createdAt: '2026-04-21T00:00:00.000Z',
    updatedAt: '2026-04-21T00:05:00.000Z',
  })),
}));

async function createAppWithToken() {
  const { buildApp } = await import('../src/app');
  const app = await buildApp();
  const token = app.jwt.sign({ id: 'user-1', email: 'user@example.com', authProvider: 'email' });
  return { app, token };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('Exchange connection domain routes', () => {
  it('POST /exchange-connections/test returns canonical test result', async () => {
    const { app, token } = await createAppWithToken();
    const res = await app.inject({
      method: 'POST',
      url: '/exchange-connections/test',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        exchange: 'upbit',
        apiKey: 'sample-key',
        secretKey: 'sample-secret',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.code).toBe('insufficient_permissions');
    expect(body.data.details.upstreamStatus).toBe(403);
    await app.close();
  });

  it('GET /exchange-connections/:id/status returns connection summary', async () => {
    const { app, token } = await createAppWithToken();
    const res = await app.inject({
      method: 'GET',
      url: '/exchange-connections/conn-1/status',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.exchange).toBe('upbit');
    expect(body.data.capabilities.canPlaceOrder).toBe(true);
    await app.close();
  });

  it('POST /exchange-connections/:id/revalidate returns refreshed validation state', async () => {
    const { app, token } = await createAppWithToken();
    const res = await app.inject({
      method: 'POST',
      url: '/exchange-connections/conn-1/revalidate',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.lastTestResult.checkedAt).toBe('2026-04-21T00:05:00.000Z');
    await app.close();
  });
});
