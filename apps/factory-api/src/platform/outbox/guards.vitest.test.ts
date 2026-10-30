import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

// scripts/factory/check-event-contract.mjs and check-cron-clustered.mjs, proven on plants: each test copies the source
// folders a guard reads into a temporary root, plants one change, and runs the guard on it.

const REPO = fileURLToPath(new URL('../../../../../', import.meta.url))
const roots: string[] = []
const SCANNED = ['apps/factory-api/src', 'packages/factory-domain/src', 'packages/factory-db/src']
const SKIP = /(?:^|\/)(?:node_modules|dist|generated)(?:\/|$)/

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

type Plants = Record<string, string | ((text: string) => string)>

function tree(plants: Plants = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'factory-guards-'))
  roots.push(root)
  for (const part of SCANNED) cpSync(join(REPO, part), join(root, part), { recursive: true, filter: (source) => !SKIP.test(source.slice(REPO.length)) })
  for (const [path, plant] of Object.entries(plants)) {
    const file = join(root, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, typeof plant === 'function' ? plant(readFileSync(file, 'utf8')) : plant)
  }
  return root
}

const run = (guard: string, root?: string) => {
  const result = spawnSync(process.execPath, [join(REPO, 'scripts/factory', guard), ...(root ? [root] : [])], { encoding: 'utf8' })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

const MODULE = 'packages/factory-domain/src/quotes/events.ts'
const CATALOGUE = 'packages/factory-domain/src/events/catalogue.ts'
const quotesEvents = (body: string) => `import { z } from 'zod'\nimport { defineEvent } from '../events/define'\n\nexport const events = [\n${body}\n] as const\n`
const quoteSent = `  defineEvent({ type: 'quote.faxed', version: 1, context: 'quotes', description: 'x', payload: z.strictObject({ quoteId: z.string() }) }),`
const assembled = (text: string) => text.replace("import type { EventDefinition } from './define'", "import type { EventDefinition } from './define'\nimport { events as quotes } from '../quotes/events'")
const EMITTER = 'apps/factory-api/src/modules/quotes/service.ts'
const emitting = (event: string) => `export async function send(tools: { emit(event: unknown): void }) {\n  tools.emit(${event})\n}\n`

describe('check-event-contract', () => {
  const guard = (root?: string) => run('check-event-contract.mjs', root)

  it('passes on the repository, on an untouched copy, and with a declared, assembled and emitted event', () => {
    expect(guard()).toMatchObject({ status: 0 })
    expect(guard(tree()).status).toBe(0)
    const ok = guard(tree({ [MODULE]: quotesEvents(quoteSent), [CATALOGUE]: assembled, [EMITTER]: emitting("{ type: 'quote.faxed', subject: 'q', payload: {} }") }))
    expect(ok).toMatchObject({ status: 0, output: expect.stringMatching(/ok \(284 declared event version\(s\), 356 literal emit/) })
  })

  it.each<[string, Plants, RegExp]>([
    ['an emit of an undeclared type', { [EMITTER]: emitting("{ type: 'quote.faxed', subject: 'q', payload: {} }") }, /emit\('quote.faxed'\) — not declared/],
    ['an undeclared type behind a cast, split over lines', { [EMITTER]: emitting("{\n    type: ('quote.lost' as string),\n    subject: 'q',\n    payload: {},\n  }") }, /service.ts:2 {2}emit\('quote.lost'\)/],
    [
      'an emit of an undeclared version',
      { [MODULE]: quotesEvents(quoteSent), [CATALOGUE]: assembled, [EMITTER]: emitting("{ type: 'quote.faxed', version: 2, subject: 'q', payload: {} }") },
      /emit\('quote.faxed', version 2\) — that version is not declared/,
    ],
    ['a declaration without a payload schema', { [MODULE]: quotesEvents("  defineEvent({ type: 'quote.faxed', context: 'quotes', description: 'x' }),"), [CATALOGUE]: assembled }, /quote.faxed: no payload schema/],
    [
      'a payload that is not strict',
      { [MODULE]: quotesEvents("  defineEvent({ type: 'quote.faxed', context: 'quotes', description: 'x', payload: z.object({}) }),"), [CATALOGUE]: assembled },
      /the payload schema must be written z.strictObject/,
    ],
    ['a module events file the catalogue does not assemble', { [MODULE]: quotesEvents(quoteSent) }, /src\/quotes\/events.ts is not assembled/],
    ['a declaration outside a module events file', { 'packages/factory-domain/src/quotes/logic.ts': quotesEvents(quoteSent) }, /defineEvent\(\) outside src\/<module>\/events.ts/],
    ['a declaration in the catalogue machinery', { 'packages/factory-domain/src/events/extra.ts': quotesEvents(quoteSent) }, /defineEvent\(\) outside src\/<module>\/events.ts/],
    ['one type and version declared twice', { [MODULE]: quotesEvents(`${quoteSent}\n${quoteSent}`), [CATALOGUE]: assembled }, /quote.faxed version 1 is declared twice/],
    [
      'an event declared by another module',
      { [MODULE]: quotesEvents("  defineEvent({ type: 'quote.faxed', context: 'sales', description: 'x', payload: z.strictObject({}) }),"), [CATALOGUE]: assembled },
      /the context must be the module that declares it \('quotes'\)/,
    ],
    ['a type that is not a literal', { [MODULE]: quotesEvents("  defineEvent({ type: TYPE, context: 'quotes', description: 'x', payload: z.strictObject({}) }),"), [CATALOGUE]: assembled }, /must be a string literal/],
    ['a version that is not a whole number', { [MODULE]: quotesEvents("  defineEvent({ type: 'quote.faxed', version: 0, context: 'quotes', description: 'x', payload: z.strictObject({}) }),"), [CATALOGUE]: assembled }, /whole number literal from 1/],
    ['an outbox row written outside platform/outbox', { [EMITTER]: 'export const sneak = (tx: any) => tx.outboxEvent.createMany({ data: [] })\n' }, /outboxEvent.createMany\(\) outside platform\/outbox/],
    ['an outbox update outside platform/outbox', { [EMITTER]: 'export const sneak = (tx: any) => tx.outboxEvent.updateMany({ where: {}, data: {} })\n' }, /outboxEvent.updateMany\(\) outside platform\/outbox/],
    ['outbox SQL outside platform/outbox', { [EMITTER]: 'export const sneak = (tx: any) => tx.$executeRaw`UPDATE "OutboxEvent" SET status = \'PUBLISHED\'`\n' }, /SQL UPDATE "OutboxEvent" outside platform\/outbox/],
    ['an outbox insert in factory-db code', { 'packages/factory-db/src/sneak.ts': "export const sql = 'INSERT INTO \"OutboxEvent\" (id) VALUES ($1)'\n" }, /SQL INSERT INTO "OutboxEvent" outside platform\/outbox/],
  ])('fails on %s', (_name, plants, message) => {
    const result = guard(tree(plants))
    expect(result.status, result.output).toBe(1)
    expect(result.output).toMatch(message)
  })

  it('ignores comments, other emitters and a type held in a variable', () => {
    const plants: Plants = {
      [EMITTER]: [
        '// tools.emit({ type: \'quote.lost\' }) in a comment',
        "import { EventEmitter } from 'node:events'",
        "new EventEmitter().emit('quote.lost', { type: 'quote.lost' })",
        'export const later = (tools: { emit(event: unknown): void }, type: string) => tools.emit({ type, subject: \'q\', payload: {} })',
        '',
      ].join('\n'),
    }
    expect(guard(tree(plants)).status).toBe(0)
  })
})

describe('check-cron-clustered', () => {
  const guard = (root?: string) => run('check-cron-clustered.mjs', root)
  const MODULE_JOBS = 'apps/factory-api/src/modules/quotes/jobs.ts'

  it('passes on the repository and on an untouched copy', () => {
    expect(guard()).toMatchObject({ status: 0 })
    expect(guard(tree()).status).toBe(0)
  })

  it.each<[string, Plants, RegExp]>([
    ['a node-cron import in a module', { [MODULE_JOBS]: "import cron from 'node-cron'\ncron.schedule('* * * * *', () => {})\n" }, /jobs.ts:1 {2}rule 1: node-cron outside/],
    ['a node-cron require', { [MODULE_JOBS]: "const cron = require('node-cron')\n" }, /rule 1: node-cron outside/],
    ['a dynamic node-cron import', { [MODULE_JOBS]: "const cron = await import('node-cron')\n" }, /rule 1: node-cron outside/],
    ['a re-export of node-cron', { [MODULE_JOBS]: "export { schedule } from 'node-cron'\n" }, /rule 1: node-cron outside/],
    ['node-cron in the domain package', { 'packages/factory-domain/src/quotes/expiry.ts': "import { schedule } from 'node-cron'\n" }, /factory-domain\/src\/quotes\/expiry.ts:1 {2}rule 1/],
    ['another scheduler library', { [MODULE_JOBS]: "import schedule from 'node-schedule'\n" }, /rule 2: the scheduler library node-schedule/],
    ['the cron package', { [MODULE_JOBS]: "import { CronJob } from 'cron'\n" }, /rule 2: the scheduler library cron/],
    ['a BullMQ job scheduler', { [MODULE_JOBS]: "export const plan = (queue: any) => queue.upsertJobScheduler('expiry', { every: 60000 })\n" }, /rule 3: a BullMQ job scheduler/],
    ['a BullMQ repeatable job', { [MODULE_JOBS]: "export const plan = (queue: any) => queue.add('expiry', {}, { repeat: { every: 60000 } })\n" }, /rule 3: a BullMQ repeatable job/],
    [
      'a clustered cron that no longer claims its ticks',
      { 'apps/factory-api/src/core/cron.ts': (text) => text.replace(/settings\.redis\.set\([^\n]*'NX'\)/, "'OK'") },
      /rule 4: no tick claim/,
    ],
  ])('fails on %s', (_name, plants, message) => {
    const result = guard(tree(plants))
    expect(result.status, result.output).toBe(1)
    expect(result.output).toMatch(message)
  })

  it('ignores node-cron in a comment and in a plain string', () => {
    expect(guard(tree({ [MODULE_JOBS]: "// import cron from 'node-cron'\nexport const note = 'we do not use node-cron here'\n" })).status).toBe(0)
  })
})
