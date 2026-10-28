import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.vitest.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
    environment: 'node',
    // The test-database guard (src/testing/global-setup.ts): no test starts on a database that is not a loopback
    // factory_test… or this worktree's factory_<branch>.
    globalSetup: ['./src/testing/global-setup.ts'],
    env: { FACTORY_ENV: 'test' },
  },
})
