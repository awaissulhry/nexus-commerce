// NAF.A — vitest harness for @nexus/shared. Tests use the same
// `.vitest.test.ts` opt-in suffix as apps/api so the two suites follow one
// convention; the tsconfig excludes that suffix so tests never compile into
// dist/ (the package's exports point at built files).
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['*.vitest.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
    environment: 'node',
  },
})
