import type { Hono } from 'hono';
import { emitTrustAuditEvent, getTrustValidationFromRequest } from '../../trust';

export function registerTrustRoute(app: Hono) {
  app.get('/api/trust', (c) => {
    const validation = getTrustValidationFromRequest(c.req.raw);
    const route = '/api/trust';

    if (!validation.session) {
      emitTrustAuditEvent({
        entityType: 'trust',
        entityId: validation.deviceId ?? validation.token ?? 'anonymous',
        actorId: validation.deviceId ?? undefined,
        action: 'trust.validation_failed',
        metadata: {
          status: 'blocked',
          reason: validation.reason,
          route,
        },
      });

      if (validation.reason === 'expired' || validation.reason === 'revoked') {
        emitTrustAuditEvent({
          entityType: 'trust',
          entityId: validation.deviceId ?? validation.token ?? 'anonymous',
          actorId: validation.deviceId ?? undefined,
          action: 'trust.repairing_required',
          metadata: {
            status: 'blocked',
            reason: validation.reason,
            route,
          },
        });
      }

      return c.json({ trusted: false });
    }

    emitTrustAuditEvent({
      entityType: 'trust',
      entityId: validation.session.deviceId,
      actorId: validation.session.deviceId,
      action: 'trust.validated',
      metadata: {
        status: 'trusted',
        route,
        expiresAt: new Date(validation.session.expiresAt).toISOString(),
      },
    });

    return c.json({
      trusted: true,
      deviceId: validation.session.deviceId,
      deviceName: validation.session.deviceName,
      expiresAt: new Date(validation.session.expiresAt).toISOString(),
    });
  });
}
