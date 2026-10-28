import { defineConfig } from 'vitest/config'

export default defineConfig({
  // The design system (packages/ui) keeps its JSX for the app to compile (its tsconfig: preserve), as the Commerce web's
  // vitest config says: compile it here too, so a test can render a view in Node.
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    include: ['src/**/*.vitest.test.ts'],
    exclude: ['node_modules/**', '.next/**', '.next-*/**'],
    environment: 'node',
  },
})
