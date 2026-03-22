import type { Context, Next } from 'hono';

export const TRUST_COOKIE_NAME = 'omo_drive_trust';

const DEFAULT_BOOTSTRAP_TTL_MS = 5 * 60 * 1000;
const DEFAULT_SESSION_TTL_MS = 4 * 60 * 60 * 1000;

type BootstrapRecord = {
  token: string;
  expiresAt: number;
  redeemedAt?: number;
};

export type TrustedSession = {
  deviceId: string;
  deviceName: string;
  sessionToken: string;
  createdAt: number;
  expiresAt: number;
  revokedAt?: number;
};

type DeviceRecord = {
  deviceId: string;
  deviceName: string;
  createdAt: number;
  revokedAt?: number;
};

type TrustStoreOptions = {
  now?: () => number;
  bootstrapTtlMs?: number;
  sessionTtlMs?: number;
};

type TrustFailureReason = 'missing' | 'invalid' | 'expired' | 'revoked';

type TrustAuditRecord = {
  entityType: string;
  entityId: string;
  action: string;
  actorId?: string;
  metadata?: Record<string, unknown>;
  occurredAt?: string;
};

type TrustValidationResult = {
  token: string | null;
  session: TrustedSession | null;
  reason: TrustFailureReason | null;
  deviceId: string | null;
};

let trustAuditReporter: ((record: TrustAuditRecord) => void) | null = null;

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Buffer.from(bytes).toString('base64url');
}

function parseCookies(header: string | null): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) {
    return cookies;
  }

  for (const part of header.split(';')) {
    const [rawName, ...rawValue] = part.trim().split('=');
    if (!rawName || rawValue.length === 0) {
      continue;
    }
    cookies.set(rawName, rawValue.join('='));
  }

  return cookies;
}

export class TrustStore {
  private readonly now: () => number;
  private readonly bootstrapTtlMs: number;
  private readonly sessionTtlMs: number;
  private readonly bootstraps = new Map<string, BootstrapRecord>();
  private readonly devices = new Map<string, DeviceRecord>();
  private readonly sessions = new Map<string, TrustedSession>();

  constructor(options: TrustStoreOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.bootstrapTtlMs = options.bootstrapTtlMs ?? DEFAULT_BOOTSTRAP_TTL_MS;
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  }

  issueBootstrapToken(): BootstrapRecord {
    this.pruneExpired();
    const token = randomToken();
    const bootstrap = {
      token,
      expiresAt: this.now() + this.bootstrapTtlMs,
    } satisfies BootstrapRecord;
    this.bootstraps.set(token, bootstrap);
    return bootstrap;
  }

  redeemBootstrapToken(token: string, deviceName?: string): TrustedSession | null {
    this.pruneExpired();
    const bootstrap = this.bootstraps.get(token);
    const now = this.now();

    if (!bootstrap || bootstrap.redeemedAt || bootstrap.expiresAt <= now) {
      return null;
    }

    bootstrap.redeemedAt = now;
    this.bootstraps.delete(token);

    const deviceId = crypto.randomUUID();
    const sessionToken = randomToken();
    const resolvedDeviceName = deviceName?.trim() || 'paired-device';

    this.devices.set(deviceId, {
      deviceId,
      deviceName: resolvedDeviceName,
      createdAt: now,
    });

    const session = {
      deviceId,
      deviceName: resolvedDeviceName,
      sessionToken,
      createdAt: now,
      expiresAt: now + this.sessionTtlMs,
    } satisfies TrustedSession;

    this.sessions.set(sessionToken, session);
    return session;
  }

  validateSessionToken(token: string): TrustedSession | null {
    return this.inspectSessionToken(token).session;
  }

  inspectSessionToken(token: string): { session: TrustedSession | null; reason: Exclude<TrustFailureReason, 'missing'>; deviceId: string | null } {
    this.pruneExpiredBootstraps();

    const session = this.sessions.get(token);
    if (!session) {
      return { session: null, reason: 'invalid', deviceId: null };
    }

    const now = this.now();
    if (session.revokedAt) {
      this.sessions.delete(token);
      return { session: null, reason: 'revoked', deviceId: session.deviceId, };
    }

    if (session.expiresAt <= now) {
      this.sessions.delete(token);
      return { session: null, reason: 'expired', deviceId: session.deviceId };
    }

    const device = this.devices.get(session.deviceId);
    if (!device) {
      return { session: null, reason: 'invalid', deviceId: session.deviceId };
    }

    if (device.revokedAt) {
      session.revokedAt = device.revokedAt;
      this.sessions.delete(token);
      return { session: null, reason: 'revoked', deviceId: session.deviceId };
    }

    return { session, reason: 'invalid', deviceId: session.deviceId };
  }

  revokeSessionToken(token: string): boolean {
    const session = this.sessions.get(token);
    if (!session || session.revokedAt) {
      return false;
    }
    session.revokedAt = this.now();
    return true;
  }

  revokeDevice(deviceId: string): boolean {
    const device = this.devices.get(deviceId);
    if (!device || device.revokedAt) {
      return false;
    }

    const now = this.now();
    device.revokedAt = now;
    for (const session of this.sessions.values()) {
      if (session.deviceId === deviceId && !session.revokedAt) {
        session.revokedAt = now;
      }
    }

    return true;
  }

  reset(): void {
    this.bootstraps.clear();
    this.devices.clear();
    this.sessions.clear();
  }

  private pruneExpired(): void {
    this.pruneExpiredBootstraps();
    this.pruneExpiredSessions();
  }

  private pruneExpiredBootstraps(): void {
    const now = this.now();

    for (const [token, bootstrap] of this.bootstraps.entries()) {
      if (bootstrap.expiresAt <= now || bootstrap.redeemedAt) {
        this.bootstraps.delete(token);
      }
    }
  }

  private pruneExpiredSessions(): void {
    const now = this.now();
    for (const [token, session] of this.sessions.entries()) {
      if (session.expiresAt <= now || session.revokedAt) {
        this.sessions.delete(token);
      }
    }
  }
}

export const trustStore = new TrustStore();

export function setTrustAuditReporter(reporter: ((record: TrustAuditRecord) => void) | null): void {
  trustAuditReporter = reporter;
}

export function emitTrustAuditEvent(record: TrustAuditRecord): void {
  trustAuditReporter?.(record);
}

export function getTrustTokenFromRequest(request: Request): string | null {
  const authHeader = request.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length).trim() || null;
  }

  const trustHeader = request.headers.get('x-omo-trust');
  if (trustHeader?.trim()) {
    return trustHeader.trim();
  }

  return parseCookies(request.headers.get('cookie')).get(TRUST_COOKIE_NAME) ?? null;
}

export function getTrustedSessionFromRequest(request: Request): TrustedSession | null {
  return getTrustValidationFromRequest(request).session;
}

export function getTrustValidationFromRequest(request: Request): TrustValidationResult {
  const token = getTrustTokenFromRequest(request);
  if (!token) {
    return {
      token: null,
      session: null,
      reason: 'missing',
      deviceId: null,
    };
  }

  const result = trustStore.inspectSessionToken(token);
  return {
    token,
    session: result.session,
    reason: result.session ? null : result.reason,
    deviceId: result.deviceId,
  };
}

export function isSecureRequest(c: Context): boolean {
  const forwardedProto = c.req.header('x-forwarded-proto');
  if (forwardedProto) {
    return forwardedProto === 'https';
  }
  return new URL(c.req.url).protocol === 'https:';
}

export function buildTrustCookie(token: string, secure: boolean, maxAgeSeconds: number): string {
  const parts = [
    `${TRUST_COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`,
  ];

  if (secure) {
    parts.push('Secure');
  }

  return parts.join('; ');
}

export function buildClearedTrustCookie(secure: boolean): string {
  return buildTrustCookie('', secure, 0);
}

export async function requireTrusted(c: Context, next: Next): Promise<Response | void> {
  const validation = getTrustValidationFromRequest(c.req.raw);
  if (!validation.session) {
    const entityId = validation.deviceId ?? validation.token ?? 'anonymous';
    emitTrustAuditEvent({
      entityType: 'trust',
      entityId,
      action: 'trust.validation_failed',
      actorId: validation.deviceId ?? undefined,
      metadata: {
        status: 'blocked',
        reason: validation.reason,
        route: new URL(c.req.url).pathname,
      },
    });

    if (validation.reason === 'expired' || validation.reason === 'revoked') {
      emitTrustAuditEvent({
        entityType: 'trust',
        entityId,
        action: 'trust.repairing_required',
        actorId: validation.deviceId ?? undefined,
        metadata: {
          status: 'blocked',
          reason: validation.reason,
          route: new URL(c.req.url).pathname,
        },
      });
    }

    if (!validation.token) {
      return c.json({ error: 'Trusted device required' }, 401);
    }

    return c.json({ error: 'Invalid or expired trust' }, 401);
  }

  emitTrustAuditEvent({
    entityType: 'trust',
    entityId: validation.session.deviceId,
    action: 'trust.validated',
    actorId: validation.session.deviceId,
    metadata: {
      status: 'trusted',
      route: new URL(c.req.url).pathname,
      expiresAt: new Date(validation.session.expiresAt).toISOString(),
    },
  });

  c.set('trustedSession', validation.session);
  await next();
}
