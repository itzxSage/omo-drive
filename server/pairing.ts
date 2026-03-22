import { getRuntimeConfig } from '../config';
import { buildPairingURL, getQRImage, getQRTerminal, getTailnetURL } from '../pair';
import { emitTrustAuditEvent, trustStore } from '../trust';

type PairingArtifact<T> = {
  artifact: T;
  token: string;
  url: string;
  expiresAt: number;
  usedFallback: boolean;
};

async function createPairingArtifact<T>(render: (url: string) => Promise<T>): Promise<PairingArtifact<T>> {
  try {
    const bootstrap = trustStore.issueBootstrapToken();
    const url = buildPairingURL(await getTailnetURL(), bootstrap.token);
    return {
      artifact: await render(url),
      token: bootstrap.token,
      url,
      expiresAt: bootstrap.expiresAt,
      usedFallback: false,
    };
  } catch {
    const bootstrap = trustStore.issueBootstrapToken();
    const url = buildPairingURL(getRuntimeConfig().pair.fallbackUrl, bootstrap.token);
    return {
      artifact: await render(url),
      token: bootstrap.token,
      url,
      expiresAt: bootstrap.expiresAt,
      usedFallback: true,
    };
  }
}

function emitPairingStarted(pairing: PairingArtifact<unknown>) {
  emitTrustAuditEvent({
    entityType: 'trust',
    entityId: pairing.token,
    action: 'trust.pairing_started',
    metadata: {
      status: 'pairing_pending',
      url: pairing.url,
      usedFallback: pairing.usedFallback,
      expiresAt: new Date(pairing.expiresAt).toISOString(),
    },
  });
}

export async function createPairingImageResponse() {
  const pairing = await createPairingArtifact((url) => getQRImage(url));
  emitPairingStarted(pairing);
  return new Response(pairing.artifact, {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'no-store',
      'X-Pairing-Expires-At': new Date(pairing.expiresAt).toISOString(),
    },
  });
}

export async function logStartupPairingInfo() {
  const pairing = await createPairingArtifact((url) => getQRTerminal(url));
  emitPairingStarted(pairing);

  if (pairing.usedFallback) {
    console.warn(`\nTailscale not available, falling back to ${pairing.url}`);
  }

  console.log(`Scan to pair with ${pairing.url}:\n${pairing.artifact}\n`);
}
