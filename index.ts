import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { logger } from 'hono/logger';
import { bodyLimit } from 'hono/body-limit';
import { transcribe } from './stt';
import { captureScreenshot } from './screenshot';
import { getQRTerminal, getQRImage, getTailnetURL } from './pair';

const app = new Hono();

app.use('*', logger());

app.use('/public/*', serveStatic({ root: './' }));
app.get('/', (c) => c.redirect('/public/index.html'));

const opencodeProxy = new Hono();

async function handleProxy(c: any) {
  const username = process.env.OPENCODE_SERVER_USERNAME || 'opencode';
  const password = process.env.OPENCODE_SERVER_PASSWORD || '';
  const origin = process.env.OPENCODE_SERVER_ORIGIN || 'http://127.0.0.1:4096';
  const basicAuth = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;

  const method = c.req.method;
  const url = new URL(c.req.url);
  const path = c.req.path.replace('/api/opencode', '');
  const search = url.search;
  const targetUrl = `${origin}${path}${search}`;

  try {
    const headers = new Headers(c.req.raw.headers);
    headers.set('Authorization', basicAuth);
    headers.delete('host');

    const fetchOptions: RequestInit = {
      method,
      headers,
    };

    if (method !== 'GET' && method !== 'HEAD') {
      fetchOptions.body = await c.req.raw.arrayBuffer();
    }

    const response = await fetch(targetUrl, fetchOptions);
    
    return new Response(response.body, {
      status: response.status,
      headers: response.headers,
    });
  } catch (error) {
    console.error(`[PROXY] Error proxying to ${targetUrl}:`, error);
    return c.text('Internal Server Error', 500);
  }
}

opencodeProxy.get('/global/health', handleProxy);
opencodeProxy.get('/command', handleProxy);
opencodeProxy.get('/agent', handleProxy);
opencodeProxy.get('/config', handleProxy);
opencodeProxy.get('/config/providers', handleProxy);
opencodeProxy.get('/provider', handleProxy);
opencodeProxy.get('/session', handleProxy);
opencodeProxy.post('/session', handleProxy);
opencodeProxy.get('/session/:sessionID', handleProxy);
opencodeProxy.get('/session/:sessionID/message', handleProxy);
opencodeProxy.post('/session/:sessionID/message', handleProxy);
opencodeProxy.post('/session/:sessionID/command', handleProxy);
opencodeProxy.post('/session/:sessionID/abort', handleProxy);
opencodeProxy.post('/session/:sessionID/permissions/:permissionID', handleProxy);
opencodeProxy.get('/event', handleProxy);

opencodeProxy.all('*', (c) => {
    return c.text('Forbidden', 403);
});

app.route('/api/opencode', opencodeProxy);

app.post(
  '/api/stt',
  bodyLimit({
    maxSize: 10 * 1024 * 1024,
    onError: (c) => {
      return c.json({ error: 'Payload too large' }, 413);
    },
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
  }
);

app.get('/api/screenshot', async (c) => {
  try {
    const display = c.req.query('display');
    const max = c.req.query('max') ? parseInt(c.req.query('max')!) : undefined;
    const quality = c.req.query('quality') ? parseInt(c.req.query('quality')!) : undefined;

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

app.post('/api/model', async (c) => {
  const { providerId, modelId } = await c.req.json();
  if (!providerId || !modelId) {
    return c.json({ error: 'Missing providerId or modelId' }, 400);
  }

  const username = process.env.OPENCODE_SERVER_USERNAME || 'opencode';
  const password = process.env.OPENCODE_SERVER_PASSWORD || '';
  const origin = process.env.OPENCODE_SERVER_ORIGIN || 'http://127.0.0.1:4096';
  const auth = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;

  try {
    const providersRes = await fetch(`${origin}/config/providers`, {
      headers: { 'Authorization': auth }
    });
    const providers = await providersRes.json() as any[];
    
    let isValid = false;
    for (const p of providers) {
      if (p.id === providerId) {
        if (p.models.some((m: any) => m.id === modelId)) {
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
        'Authorization': auth,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ model: `${providerId}/${modelId}` })
    });

    if (!patchRes.ok) {
      throw new Error('Failed to update OpenCode config');
    }

    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

app.get('/api/pair', async (_c) => {
  try {
    const url = await getTailnetURL();
    const png = await getQRImage(url);
    return new Response(png, {
      headers: {
        'Content-Type': 'image/png',
      },
    });
  } catch (e: any) {
    const url = 'http://localhost:8080';
    const png = await getQRImage(url);
    return new Response(png, {
      headers: {
        'Content-Type': 'image/png',
      },
    });
  }
});

export { app };

console.log('omo-drive server starting on 127.0.0.1:8080');
console.log(`Proxying /api/opencode/* to ${process.env.OPENCODE_SERVER_ORIGIN || 'http://127.0.0.1:4096'}`);

try {
  const url = await getTailnetURL();
  const qr = await getQRTerminal(url);
  console.log(`\nScan to pair with ${url}:\n${qr}\n`);
} catch (e) {
  const url = 'http://localhost:8080';
  const qr = await getQRTerminal(url);
  console.warn(`\nTailscale not available, falling back to ${url}`);
  console.log(`Scan to pair with ${url}:\n${qr}\n`);
}

export default {
  port: 8080,
  hostname: '127.0.0.1',
  fetch: app.fetch,
};
