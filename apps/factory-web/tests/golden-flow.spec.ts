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

test('end checks', async () => {
  test.skip(only.size > 0 && !only.has('end-checks'), 'not in --stages')
  flow.stage = 'end-checks'
  await endChecks.after(flow)
})
