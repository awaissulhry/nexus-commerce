import { test } from '@playwright/test'
import { endChecks } from './golden-flow/_harness/checks'
import { Flow } from './golden-flow/_harness/flow'
import { loadStage, PLAN_STAGES, stageNames } from './golden-flow/_harness/stages'

/**
 * The one end-to-end W1 test (PLAN §4.7, B-W1-06): one brand size-run order, from a new customer to a paid invoice and a
 * CLOSED order, through the real screens, with every outside service FAKE. Three kinds of browser context: the office
 * (one per person), the links (the customer, the supplier) and the floor (enrolled tablets). The stages are the files of
 * tests/golden-flow/ (NN-name.ts), run in name order in one browser; a stage of the plan without its file is reported
 * "not built yet", a stage that says it is blocked does its part through the API and is reported with its reason. The
 * end checks close the run: an audit row for every write, the stock ledger reconciles, DDT and invoice numbers have no
 * gap, floor answers carry no cost, margin or price, link answers carry prices only of the party's own document.
 *
 * Run it with `node scripts/factory/browser-golden-flow.mjs` (it starts the stack and the web on a fresh database).
 */

const only = new Set((process.env.FACTORY_BGF_STAGES ?? '').split(',').map((name) => name.trim()).filter(Boolean))
let flow: Flow

test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({ browser }) => {
  flow = await Flow.open(browser)
  await endChecks.before(flow)
})

test.afterAll(async () => {
  await flow?.close()
})

for (const name of stageNames()) {
  test(name, async () => {
    test.skip(only.size > 0 && !only.has(name), 'not in --stages')
    const loaded = await loadStage(name)
    if (loaded.kind === 'missing') {
      test.info().annotations.push({ type: 'missing', description: `${name} is not built yet` })
      test.skip(true, `${name}: not built yet`)
      return
    }
    if (!(PLAN_STAGES as readonly string[]).includes(name)) test.info().annotations.push({ type: 'extra', description: 'not a stage of PLAN §4.7' })
    if (loaded.stage.blocked) test.info().annotations.push({ type: 'blocked', description: loaded.stage.blocked })
    test.info().annotations.push({ type: 'proves', description: loaded.stage.proves })
    flow.stage = name
    try {
      await loaded.stage.run(flow)
    } finally {
      flow.save()
    }
  })
}

// ── B-TH-302 (threads plan TH-1a): the Orders sheet of two customers and the brand wall's DOM scan, on the W1 world ──
test('th1a-sheet', async () => {
  test.skip(only.size > 0 && !only.has('th1a-sheet'), 'not in --stages')
  const { default: stage } = (await import('./golden-flow/th1a-sheet')) as { default: { proves: string; run: (flow: Flow) => Promise<void> } }
  test.info().annotations.push({ type: 'extra', description: 'TH-1a: not a stage of PLAN §4.7' }, { type: 'proves', description: stage.proves })
  flow.stage = 'th1a-sheet'
  try {
    await stage.run(flow)
  } finally {
    flow.save()
  }
})
// ── end B-TH-302 ──

// ── B-TH-227 (threads plan TH-1b): a request like an e-mail from customer A's portal to a quote draft, behind the brand wall ──
test('th1b-request', async () => {
  test.skip(only.size > 0 && !only.has('th1b-request'), 'not in --stages')
  const { default: stage } = (await import('./golden-flow/th1b-request')) as { default: { proves: string; run: (flow: Flow) => Promise<void> } }
  test.info().annotations.push({ type: 'extra', description: 'TH-1b: not a stage of PLAN §4.7' }, { type: 'proves', description: stage.proves })
  flow.stage = 'th1b-request'
  try {
    await stage.run(flow)
  } finally {
    flow.save()
  }
})
// ── end B-TH-227 ──

// ── B-TH-284 / B-TH-247 / B-TH-254 (threads plan TH-7, TH-4, TH-5): customer files, the customer sheet and projects, behind the brand
// wall; each runs alone on a fresh stack (`--stages th7-files`) or after th1b-request in the same run (the two brands made once) ──
type ThreadsStage = { default: { proves: string; blocked?: string; run: (flow: Flow) => Promise<void> } }
const THREADS_STAGES: readonly (readonly [string, string, () => Promise<ThreadsStage>])[] = [
  ['th7-files', 'TH-7', () => import('./golden-flow/th7-files') as Promise<ThreadsStage>],
  ['th4-sheet', 'TH-4', () => import('./golden-flow/th4-sheet') as Promise<ThreadsStage>],
  ['th5-projects', 'TH-5', () => import('./golden-flow/th5-projects') as Promise<ThreadsStage>],
]
for (const [name, slice, load] of THREADS_STAGES) {
  test(name, async () => {
    test.skip(only.size > 0 && !only.has(name), 'not in --stages')
    const { default: stage } = await load()
    test.info().annotations.push({ type: 'extra', description: `${slice}: not a stage of PLAN §4.7` }, { type: 'proves', description: stage.proves })
    if (stage.blocked) test.info().annotations.push({ type: 'blocked', description: stage.blocked })
    flow.stage = name
    try {
      await stage.run(flow)
    } finally {
      flow.save()
    }
  })
}
// ── end B-TH-284 / B-TH-247 / B-TH-254 ──

test('end checks', async () => {
  test.skip(only.size > 0 && !only.has('end-checks'), 'not in --stages')
  flow.stage = 'end-checks'
  await endChecks.after(flow)
})
