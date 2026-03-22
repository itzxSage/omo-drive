import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { transcribe } from '../../stt';
import { requireTrusted } from '../../trust';

export function registerSttRoute(app: Hono) {
  app.use('/api/stt', requireTrusted);

  app.post(
    '/api/stt',
    bodyLimit({
      maxSize: 10 * 1024 * 1024,
      onError: (c) => c.json({ error: 'Payload too large' }, 413),
    }),
    async (c) => {
      const body = await c.req.parseBody();
      const audio = body.audio;

      if (!audio || !(audio instanceof File)) {
        return c.json({ error: 'No audio file provided' }, 400);
      }

      try {
        const buffer = await audio.arrayBuffer();
        const result = await transcribe(buffer);
        return c.json(result);
      } catch (e: any) {
        return c.json({ error: e.message }, 500);
      }
    },
  );
}
