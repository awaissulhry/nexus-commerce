import { defineConfig } from '@playwright/test'

/**
 * The browser golden flow's Playwright configuration (B-W1-06). scripts/factory/browser-golden-flow.mjs starts the stack
 * and the web and passes their addresses (FACTORY_BGF_*); the spec makes its own browser contexts (office people, links,
 * tablets), so `use` holds only what every context shares. One worker, one spec, the stages in order.
 */
const out = process.env.FACTORY_BGF_OUT

export default defineConfig({
  testDir: '../..',
  testMatch: 'golden-flow.spec.ts',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  // A stage walks several screens; the slowest (the floor's production) takes a few minutes on a loaded machine.
  timeout: 20 * 60_000,
  expect: { timeout: 30_000 },
  reporter: [['list'], ...(process.env.FACTORY_BGF_REPORT ? [['json', { outputFile: process.env.FACTORY_BGF_REPORT }] as const] : [])],
  outputDir: out ? `${out}/test-results` : undefined,
  use: {
    baseURL: process.env.FACTORY_BGF_WEB,
    actionTimeout: 30_000,
    navigationTimeout: 120_000,
    locale: 'en-GB',
    timezoneId: 'Europe/Rome',
  },
})
