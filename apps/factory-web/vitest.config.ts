import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.vitest.test.ts'],
    exclude: ['node_modules/**', '.next/**', '.next-*/**'],
    environment: 'node',
  },
})
