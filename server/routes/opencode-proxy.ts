import { Hono } from 'hono';
import { getRuntimeConfig } from '../../config';
import { requireTrusted } from '../../trust';

const UPSTREAM_BLOCKED_HEADERS = ['cookie', 'x-omo-trust'];

async function handleProxy(c: any) {
  const { origin, basicAuth } = getRuntimeConfig().opencode;

  const method = c.req.method;
  const url = new URL(c.req.url);
  const path = c.req.path.replace('/api/opencode', '');
  const search = url.search;
  const targetUrl = `${origin}${path}${search}`;

  try {
    const headers = new Headers(c.req.raw.headers);
    headers.set('Authorization', basicAuth);
    headers.delete('host');
    for (const headerName of UPSTREAM_BLOCKED_HEADERS) {
      headers.delete(headerName);
    }

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

export function createOpencodeProxyApp() {
  const opencodeProxy = new Hono();

  opencodeProxy.use('*', requireTrusted);
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
  opencodeProxy.all('*', (c) => c.text('Forbidden', 403));

  return opencodeProxy;
}

export function registerOpencodeProxyRoutes(app: Hono) {
  app.route('/api/opencode', createOpencodeProxyApp());
}
