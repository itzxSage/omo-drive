import type { Hono } from 'hono';
import { captureScreenshot } from '../../screenshot';
import { requireTrusted } from '../../trust';

export function registerScreenshotRoute(app: Hono) {
  app.use('/api/screenshot', requireTrusted);

  app.get('/api/screenshot', async (c) => {
    try {
      const display = c.req.query('display');
      const max = c.req.query('max') ? parseInt(c.req.query('max')!, 10) : undefined;
      const quality = c.req.query('quality') ? parseInt(c.req.query('quality')!, 10) : undefined;

      const jpeg = await captureScreenshot({ display, max, quality });
      return new Response(jpeg, {
        headers: {
          'Content-Type': 'image/jpeg',
        },
      });
    } catch (e: any) {
      if (e.message.includes('Rate limit')) {
        return c.text(e.message, 429);
      }
      return c.text(e.message, 500);
    }
  });
}
