import { expect, test } from 'bun:test';
import { TrustStore, getTrustTokenFromRequest } from '../trust';

test('bootstrap token redeems into a trusted session once', () => {
  const store = new TrustStore();
  const bootstrap = store.issueBootstrapToken();

  const session = store.redeemBootstrapToken(bootstrap.token, 'phone');
  expect(session).not.toBeNull();
  expect(session?.deviceName).toBe('phone');
  expect(store.validateSessionToken(session!.sessionToken)?.deviceId).toBe(session?.deviceId);
  expect(store.redeemBootstrapToken(bootstrap.token, 'phone')).toBeNull();
});

test('expired bootstrap and session tokens are rejected', () => {
  let now = 1_000;
  const store = new TrustStore({
    now: () => now,
    bootstrapTtlMs: 50,
    sessionTtlMs: 100,
  });

  const bootstrap = store.issueBootstrapToken();
  now += 51;
  expect(store.redeemBootstrapToken(bootstrap.token, 'phone')).toBeNull();

  const secondBootstrap = store.issueBootstrapToken();
  const session = store.redeemBootstrapToken(secondBootstrap.token, 'phone');
  expect(session).not.toBeNull();
  now += 101;
  expect(store.validateSessionToken(session!.sessionToken)).toBeNull();
});

test('revocation invalidates trust tokens and extraction prefers bearer header', () => {
  const store = new TrustStore();
  const bootstrap = store.issueBootstrapToken();
  const session = store.redeemBootstrapToken(bootstrap.token, 'phone');

  expect(session).not.toBeNull();
  expect(store.revokeSessionToken(session!.sessionToken)).toBe(true);
  expect(store.validateSessionToken(session!.sessionToken)).toBeNull();

  const request = new Request('http://localhost:8080/api/opencode/session', {
    headers: {
      Authorization: 'Bearer bearer-token',
      Cookie: 'omo_drive_trust=cookie-token',
      'X-Omo-Trust': 'header-token',
    },
  });

  expect(getTrustTokenFromRequest(request)).toBe('bearer-token');
});
