/**
 * Bundle the server (and its embedding worker) for the Electron shell.
 * Native modules stay external — electron-builder packs them from node_modules.
 */
import { build } from 'esbuild'

const shared = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['better-sqlite3', '@huggingface/transformers'],
  banner: {
    // ESM bundle still needs require for the externals
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
}

await build({
  ...shared,
  entryPoints: ['../server/src/index.ts'],
  outfile: 'dist/server.mjs',
})

await build({
  ...shared,
  entryPoints: ['../server/src/search/embedWorker.ts'],
  outfile: 'dist/embedWorker.mjs',
})

console.log('server bundle built → electron/dist/')
