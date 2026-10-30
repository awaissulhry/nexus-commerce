import { expect, type Page } from '@playwright/test'
import { SIZES } from './05-quote'
import { quiet, scanUntil, signIn, tablet, tile, typePin, worker, WORKERS } from './_harness/floor'
import { defineStage } from './_harness/stages'
import { answerOf, dialog, press } from './_harness/ui'

/** A floor signing act: the PIN pad opens when the 2-minute window of the last PIN has passed. */
async function signWithPin(page: Page, pin: string): Promise<void> {
  const pad = page.getByRole('group', { name: 'Your PIN' })
  if (await pad.waitFor({ state: 'visible', timeout: 3_000 }).then(() => true, () => false)) await typePin(page, pin)
}

export default defineStage({
  proves: 'final inspection by an inspector who made none of the units (the bench on the inspection tablet); release per size',
  async run(flow) {
    const workOrder = flow.state.workOrder as { id: string; number: string }

    await flow.step('the planner completes the work order: every garment finished', async () => {
      const planner = await flow.desk('planner')
      await planner.go(`/production/work-orders/${workOrder.id}`)
      await expect(planner.page.getByRole('progressbar', { name: 'Finished' }).first()).toBeVisible()
      await press(planner.page.getByRole('button', { name: 'Complete', exact: true }).first())
      await answerOf(planner.page, 'POST', /\/complete$/, () => press(dialog(planner.page).getByRole('button', { name: 'Complete', exact: true })))
      await expect.poll(async () => (await flow.read(planner.page, `/production/work-orders/${workOrder.id}`)).workOrder.status).toBe('COMPLETED')
    })

    const device = await tablet(flow, 'QC')
    const { page } = device
    const bench = WORKERS.bench

    await flow.step('the bench inspector signs in on the inspection tablet (the QC operator signs out) and opens the work order: she made none of it', async () => {
      await signIn(flow, device, await worker(flow, 'bench'))
      await tile(page, 'Final inspection')
      await scanUntil(page, workOrder.number, page.getByText('You made none of these garments.'), { field: "Scan the work order's traveller" })
      await flow.shot(page, 'bench-gate')
    })

    await flow.step('the inspection: the whole lot, every group passes, signed PASS', async () => {
      await signIn(flow, device, await worker(flow, 'bench'))
      await tile(page, 'Final inspection')
      await scanUntil(page, workOrder.number, page.getByText('You made none of these garments.'), { field: "Scan the work order's traveller" })
      await press(page.getByRole('button', { name: 'Start the inspection' }))
      await answerOf(page, 'POST', /^\/quality\/inspections$/, () => press(page.getByRole('button', { name: 'Open the inspection' })))
      for (let group = 0; group < 4; group++) {
        await answerOf(page, 'PATCH', /^\/quality\/inspections\/[0-9a-f-]+$/, () => press(page.getByRole('button', { name: 'Group passes', exact: true }).first()))
      }
      await expect(page.getByText(/Result now: PASS/).first()).toBeVisible()
      await answerOf(page, 'POST', /\/decide$/, async () => {
        await press(page.getByRole('button', { name: /^Sign the result: PASS/ }))
        await signWithPin(page, bench.pin)
      })
      await expect(page.getByText(/^INS-.* · passed/).first()).toBeVisible()
      await flow.shot(page, 'inspection-passed')
    })

    for (const [size, quantity] of Object.entries(SIZES)) {
      await flow.step(`release of size ${size}: ${quantity} garments, packing can start`, async () => {
        await quiet(page)
        if (!(await page.getByText(/^INS-.* · passed/).first().isVisible())) {
          await signIn(flow, device, await worker(flow, 'bench'))
          await tile(page, 'Final inspection')
          await scanUntil(page, workOrder.number, page.getByText(/^INS-.* · passed/), { field: "Scan the work order's traveller" })
        }
        // The card of the size (the deepest block that names it and holds a Release button).
        const card = page
          .locator('div, section, article, li')
          .filter({ has: page.getByText(`RED ${size}`, { exact: true }) })
          .filter({ has: page.getByRole('button', { name: 'Release', exact: true }) })
          .last()
        await press(card.getByRole('button', { name: 'Release', exact: true }))
        await answerOf(page, 'POST', /^\/quality\/releases$/, async () => {
          await press(page.getByRole('button', { name: new RegExp(`^Release ${quantity} garments?`) }))
          await signWithPin(page, bench.pin)
        })
        await expect(page.getByText(new RegExp(`^Released · batch .* · ${quantity} garments? · packing can start`)).first()).toBeVisible()
        const back = page.getByRole('button', { name: 'This work order' })
        if (await back.isVisible()) await back.click()
      })
    }
    await flow.shot(page, 'released')
    await flow.settle()
    const warehouse = await flow.desk('warehouse')
    const ready = await flow.read(warehouse.page, `/shipping/ready?salesOrderId=${flow.state.order.id}`)
    const cells = (ready.orders as Record<string, any>[]).flatMap((order) => order.cells as Record<string, any>[])
    expect(cells.reduce((sum, cell) => sum + cell.shippable, 0)).toBe(8)
  },
})
