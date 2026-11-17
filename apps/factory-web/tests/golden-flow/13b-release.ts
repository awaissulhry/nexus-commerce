import { expect, type Page } from '@playwright/test'
import { SIZES } from './05-quote'
import { quiet, scan, scanUntil, signIn, tablet, tile, typePin, worker, WORKERS } from './_harness/floor'
import { seen } from './_harness/flow'
import { defineStage } from './_harness/stages'
import { answerOf, dialog, press } from './_harness/ui'

/** A floor signing act: the PIN pad ("Your PIN", or the plan bench's "Sign with your PIN") opens when the 2-minute window of the last PIN has passed. */
async function signWithPin(page: Page, pin: string): Promise<void> {
  const pad = page.getByRole('group', { name: 'Your PIN', exact: true }).or(page.getByRole('group', { name: 'Sign with your PIN', exact: true }))
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

    await flow.step('the inspection on its plan (FIN-JACKET): the whole AQL sample, every check group passes, the measure, the batch label; signed PASS', async () => {
      await signIn(flow, device, await worker(flow, 'bench'))
      await tile(page, 'Final inspection')
      await scanUntil(page, workOrder.number, page.getByText('You made none of these garments.'), { field: "Scan the work order's traveller" })
      await press(page.getByRole('button', { name: 'Start the inspection' }))
      await answerOf(page, 'POST', /^\/quality\/inspections$/, () => press(page.getByRole('button', { name: 'Open the inspection' })))
      // The bench on the plan (B-W2b-109): one section at a time; every answer is one record sent from the tablet.
      const record = (action: () => Promise<unknown>) => answerOf(page, 'POST', /^\/quality\/queue\/record$/, action)
      const section = (name: string) => page.getByRole('group', { name: 'Sections of the inspection' }).getByRole('button', { name: new RegExp(`^${name}`) })
      // The AQL sample: every piece of it looked at, no defect found.
      const aql = await seen(page.getByRole('region', { name: /^AQL .* · sample \d+$/ }))
      const sample = Number(/sample (\d+)/.exec(await aql.innerText())?.[1])
      expect(sample, 'the plan’s sample size').toBeGreaterThan(0)
      for (let piece = 0; piece < sample; piece++) await record(() => press(aql.getByRole('button', { name: '+ one piece', exact: true })))
      await expect(aql.getByText(`${sample} of ${sample} inspected`)).toBeVisible()
      // The plan's checks: every group passes.
      await section('Checks').click()
      const checks = page.getByRole('region', { name: "The plan's checks" })
      const groups = checks.getByRole('button', { name: 'Group passes', exact: true })
      await groups.first().waitFor()
      const count = await groups.count()
      for (let group = 0; group < count; group++) await record(() => press(groups.nth(group)))
      await expect(checks.getByText(/^(\d+) of \1 checked$/).first()).toBeVisible()
      // Each point of measure: a garment's size, its value on the pad (the target), saved within tolerance.
      await section('Measurements').click()
      const points = page.getByRole('list', { name: 'Measurements' }).getByRole('button')
      await points.first().waitFor()
      for (let point = 0, total = await points.count(); point < total; point++) {
        const nominal = /(\d+(?:[.,]\d+)?) ± /.exec(await points.nth(point).innerText())?.[1]
        expect(nominal, 'the point’s target').toBeTruthy()
        await press(points.nth(point))
        await press(page.getByRole('group', { name: 'Which size?' }).getByRole('button').first())
        const pad = page.getByRole('group', { name: 'Measured' })
        for (const key of nominal!.replace(',', '.')) await pad.getByRole('button', { name: key, exact: true }).click()
        await record(() => press(page.getByRole('button', { name: /^Save · within/ })))
        await expect(page.getByText(new RegExp(`^Garment 1 · size \\d+: ${nominal!.replace('.', '\\.')} \\S+, within`)).first()).toBeVisible()
        await section('Measurements').click()
      }
      // The batch label, once for the lot: its number is the work order's batch.
      await section('Serial or batch').click()
      await record(() => scan(page, flow.state.workOrder.batch as string, { field: `Scan the batch label (${flow.state.workOrder.batch})` }))
      for (const name of ['AQL sample', 'Checks', 'Measurements', 'Serial or batch']) await expect(section(name)).toHaveAccessibleName(new RegExp(`^${name} Done$`))
      await expect(page.getByText('The result as it stands: PASS.').first()).toBeVisible()
      await answerOf(page, 'POST', /\/decide$/, async () => {
        await press(page.getByRole('button', { name: 'Sign PASS', exact: true }))
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
