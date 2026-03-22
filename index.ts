import { getRuntimeConfig } from './config';
import { getQRTerminal, getTailnetURL } from './pair';
import { createApp } from './server/app';

export { createApp } from './server/app';

export const app = createApp();

async function logStartupInfo() {
  const runtimeConfig = getRuntimeConfig();

  console.log(
    `omo-drive server starting on ${runtimeConfig.server.hostname}:${runtimeConfig.server.port}`,
  );
  console.log(`Proxying /api/opencode/* to ${runtimeConfig.opencode.origin}`);

  try {
    const url = await getTailnetURL();
    const qr = await getQRTerminal(url);
    console.log(`\nScan to pair with ${url}:\n${qr}\n`);
  } catch {
    const url = runtimeConfig.pair.fallbackUrl;
    const qr = await getQRTerminal(url);
    console.warn(`\nTailscale not available, falling back to ${url}`);
    console.log(`Scan to pair with ${url}:\n${qr}\n`);
  }
}

if (import.meta.main) {
  await logStartupInfo();
}

export default {
  get port() {
    return getRuntimeConfig().server.port;
  },
  get hostname() {
    return getRuntimeConfig().server.hostname;
  },
  fetch(request: Request, server: Bun.Server<any>) {
    return app.fetch(request, server);
  },
};
