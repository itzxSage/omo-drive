import type { Hono } from 'hono';
import { createPairingImageResponse } from '../pairing';
import {
  buildClearedTrustCookie,
  buildTrustCookie,
  emitTrustAuditEvent,
  isSecureRequest,
  requireTrusted,
  trustStore,
  type TrustedSession,
} from '../../trust';

export function registerPairRoutes(app: Hono) {
  app.get('/api/pair', async () => createPairingImageResponse());

  app.post('/api/pair', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const bootstrapToken = typeof body.bootstrapToken === 'string' ? body.bootstrapToken : '';
    const deviceName = typeof body.deviceName === 'string' ? body.deviceName : undefined;

    if (!bootstrapToken) {
      return c.json({ error: 'Missing bootstrapToken' }, 400);
    }

    const session = trustStore.redeemBootstrapToken(bootstrapToken, deviceName);
    if (!session) {
      emitTrustAuditEvent({
        entityType: 'trust',
        entityId: bootstrapToken,
        action: 'trust.validation_failed',
        metadata: {
          status: 'blocked',
          reason: 'invalid_bootstrap',
          route: '/api/pair',
        },
      });
      return c.json({ error: 'Invalid or expired bootstrap token' }, 401);
    }

    emitTrustAuditEvent({
      entityType: 'trust',
      entityId: session.deviceId,
      actorId: session.deviceId,
      action: 'trust.pairing_completed',
      metadata: {
        status: 'trusted',
        deviceName: session.deviceName,
        route: '/api/pair',
        expiresAt: new Date(session.expiresAt).toISOString(),
      },
    });

    c.header(
      'Set-Cookie',
      buildTrustCookie(
        session.sessionToken,
        isSecureRequest(c),
        Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000)),
      ),
    );

    return c.json({
      ok: true,
      deviceId: session.deviceId,
      deviceName: session.deviceName,
      expiresAt: new Date(session.expiresAt).toISOString(),
    });
  });

  app.delete('/api/pair', requireTrusted, async (c) => {
    const session = (c as any).get('trustedSession') as TrustedSession;

    trustStore.revokeSessionToken(session.sessionToken);
    trustStore.revokeDevice(session.deviceId);
    c.header('Set-Cookie', buildClearedTrustCookie(isSecureRequest(c)));

    emitTrustAuditEvent({
      entityType: 'trust',
      entityId: session.deviceId,
      actorId: session.deviceId,
      action: 'trust.revoked',
      metadata: {
        status: 'revoked',
        deviceName: session.deviceName,
        route: '/api/pair',
      },
    });

    return c.json({ ok: true, revoked: true, deviceId: session.deviceId });
  });
}
