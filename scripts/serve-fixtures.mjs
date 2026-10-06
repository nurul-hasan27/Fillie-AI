#!/usr/bin/env node
/**
 * Static server for the E2E fixture forms. No dependencies: plain node:http.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleMockAi, SCENARIOS } from './mock-ai.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures');
const port = Number(process.env.PORT ?? 4321);

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }
  // A deterministic stand-in for a hosted provider, used by the E2E AI tests.
  // Stand-in for an OAuth provider: an HTTP 302 to wherever `to` says, like Supabase's redirect.
  if (url.pathname === '/mock-auth/redirect') {
    // `delay` keeps the window open long enough for a test to look at it.
    await new Promise((resolve) => setTimeout(resolve, Number(url.searchParams.get('delay') ?? 0)));
    res.writeHead(302, { Location: url.searchParams.get('to') ?? '/' });
    res.end();
    return;
  }

  if (url.pathname.startsWith('/mock-ai')) {
    if (req.method === 'GET' && url.pathname === '/mock-ai') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ scenarios: SCENARIOS }));
      return;
    }
    try {
      if (await handleMockAi(req, res, url)) return;
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { message: String(error) } }));
      return;
    }
  }
  const relative = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = path.join(root, path.normalize(relative).replace(/^(\.\.[/\\])+/, ''));
  try {
    const body = await readFile(filePath);
    res.writeHead(200, {
      'content-type': types[path.extname(filePath)] ?? 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`fixtures on http://127.0.0.1:${port}`);
  console.log(`mock AI   on http://127.0.0.1:${port}/mock-ai/<${SCENARIOS.join('|')}>/v1`);
});