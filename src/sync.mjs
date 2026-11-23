#!/usr/bin/env node
// Syncs Antigravity (App, IDE, CLI) sessions into local CSV ledgers and standalone board.html.
// Modes: sync (full scan), hook (single-session Stop hook), open (sync + open board.html).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { DatabaseSync } from 'node:sqlite';
import { boardHtml, tasksFrom } from './board-ui.mjs';

const HOME = os.homedir();
const GEMINI_DIR = path.join(HOME, '.gemini');
export const LEDGER_DIR = process.env.ANTIGRAVITY_BOARD_DIR
  || path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'antigravity-board');
export const BOARD_HTML_PATH = path.join(LEDGER_DIR, 'board.html');

const PRODUCTS = ['antigravity', 'antigravity-ide', 'antigravity-cli'];
const CSV_HEADER = 'key,started,project,name,cost_usd,turns,agent_minutes,tokens_total,tokens_output,reuse_pct,reused,new,callers_open,tests,level,model';
const IDLE_MS = 30 * 60000;
const TEST_CMD = /\b(npm (run )?test|pnpm (run )?test|yarn test|bun test|npx (jest|vitest)|jest|vitest|pytest|python3? -m pytest|go test|cargo test|mvn test|gradle test|rspec|phpunit|dotnet test|node --test|deno test|make test)\b/;

// Gemini Pro-tier API-equivalent USD per 1M tokens [input, cacheRead, output].
// shortcut: flat estimate because Antigravity transcripts do not log billing tier per step; refine if logged.
const EST_RATES = [1.25, 0.125, 10];

const two = n => String(n).padStart(2, '0');
const stamp = t => {
  const d = new Date(t);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
};
const csvField = v => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function projectFromUris(urisRaw) {
  let first = '';
  if (Array.isArray(urisRaw)) first = urisRaw[0] || '';
  else if (typeof urisRaw === 'string' && urisRaw.trim()) {
    try {
      const parsed = JSON.parse(urisRaw);
      first = Array.isArray(parsed) ? (parsed[0] || '') : urisRaw;
    } catch { first = urisRaw; }
  }
  if (!first) return 'general';
  let clean = first.replace(/^file:\/\/\/+/i, '');
  try { clean = decodeURIComponent(clean); } catch {}
  clean = clean.replace(/[\\/]+$/, '');
  if (!clean || /^[a-z]:$/i.test(clean)) return 'general';
  const base = path.basename(clean);
  if (!base || /^[a-z]:$/i.test(base) || /^(system32|windows|pc|users)$/i.test(base)) return 'general';
  return base;
}

function cleanUserPrompt(raw) {
  if (!raw) return '';
  return String(raw)
    .replace(/<USER_REQUEST>/gi, '')
    .replace(/<\/USER_REQUEST>[\s\S]*/i, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

function loadDbMetadata() {
  const meta = new Map();
  for (const prod of ['antigravity', 'antigravity-cli']) {
    const dbPath = path.join(GEMINI_DIR, prod, 'conversation_summaries.db');
    if (!fs.existsSync(dbPath)) continue;
    try {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      const rows = db.prepare(
        'SELECT conversation_id, title, preview, workspace_uris, nesting_depth, app_data_dir FROM conversation_summaries'
      ).all();
      db.close();
      for (const r of rows) {
        const prev = meta.get(r.conversation_id);
        if (!prev || (!prev.title && r.title) || (!prev.workspace_uris && r.workspace_uris)) {
          meta.set(r.conversation_id, r);
        }
      }
    } catch {
      // Ignore transient lock or unreadable DB; transcript data still works standalone.
    }
  }
  return meta;
}

function normalizeModel(raw) {
  if (!raw) return 'antigravity';
  const s = String(raw).toLowerCase();
  const g = s.match(/gemini\s*(\d+(?:\.\d+)?)/);
  if (g) return `gemini-${g[1].replace('.', '-')}`;
  const c = s.match(/claude[- ]?(opus|sonnet|haiku)[- ]?(\d+(?:[.-]\d+)?)/);
  if (c) return `claude-${c[1]}-${c[2].replace('.', '-')}`;
  return 'antigravity';
}

export function parseTranscript(file) {
  let turns = 0;
  let startedMs = NaN;
  let agentMs = 0;
  let inTok = 0;
  let outTok = 0;
  let cacheTok = 0;
  let firstUser = '';
  let model = '';
  let inTurn = false;
  let prevMs = NaN;
  let hasModelReply = false;
  let lastEditIdx = -1;
  let lastTestIdx = -1;
  let lastTestState = '';
  let idx = 0;

  const take = line => {
    if (!line || line[0] !== '{') return;
    let r;
    try { r = JSON.parse(line); } catch { return; }
    idx++;
    const t = r.created_at ? Date.parse(r.created_at) : NaN;
    if (!Number.isFinite(startedMs) && Number.isFinite(t)) startedMs = t;

    if (r.type === 'USER_INPUT' && r.source === 'USER_EXPLICIT') {
      turns++;
      inTurn = true;
      prevMs = t;
      if (!firstUser && r.content) firstUser = cleanUserPrompt(r.content);
      return;
    }

    if (r.type === 'USER_SETTINGS_CHANGE' && r.content && !model) {
      const m = String(r.content).match(/Model Selection`?\s+from\s+\S+\s+to\s+([^\n.]+)/i);
      if (m) model = normalizeModel(m[1]);
    }

    if (r.type === 'PLANNER_RESPONSE') {
      hasModelReply = true;
      inTok += Number(r.input_tokens) || 0;
      outTok += Number(r.output_tokens) || 0;
      cacheTok += Number(r.cache_read_tokens) || 0;
      if (Array.isArray(r.tool_calls)) {
        for (const tc of r.tool_calls) {
          const name = String(tc?.name || '');
          if (/edit_file|write_file|replace_file|multi_replace/.test(name)) lastEditIdx = idx;
          if (name === 'run_command' && tc?.arguments) {
            const cmd = String(tc.arguments.CommandLine || tc.arguments.command || '');
            if (TEST_CMD.test(cmd)) lastTestIdx = idx;
          }
        }
      }
    }

    if (r.type === 'RUN_COMMAND' && lastTestIdx === idx - 1) {
      const passed = r.exit_code === 0;
      const out = String(r.content || '');
      const pm = out.match(/(\d+)\s+(?:passed|passing)\b/i);
      const fm = out.match(/(\d+)\s+(?:failed|failing)\b/i);
      lastTestState = passed ? `${pm ? pm[1] + ' ' : ''}passed` : `${fm ? fm[1] + ' ' : ''}failed`;
    }

    if (inTurn && Number.isFinite(t)) {
      if (Number.isFinite(prevMs) && t > prevMs && t - prevMs <= IDLE_MS) agentMs += t - prevMs;
      prevMs = Math.max(Number.isFinite(prevMs) ? prevMs : t, t);
    }
  };

  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(1 << 20);
  const dec = new StringDecoder('utf8');
  let rest = '';
  try {
    for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) {
      const parts = (rest + dec.write(buf.subarray(0, n))).split('\n');
      rest = parts.pop();
      for (const p of parts) take(p);
    }
    take(rest + dec.end());
  } finally {
    fs.closeSync(fd);
  }

  if (!turns || !hasModelReply || !Number.isFinite(startedMs)) return null;
  const tokensTotal = inTok + outTok + cacheTok;
  const costUsd = tokensTotal > 0
    ? (inTok * EST_RATES[0] + cacheTok * EST_RATES[1] + outTok * EST_RATES[2]) / 1e6
    : 0;
  const tests = lastTestState && lastEditIdx > lastTestIdx ? 'stale' : lastTestState;

  return {
    startedMs,
    turns,
    agentMs: Math.max(agentMs, 6000),
    tokensTotal,
    tokensOutput: outTok,
    costUsd,
    firstUser,
    tests,
    model: model || 'antigravity',
  };
}

function buildCsvRow(convId, project, title, stats, level = 'import') {
  const key = `agy-${convId.slice(0, 8)}`;
  const name = (title || stats.firstUser || 'Untitled session').replace(/\s+/g, ' ').trim().slice(0, 60);
  return [
    key,
    stamp(stats.startedMs),
    project,
    name,
    stats.costUsd > 0 ? stats.costUsd.toFixed(2) : '',
    stats.turns,
    (stats.agentMs / 60000).toFixed(1),
    stats.tokensTotal,
    stats.tokensOutput,
    '', '', '', '',
    stats.tests,
    level,
    stats.model,
  ].map(csvField).join(',');
}

function upsertProjectCsv(project, newRowsByKey) {
  fs.mkdirSync(LEDGER_DIR, { recursive: true });
  const file = path.join(LEDGER_DIR, `${project.replace(/[^\w.-]/g, '_')}.csv`);
  const existingLines = fs.existsSync(file)
    ? fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(l => l && !l.startsWith('key,'))
    : [];
  const kept = [];
  const replaced = new Set();
  for (const line of existingLines) {
    const key = line.slice(0, line.indexOf(','));
    if (newRowsByKey.has(key)) {
      kept.push(newRowsByKey.get(key));
      replaced.add(key);
    } else {
      kept.push(line);
    }
  }
  for (const [key, row] of newRowsByKey) {
    if (!replaced.has(key)) kept.push(row);
  }
  fs.writeFileSync(file, [CSV_HEADER, ...kept].join('\n') + '\n', 'utf8');
}

export function loadBoardTasks() {
  fs.mkdirSync(LEDGER_DIR, { recursive: true });
  const tasks = [];
  for (const f of fs.readdirSync(LEDGER_DIR).filter(x => x.endsWith('.csv'))) {
    try { tasks.push(...tasksFrom(fs.readFileSync(path.join(LEDGER_DIR, f), 'utf8'))); } catch {}
  }
  return tasks;
}

export function writeBoardHtml(tasks = loadBoardTasks(), now = Date.now()) {
  const html = boardHtml(tasks, now);
  fs.mkdirSync(LEDGER_DIR, { recursive: true });
  fs.writeFileSync(BOARD_HTML_PATH, html, 'utf8');
  return { count: tasks.length, htmlPath: BOARD_HTML_PATH };
}

export function syncAll() {
  const meta = loadDbMetadata();
  const seen = new Set();
  const byProject = new Map();

  for (const prod of PRODUCTS) {
    const brainDir = path.join(GEMINI_DIR, prod, 'brain');
    if (!fs.existsSync(brainDir)) continue;
    let dirs = [];
    try { dirs = fs.readdirSync(brainDir); } catch { continue; }
    for (const id of dirs) {
      if (seen.has(id)) continue;
      const info = meta.get(id);
      if (info && Number(info.nesting_depth) > 0) continue;
      const tPath = path.join(brainDir, id, '.system_generated', 'logs', 'transcript.jsonl');
      if (!fs.existsSync(tPath)) continue;
      seen.add(id);
      let stats;
      try { stats = parseTranscript(tPath); } catch { continue; }
      if (!stats) continue;
      const project = projectFromUris(info?.workspace_uris);
      const title = info?.title || '';
      const row = buildCsvRow(id, project, title, stats, 'import');
      if (!byProject.has(project)) byProject.set(project, new Map());
      byProject.get(project).set(`agy-${id.slice(0, 8)}`, row);
    }
  }

  for (const [project, rowsMap] of byProject) upsertProjectCsv(project, rowsMap);
  const res = writeBoardHtml();
  return { synced: seen.size, projects: byProject.size, ...res };
}

export function runHook() {
  let raw = '';
  try { raw = fs.readFileSync(0, 'utf8'); } catch {}
  let payload = {};
  try { payload = raw ? JSON.parse(raw) : {}; } catch {}

  const id = payload.conversationId;
  const tPath = payload.transcriptPath;
  if (id && tPath && fs.existsSync(tPath)) {
    const meta = loadDbMetadata().get(id);
    if (!meta || Number(meta.nesting_depth) === 0) {
      const stats = parseTranscript(tPath);
      if (stats) {
        if (payload.modelName && stats.model === 'antigravity') stats.model = normalizeModel(payload.modelName);
        const project = projectFromUris(payload.workspacePaths?.length ? payload.workspacePaths : meta?.workspace_uris);
        const row = buildCsvRow(id, project, meta?.title || '', stats, 'full');
        upsertProjectCsv(project, new Map([[`agy-${id.slice(0, 8)}`, row]]));
        writeBoardHtml();
      }
    }
  }
  process.stdout.write('{}\n');
}

export function openBoard() {
  if (process.platform === 'win32') {
    execFile('cmd.exe', ['/c', 'start', '', BOARD_HTML_PATH], { windowsHide: true });
  } else if (process.platform === 'darwin') {
    execFile('open', [BOARD_HTML_PATH]);
  } else {
    execFile('xdg-open', [BOARD_HTML_PATH]);
  }
}
