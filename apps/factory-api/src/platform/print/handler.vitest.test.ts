import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { printDispatchHandler } from './handler'
import { MAX_PRINT_ATTEMPTS } from './rules'

describe('the print.dispatch handler', () => {
  it('handles print.job_queued with as many tries as a job has, and runs in the worker (background.ts HANDLERS)', () => {
    const handler = printDispatchHandler()
    expect(handler).toMatchObject({ name: 'print.dispatch', events: ['print.job_queued'], attempts: MAX_PRINT_ATTEMPTS })
    const background = readFileSync(new URL('../../background.ts', import.meta.url), 'utf8')
    expect(background).toMatch(/const HANDLERS: readonly EventHandler\[\] = \[[^\]]*printDispatchHandler\(\)/)
  })
})
