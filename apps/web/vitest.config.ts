/**
 * AG.3 — vitest for apps/web. It did not have one.
 *
 * 89 `*.vitest.test.ts` files had accumulated in this workspace with no config and no `test`
 * script, so not one of them had ever run — not in the pre-push suite, not locally, not anywhere.
 * They were written, reviewed and committed as if they were gates. A test that cannot run is
 * worse than no test, because the absence of a failure reads as a pass.
 *
 * `environment: 'node'` rather than jsdom, and no new dependencies: all 89 are pure-logic `.ts`
 * files — zero `.tsx`, zero React imports, zero @testing-library. (One file matches `window.`,
 * inside a prose comment.) The day a test needs to render a component, that is the day to add
 * jsdom and a React plugin, and not before.
 *
 * `include` mirrors apps/api's convention: only the explicit `.vitest.test.ts` suffix is picked
 * up, so a legacy `*.test.ts` custom runner can never be swept in and fail for the wrong reason.
 * The build-dir excludes matter here in a way they do not in apps/api — `.next*` holds compiled
 * copies of the source, and without them vitest would collect and run each test twice.
 */
import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Matches `paths: { "@/*": ["./src/*"] }` in tsconfig.json — the tests import through it.
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  test: {
    include: ['src/**/*.vitest.test.ts'],
    exclude: ['node_modules/**', '.next/**', '.next-*/**', 'dist/**'],
    environment: 'node',
    testTimeout: 10_000,
  },
})
