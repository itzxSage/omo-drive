import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { logger } from 'hono/logger';
import { registerModelRoute } from './routes/model';
import { registerOpencodeProxyRoutes } from './routes/opencode-proxy';
import { registerPairRoutes } from './routes/pair';
import { registerScreenshotRoute } from './routes/screenshot';
import { registerSttRoute } from './routes/stt';
import { registerTrustRoute } from './routes/trust';
import { createProductApi } from '../product-api';
import { createProductStore, type ProductStore } from '../product-store';
import { getRuntimeConfig } from '../config';
import { setTrustAuditReporter } from '../trust';

type CreateAppOptions = {
  productStore?: ProductStore;
};

export function createApp(options: CreateAppOptions = {}) {
  const runtimeConfig = getRuntimeConfig();
  const app = new Hono();

  app.use('*', logger());
  app.use('/public/*', serveStatic({ root: './' }));
  app.get('/', (c) => c.redirect('/public/index.html'));

  registerOpencodeProxyRoutes(app);
  registerSttRoute(app);
  const productStore = options.productStore ?? createProductStore({ databasePath: process.env.OMO_DRIVE_PRODUCT_STORE_PATH });
  setTrustAuditReporter((event) => {
    productStore.appendAuditEvent({
      eventId: crypto.randomUUID(),
      ...event,
    });
  });

  registerTrustRoute(app);
  registerScreenshotRoute(app);
  registerModelRoute(app);
  registerPairRoutes(app);

  app.route('/api/product', createProductApi({ productStore }));

  return app;
}
