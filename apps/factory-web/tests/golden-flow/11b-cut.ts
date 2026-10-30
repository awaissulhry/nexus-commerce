import { expect } from '@playwright/test'
import { drained, quiet, scanUntil, signIn, tablet, tile, worker } from './_harness/floor'
import { defineStage } from './_harness/stages'
import { press } from './_harness/ui'

/** Two sets of one size per hide: the size run 50 ×2, 52 ×4, 54 ×2 from four hides. */
const PLAN = [
  ['50', 2],
  ['52', 2],
  ['52', 2],
  ['54', 2],
] as const

export default defineStage({
  proves: 'cut log per hide on the cutting table’s tablet: two sets of one size per hide, each hide done (no remnant); the cuts recorded by the office through the floor queue',
  async run(flow) {
    const workOrder = flow.state.workOrder as { id: string; number: string }
    const hides = flow.state.cutHides as string[]

    await flow.step('the cutting table’s tablet is enrolled; the cutter signs in (badge, PIN, notice)', async () => {
      const device = await tablet(flow, 'CUT')
      await signIn(flow, device, await worker(flow, 'cutter'))
      await flow.shot(device.page, 'cut-home')
    })
    const device = await tablet(flow, 'CUT')
    const { page } = device

    for (const [index, code] of hides.entries()) {
      const [size, sets] = PLAN[index]!
      await flow.step(`hide ${code}: ${sets} sets of size ${size}, hide done, no remnant`, async () => {
        await signIn(flow, device, await worker(flow, 'cutter'))
        await tile(page, 'Cut a hide')
        await press(page.getByRole('button', { name: new RegExp(workOrder.number) }).first())
        await expect(page.getByRole('textbox', { name: "Scan the hide's tag", exact: true })).toBeVisible()
        await quiet(page)
        await scanUntil(page, code, page.getByRole('radio', { name: new RegExp(`^${size}\\b`) }), { field: "Scan the hide's tag" })
        await page.getByRole('radio', { name: new RegExp(`^${size}\\b`) }).first().click()
        for (let n = 0; n < sets; n++) await press(page.getByRole('button', { name: '+ 1 set', exact: true }))
        await press(page.getByRole('button', { name: 'Hide done', exact: true }))
        await press(page.getByRole('button', { name: 'No remnant · done' }))
        await expect(page.getByText(new RegExp(`${code} · ${size} × ${sets} · no remnant`)).first()).toBeVisible()
        await drained(page)
        await expect(page.getByText('Recorded by the office').first()).toBeVisible()
      })
    }
    await flow.shot(page, 'cuts-recorded')
    await flow.settle()
  },
})
