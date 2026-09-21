// Harness for @nexus/database's own scripts. Follows the convention already used by
// @nexus/shared and @nexus/events: the `.vitest.test.ts` opt-in suffix, node environment.
//
// Scoped to `scripts/` deliberately. This package's other surface is generated Prisma client
// code, which is not ours to test here.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['scripts/**/*.vitest.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
    environment: 'node',
    testTimeout: 20_000,
  },
})
