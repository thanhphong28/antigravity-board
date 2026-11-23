#!/usr/bin/env node
// MCP App stdio server for Antigravity Board by BreezeAI.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { boardHtml } from './board-ui.mjs';
import { loadBoardTasks, syncAll } from './sync.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_URI = 'ui://antigravity-board/app.html';
const MIME_TYPE = 'text/html;profile=mcp-app';
const BRIDGE_PATH = path.join(__dirname, 'bridge.js');

function summarize(tasks) {
  const projects = new Set(tasks.map(t => t.project)).size;
  const totalMin = Math.round(tasks.reduce((a, t) => a + (t.agentMinutes || 0), 0));
  const totalTok = tasks.reduce((a, t) => a + (t.tokens || 0), 0);
  const totalCost = tasks.reduce((a, t) => a + (t.cost || 0), 0);
  const hrs = totalMin < 60 ? `${totalMin}m` : `${Math.floor(totalMin / 60)}h ${totalMin % 60}m`;
  const tok = totalTok < 1e6 ? `${(totalTok / 1e3).toFixed(1)}k` : `${(totalTok / 1e6).toFixed(1)}M`;
  return `Antigravity Board: ${tasks.length} sessions across ${projects} projects · ${hrs} agent time · ${tok} tokens · $${totalCost.toFixed(2)} est.`;
}

function getTasksOrInitialSync() {
  let tasks = loadBoardTasks();
  if (tasks.length === 0) {
    syncAll();
    tasks = loadBoardTasks();
  }
  return tasks;
}

function buildMcpAppHtml() {
  const tasks = getTasksOrInitialSync();
  const now = Date.now();
  const html = boardHtml(tasks, now);
  const bridgeJs = fs.readFileSync(BRIDGE_PATH, 'utf8');
  const safeBridge = bridgeJs.replace(/<\/script>/gi, '<\\/script>');
  // Use a function replacer so `$` sequences in minified JS are never expanded as regex backreferences.
  return html.replace('</body>', () => `<script>${safeBridge}</script></body>`);
}

const server = new Server(
  { name: 'antigravity-board', version: '1.0.0' },
  { capabilities: { tools: {}, resources: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'open_antigravity_board',
      title: 'Antigravity Board',
      description: 'Open Antigravity Board showing Antigravity (App, IDE & CLI) sessions, agent time, tokens, estimated cost, and 12-week activity heatmap.',
      inputSchema: {
        type: 'object',
        properties: {
          sync: {
            type: 'boolean',
            description: 'If true, perform a full resync of all historical sessions before returning.',
          },
        },
      },
      _meta: {
        ui: { resourceUri: APP_URI },
        'com.google.antigravity/ui': {
          entrypoints: [
            { type: 'aux_pane', title: 'Antigravity Board' },
            { type: 'global', title: 'Antigravity Board' },
          ],
        },
      },
    },
    {
      name: 'sync_antigravity_board',
      title: 'Sync Antigravity Board',
      description: 'Resync all Antigravity (App, IDE, CLI) sessions and return updated board data.',
      inputSchema: { type: 'object', properties: {} },
      _meta: {
        ui: { visibility: ['app'] },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  if (name === 'open_antigravity_board') {
    if (args?.sync) syncAll();
    const tasks = getTasksOrInitialSync();
    const now = Date.now();
    return {
      content: [{ type: 'text', text: summarize(tasks) }],
      structuredContent: { now, tasks },
    };
  }
  if (name === 'sync_antigravity_board') {
    syncAll();
    const tasks = loadBoardTasks();
    const now = Date.now();
    return {
      content: [{ type: 'text', text: summarize(tasks) }],
      structuredContent: { now, tasks },
    };
  }
  throw new Error(`Unknown tool: ${name}`);
});

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: APP_URI,
      name: 'Antigravity Board',
      mimeType: MIME_TYPE,
      _meta: { ui: { prefersBorder: false } },
    },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  if (req.params.uri !== APP_URI) {
    throw new Error(`Unknown resource: ${req.params.uri}`);
  }
  return {
    contents: [
      {
        uri: APP_URI,
        mimeType: MIME_TYPE,
        text: buildMcpAppHtml(),
        _meta: { ui: { prefersBorder: false } },
      },
    ],
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
