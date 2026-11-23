#!/usr/bin/env node
// CLI & Stop hook entrypoint for Antigravity Board sync (kept separate from sync.mjs so bundling server.mjs never writes to stdout).

import { openBoard, runHook, syncAll } from './sync.mjs';

const mode = process.argv[2] || 'sync';
if (mode === 'hook') {
  try { runHook(); } catch { process.stdout.write('{}\n'); }
} else if (mode === 'open') {
  const res = syncAll();
  openBoard();
  console.log(`Antigravity Board synced (${res.count} sessions across ${res.projects} projects) -> ${res.htmlPath}`);
} else {
  const res = syncAll();
  console.log(`Antigravity Board synced (${res.count} sessions across ${res.projects} projects) -> ${res.htmlPath}`);
}
