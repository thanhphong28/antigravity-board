import { build } from 'esbuild';

// 1. Browser IIFE bundle for @modelcontextprotocol/ext-apps iframe bridge
await build({
  entryPoints: ['src/bridge.mjs'],
  bundle: true,
  format: 'iife',
  minify: true,
  outfile: 'dist/bridge.js',
});

// 2. Standalone Node ESM bundle for sync CLI & Stop hook (zero runtime node_modules needed)
await build({
  entryPoints: ['src/sync-cli.mjs'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'bundle',
  outfile: 'dist/sync.mjs',
});

// 3. Standalone Node ESM bundle for MCP App stdio server (zero runtime node_modules needed)
await build({
  entryPoints: ['src/server.mjs'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'bundle',
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  outfile: 'dist/server.mjs',
});

console.log('Built dist/bridge.js, dist/sync.mjs, and dist/server.mjs');
