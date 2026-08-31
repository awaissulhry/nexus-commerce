// EV.0 — vitest harness for @nexus/events. Mirrors @nexus/shared: the
// `.vitest.test.ts` opt-in suffix matches apps/api so the suites follow one
// convention, and the tsconfig excludes that suffix so tests never compile
// into dist/ (the package's exports point at built files).
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['*.vitest.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
    environment: 'node',
  },
})
