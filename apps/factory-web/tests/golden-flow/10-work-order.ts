import { expect, test } from '@playwright/test'
import { defineStage } from './_harness/stages'
import { answerOf, dialog, press } from './_harness/ui'
import { words } from './_harness/words' // F-OP-218

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

    // F-OP-218 (order page plan N4; 11-dock §0, §2): the work order's dock is the same ONE card (the pick band inside it when an order's
    // thread may be read, the work order's notes office only); the order page offers the work order's notes in its own dock.
    // tw- T.3 (W2.1, Z4): the pick is the head's title — ONE menu; an office-only thread shows the lock in it.
    await flow.step('the dock: the work order’s pick in the head’s title; the order page’s Work orders scope, office only (the lock)', async () => {
      const OD = words('orders')
      const card = (where: typeof page) => where.locator('.fw-rcf.has-thread > aside.fw-rcf-dock section.fw-rt-column.is-docked')
      await planner.go(`/production/work-orders/${workOrder.id}`)
      await expect(card(page)).toHaveCount(1, { timeout: 60_000 })
      const title = card(page).locator('.fw-rth-title button.fw-thread-pick-title')
      if ((await title.count()) > 0) await expect(title.locator('.fw-thread-pick-lock')).toBeVisible() // the work order's notes: office only
      else test.info().annotations.push({ type: 'not here', description: 'no order thread the planner may read beside the work order: its head names the record, no pick' })
      const sales = await flow.desk('sales')
      await sales.go(`/sales/orders/${order.id}`)
      const pick = card(sales.page).locator('.fw-rth-title button.fw-thread-pick-title')
      await expect(pick).toHaveCount(1, { timeout: 60_000 })
      await pick.click()
      const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const row = sales.page.getByRole('menuitemcheckbox', { name: new RegExp(`^(?:✓\\s*)?${escape(OD('record.dock.workOrders'))}`) }) // the row in use starts with the DS's "✓"
      if ((await row.count()) > 0) {
        await row.click()
        await expect(sales.page).toHaveURL(/[?&]thread=wo%3A/)
        await expect(card(sales.page).locator('.fw-rth-title .fw-thread-pick-lock')).toBeVisible()
        await flow.shot(sales.page, 'order-dock-work-order')
      } else {
        await sales.page.keyboard.press('Escape')
        test.info().annotations.push({ type: 'not here', description: 'sales reads no work order here (workorders.view): the order dock offers no Work orders scope' })
      }
    })
  },
})
