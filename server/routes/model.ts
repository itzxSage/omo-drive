import type { Hono } from 'hono';
import { getRuntimeConfig } from '../../config';
import { requireTrusted } from '../../trust';

export function registerModelRoute(app: Hono) {
  app.use('/api/model', requireTrusted);

  app.post('/api/model', async (c) => {
    const { providerId, modelId } = await c.req.json();
    if (!providerId || !modelId) {
      return c.json({ error: 'Missing providerId or modelId' }, 400);
    }

    const { origin, basicAuth } = getRuntimeConfig().opencode;

    try {
      const providersRes = await fetch(`${origin}/config/providers`, {
        headers: { Authorization: basicAuth },
      });
      const providers = (await providersRes.json()) as any[];

      let isValid = false;
      for (const provider of providers) {
        if (provider.id === providerId) {
          if (provider.models.some((model: any) => model.id === modelId)) {
            isValid = true;
            break;
          }
        }
      }

      if (!isValid) {
        return c.json({ error: 'Invalid model or provider' }, 400);
      }

      const patchRes = await fetch(`${origin}/config`, {
        method: 'PATCH',
        headers: {
          Authorization: basicAuth,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: `${providerId}/${modelId}` }),
      });

      if (!patchRes.ok) {
        throw new Error('Failed to update OpenCode config');
      }

      return c.json({ ok: true });
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });
}
