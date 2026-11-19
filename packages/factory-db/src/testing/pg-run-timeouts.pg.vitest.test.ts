import { describe, expect, it } from 'vitest'

/**
 * fx-10 (end check): a PostgreSQL run (FACTORY_PG_TEST_RUN) gives each test 30 s and each hook 30 s (vitest.config.ts), as
 * factory-api's suite; a plain run keeps vitest's 5 s.
 */
describe('the factory-db PostgreSQL suite’s timeouts (vitest.config.ts)', () => {
  it('a test without its own timeout gets 30 s in a PostgreSQL run, vitest’s 5 s otherwise', ({ task }) => {
    expect(task.timeout).toBe(process.env.FACTORY_PG_TEST_RUN ? 30_000 : 5_000)
  })
})
