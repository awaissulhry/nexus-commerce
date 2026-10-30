import { expect } from '@playwright/test'
import { scan, scanUntil, signIn, tablet, tile, worker } from './_harness/floor'
import { defineStage } from './_harness/stages'
import { answerOf, press } from './_harness/ui'

export default defineStage({
  proves: 'hides issued to the work order on the floor (Pick & issue on the warehouse tablet: a hide by its tag, 0 taps), the lining and the protectors by their lots',
  async run(flow) {
    const workOrder = flow.state.workOrder as { id: string; number: string }
    const lots = flow.state.receipt.lots as { leather: { hides: string[] }; protectors: { code: string } }
    const device = await tablet(flow, 'WH')
    const { page } = device
    const hides = lots.leather.hides.slice(0, 4)

    await flow.step('the warehouse worker opens Pick & issue and scans the work order: what it needs', async () => {
      await signIn(flow, device, await worker(flow, 'wh'))
      await tile(page, 'Pick & issue')
      await scanUntil(page, workOrder.number, page.getByRole('textbox', { name: 'Scan to issue', exact: true }))
      await expect(page.getByText(workOrder.number, { exact: true }).first()).toBeVisible()
      await expect(page.getByText('What it needs').first()).toBeVisible()
      await flow.shot(page, 'pick-list')
    })

    const open = async () => {
      await tile(page, 'Pick & issue')
      await scanUntil(page, workOrder.number, page.getByRole('textbox', { name: 'Scan to issue', exact: true }))
    }

    await flow.step(`four hides by their tags (${hides.join(', ')}): each issued by the scan alone`, async () => {
      await open()
      for (const code of hides) {
        await answerOf(page, 'POST', /^\/inventory\/picking\/work-orders\/[0-9a-f-]+\/issue$/, () => scan(page, code, { field: 'Scan to issue' }))
        await expect(page.getByText(new RegExp(`Issued ${code} · `)).first()).toBeVisible()
      }
    })

    await flow.step('the lining (seeded lot) and the protectors (the received lot) by the pad, what is still needed', async () => {
      await open()
      for (const code of ['SEED-LOT-LIN-01', lots.protectors.code]) {
        await scan(page, code, { field: 'Scan to issue' })
        await expect(page.getByText(`How much of ${code}?`).first()).toBeVisible()
        await answerOf(page, 'POST', /^\/inventory\/picking\/work-orders\/[0-9a-f-]+\/issue$/, () => press(page.getByRole('button', { name: /^Issue \d/ }).last()))
        await expect(page.getByText(new RegExp(`Issued ${code} · `)).first()).toBeVisible()
      }
      await expect(page.getByText('3 of 3 covered').first()).toBeVisible()
      await flow.shot(page, 'pick-covered')
    })
    await flow.settle()
    const office = await flow.desk('planner')
    expect((await flow.read(office.page, `/production/work-orders/${workOrder.id}`)).workOrder.status).toBe('IN_PROGRESS')
    flow.state.cutHides = hides
  },
})
