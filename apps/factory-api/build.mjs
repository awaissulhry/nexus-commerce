// The production build (decision D5: the API is bundled with esbuild). Entry points: src/index.ts (the API),
// src/background.ts (the worker and the scheduler: `node dist/background.js worker|scheduler`) and every routes file of
// src/platform/* and src/modules/*, found by the same function the app loads them with at run time
// (src/core/autoload.ts), so dev and prod cannot drift. Output mirrors src/: dist/index.js, dist/background.js,
// dist/platform/<name>/routes.js, dist/modules/<name>/routes.js; at run time dist/index.js finds those files the way
// src/index.ts finds the .ts ones.
//
// ESM with code splitting: code shared by index.js, background.js and the routes files (src/core, the @nexus/* factory
// packages, the generated Prisma client) goes into chunks they all import, so every module exists ONCE at run time:
// one route manifest registry, one DomainError class for `instanceof`. The build checks that from esbuild's metafile
// and fails if any source file landed in two outputs. Chunks sit beside index.js, so a path built from import.meta.url
// (env.ts: ../.env) resolves the same from every output.
//
// The @nexus/* factory packages export TypeScript source and are bundled; every other package stays external and is
// loaded from node_modules at run time. Type checking is `npm run typecheck`, not this build. `npm run build` runs
// prisma generate first (the bundle includes factory-db's generated client).
import { rmSync } from 'node:fs'
import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { tsImport } from 'tsx/esm/api'

const workspace = fileURLToPath(new URL('.', import.meta.url))
const source = fileURLToPath(new URL('./src', import.meta.url))
const { routesFiles } = await tsImport('./src/core/autoload.ts', import.meta.url)
const routes = routesFiles(source).map((file) => relative(workspace, file))
// B-W2a-32: the search indexers, one file per record type, found by folder at run time like the routes.
const { indexerFiles } = await tsImport('./src/platform/search/indexer-files.ts', import.meta.url)
const indexers = indexerFiles(source).map((file) => relative(workspace, file))

/** Bare imports stay external, except the workspace's own @nexus/* packages. */
const externalPackages = {
  name: 'external-packages',
  setup(builder) {
    builder.onResolve({ filter: /^[^./]/ }, (args) =>
      args.path.startsWith('@nexus/') ? undefined : { path: args.path, external: true },
    )
  },
}

rmSync(new URL('./dist', import.meta.url), { recursive: true, force: true })
const result = await build({
  absWorkingDir: workspace,
  entryPoints: ['src/index.ts', 'src/background.ts', ...routes, ...indexers],
  outbase: 'src',
  outdir: 'dist',
  bundle: true,
  splitting: true,
  chunkNames: '[name]-[hash]',
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  metafile: true,
  plugins: [externalPackages],
  logLevel: 'info',
})

// One instance per module: no source file may sit in two outputs.
const outputsOf = new Map()
for (const [output, { inputs }] of Object.entries(result.metafile.outputs)) {
  for (const input of Object.keys(inputs)) outputsOf.set(input, [...(outputsOf.get(input) ?? []), output])
}
const doubled = [...outputsOf].filter(([, outputs]) => outputs.length > 1)
if (doubled.length > 0) {
  console.error(`build: ${doubled.length} module(s) copied into more than one output (two instances at run time):`)
  for (const [input, outputs] of doubled) console.error(`  ${input}: ${outputs.join(', ')}`)
  process.exit(1)
}
console.log(`build: dist/index.js + dist/background.js + ${routes.length} routes file(s) + ${indexers.length} search indexer(s); ${outputsOf.size} modules, each in exactly one output`)
