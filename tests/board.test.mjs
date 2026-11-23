import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { projectFromUris } from '../src/sync.mjs';
import { boardHtml } from '../src/board-ui.mjs';

test('projectFromUris normalizes Windows, URI-encoded, and drive-root paths', () => {
  assert.equal(projectFromUris('["file:///d%3A/Frontend"]'), 'Frontend');
  assert.equal(projectFromUris('["file:///D:/Frontend"]'), 'Frontend');
  assert.equal(projectFromUris('["file:///d%3A/"]'), 'general');
  assert.equal(projectFromUris(''), 'general');
  assert.equal(projectFromUris(['D:\\konoha-ai']), 'konoha-ai');
});

test('boardHtml renders BreezeAI & Antigravity Board branding with valid JS', () => {
  const html = boardHtml([
    {
      started: '2026-11-23 10:00',
      project: 'demo',
      name: 'Test session',
      cost: 0.42,
      turns: 3,
      agentMinutes: 5.5,
      tokens: 120000,
      reuse: null,
      tests: 'passed',
      level: 'full',
      model: 'gemini-4',
    },
  ], Date.now());
  assert.ok(html.includes('<title>Antigravity Board</title>'));
  assert.ok(html.includes('BreezeAI'));
  assert.ok(!/ponytail/i.test(html), 'Unexpected Ponytail branding in rendered HTML');
});

test('bundled dist/server.mjs speaks MCP Apps protocol cleanly', async () => {
  const serverPath = path.resolve('dist/server.mjs');
  const transport = new StdioClientTransport({ command: 'node', args: ['--no-warnings', serverPath] });
  const client = new Client({ name: 'test-host', version: '1.0.0' }, {});
  await client.connect(transport);

  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 2);
    const openTool = tools.find(t => t.name === 'open_antigravity_board');
    const syncTool = tools.find(t => t.name === 'sync_antigravity_board');
    assert.equal(openTool._meta.ui.resourceUri, 'ui://antigravity-board/app.html');
    assert.deepEqual(
      openTool._meta['com.google.antigravity/ui'].entrypoints.map(e => `${e.type}:${e.title}`),
      ['aux_pane:Antigravity Board', 'global:Antigravity Board']
    );
    assert.deepEqual(syncTool._meta.ui.visibility, ['app']);

    const { resources } = await client.listResources();
    assert.equal(resources[0].uri, 'ui://antigravity-board/app.html');
    assert.equal(resources[0].mimeType, 'text/html;profile=mcp-app');

    const res = await client.readResource({ uri: 'ui://antigravity-board/app.html' });
    const html = res.contents[0].text;
    assert.equal(res.contents[0].mimeType, 'text/html;profile=mcp-app');
    assert.equal((html.match(/<!doctype html>/gi) || []).length, 1);
    assert.ok(Buffer.byteLength(html, 'utf8') < 2 * 1024 * 1024);

    // Ensure both inline scripts parse without syntax errors
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    assert.equal(scripts.length, 2);
    new Function(scripts[0]);
    new Function(scripts[1]);

    const callRes = await client.callTool({ name: 'open_antigravity_board', arguments: {} });
    assert.ok(callRes.content[0].text.startsWith('Antigravity Board:'));
    assert.ok(Array.isArray(callRes.structuredContent.tasks));
  } finally {
    await client.close();
  }
});
