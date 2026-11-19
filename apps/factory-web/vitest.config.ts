import { defineConfig } from 'vitest/config'

export default defineConfig({
  // The design system (packages/ui) keeps its JSX for the app to compile (its tsconfig: preserve), as the Commerce web's
  // vitest config says: compile it here too, so a test can render a view in Node.
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    include: ['src/**/*.vitest.test.ts'],
    exclude: ['node_modules/**', '.next/**', '.next-*/**'],
    environment: 'node',
    // The design-case tests draw every case of a screen in both languages in ONE test (SCR-039: 169 cases × it, en). On the Mac
    // that is 0.1–2 s; on the shared CI runner it is 3–4 times slower, and the first full end check on GitHub (run 44416200778)
    // timed out five of them at vitest's default 5 s while each passed (SCR-059 passed at 4.8 s). A hang still fails, at 30 s.
    testTimeout: 30_000,
  },
})
