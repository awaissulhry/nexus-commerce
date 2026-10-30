import { expect } from '@playwright/test'
import { defineStage } from './_harness/stages'
import { answerOf, dialog, press } from './_harness/ui'

export default defineStage({
  proves: 'work order released with a frozen spec: every release check green (revision, label, certificate, materials in stock, the deposit paid); the order follows (IN_PRODUCTION)',
  async run(flow) {
    const planner = await flow.desk('planner')
    const { page } = planner
    const order = flow.state.order as { id: string; number: string }

    const workOrder = await flow.step('the planner makes the work order from the order line (8 pieces)', async () => {
      await planner.go(`/production/work-orders?new=1&order=${order.number}`)
      const form = dialog(page)
      await expect(form.getByText(/It will get number WO-\d+/).first()).toBeVisible()
      await expect(form.getByText('8 pieces').first()).toBeVisible()
      const made = await answerOf(page, 'POST', /^\/production\/work-orders$/, () => press(form.getByRole('button', { name: 'Create draft' })))
      await page.waitForURL(/\/production\/work-orders\/[0-9a-f-]{36}/)
      return { id: made.workOrder.id as string, number: made.workOrder.number as string }
    })
    flow.state.workOrder = workOrder

    await flow.step('the release check is green and the planner releases it: a batch number, the spec frozen', async () => {
      await planner.go(`/production/work-orders/${workOrder.id}`)
      await expect(page.getByText('Usable stock at the site covers every material.').first()).toBeVisible()
      await expect(page.getByText('Every order’s deposit is paid or waived.').or(page.getByText("Every order's deposit is paid or waived.")).first()).toBeVisible()
      await flow.shot(page, 'release-check')
      await press(page.getByRole('button', { name: 'Release', exact: true }).first())
      await answerOf(page, 'POST', /\/release$/, () => press(dialog(page).getByRole('button', { name: 'Release', exact: true })))
      await expect(page.getByText(/^Released · batch /).first()).toBeVisible()
      await flow.shot(page, 'released')
    })

    const released = (await flow.read(page, `/production/work-orders/${workOrder.id}`)).workOrder
    expect(released).toMatchObject({ status: 'RELEASED', batchNumber: expect.any(String) })
    flow.state.workOrder.batch = released.batchNumber
    await flow.settle()
    await flow.step('the order follows: In production', async () => {
      const sales = await flow.desk('sales')
      await sales.go(`/sales/orders/${order.id}`)
      await expect(sales.page.getByText('In production').first()).toBeVisible()
    })
  },
})
