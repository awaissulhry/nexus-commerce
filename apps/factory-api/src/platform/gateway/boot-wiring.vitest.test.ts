import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// The boot rule of plan A1 §4 runs where the processes boot (it is tested on PostgreSQL in gateway.pg): src/index.ts
// and src/background.ts call assertNoFakeAccountsInProduction() right after the database opens and before anything
// serves or consumes, and the worker runs the inbound ledger's handler. A source check: the processes cannot be started
// with FACTORY_ENV=production on this machine (env.ts refuses it off Railway).

const source = (file: string) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')
const order = (text: string, ...marks: string[]): number[] => marks.map((mark) => text.indexOf(mark))

describe('the boot wiring', () => {
  it('the API checks for FAKE accounts after the database opens and before the app is built', () => {
    const [open = -1, check = -1, build = -1] = order(source('index.ts'), 'await openFactoryDatabase(', 'await assertNoFakeAccountsInProduction(database, env.FACTORY_ENV)', 'await buildApp(')
    expect(open).toBeGreaterThan(-1)
    expect(check).toBeGreaterThan(open)
    expect(build).toBeGreaterThan(check)
  })

  it('the worker and scheduler check too, before the queues open, and the worker runs the inbound handler', () => {
    const text = source('background.ts')
    const [open = -1, check = -1, queues = -1] = order(text, 'await openFactoryDatabase(', 'await assertNoFakeAccountsInProduction(database, env.FACTORY_ENV)', 'const kit = openQueues(')
    expect(open).toBeGreaterThan(-1)
    expect(check).toBeGreaterThan(open)
    expect(queues).toBeGreaterThan(check)
    expect(text).toMatch(/const HANDLERS: readonly EventHandler\[\] = \[[^\]]*inboundHandler\(\)/)
  })
})
