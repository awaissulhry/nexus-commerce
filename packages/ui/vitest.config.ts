/**
 * vitest for @nexus/ui — the design system's own tests, which ran from apps/web until the design system moved here.
 * The same settings as apps/web/vitest.config.ts: Node environment (logic, not rendering), Next's preserved JSX compiled
 * by oxc, and only the explicit `.vitest.test.ts` suffix. No alias: the design system imports only its own files
 * (relative) and npm packages.
 *
 *   cd packages/ui && npx vitest run
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Component contract tests render the real editors in Node; compile Next's preserved JSX.
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    include: ['src/**/*.vitest.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
    environment: 'node',
    testTimeout: 10_000,
  },
})
