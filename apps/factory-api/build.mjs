// The production bundle (decision D5: the API is bundled with esbuild). src/index.ts and the @nexus/* factory
// packages it imports (they export TypeScript source) go into dist/index.js; every other package stays external and
// is loaded from node_modules at run time. Type checking is `npm run typecheck`, not this build.
import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const workspace = fileURLToPath(new URL('.', import.meta.url))

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
await build({
  absWorkingDir: workspace,
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  plugins: [externalPackages],
  logLevel: 'info',
})
