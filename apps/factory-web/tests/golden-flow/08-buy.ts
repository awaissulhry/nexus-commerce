import { expect } from '@playwright/test'
import { defineStage } from './_harness/stages'
import { answerOf, day, dialog, pickDate, press } from './_harness/ui'

export default defineStage({
  proves: 'what to buy → PO → email → supplier confirms by link (no prices on the link)',
  async run(flow) {
    const order = flow.state.order as { id: string; number: string }

    await flow.step('the planner runs the plan for A1: the order’s red leather is a Buy line', async () => {
      const planner = await flow.desk('planner')
      await planner.go('/planning/mrp')
      await answerOf(planner.page, 'POST', /^\/planning\/runs$/, () => press(planner.page.getByRole('button', { name: 'Run plan now' })))
      await expect(planner.page.getByText('The plan was run again: the lines below are the new plan.').first()).toBeVisible()
      const red = planner.page.getByRole('row').filter({ hasText: 'RED Red' }).first()
      await expect(red).toContainText(order.number)
      await expect(red).toContainText(/Buy/)
      await flow.shot(planner.page, 'plan')
    })

    const po = await flow.step('the buyer drafts the PO from the plan line in one click', async () => {
      const buyer = await flow.desk('buyer')
      await buyer.go('/planning/mrp')
      const answer = await answerOf(buyer.page, 'POST', /^\/purchasing\/from-plan$/, () => press(buyer.page.getByRole('button', { name: 'Draft a PO for SEED-LEA-100' }).first()))
      const made = answer.orders[0] as Record<string, any>
      await expect(buyer.page.getByText(/^New draft PO-\d{4}-\d{4} made \(1 line\)\.$/).first()).toBeVisible()
      return { id: made.id as string, number: made.number as string }
    })
    flow.state.po = po

    await flow.step('the buyer adds 36 shoulder protectors, sets the need dates (+40 days) and the leather’s area tolerance', async () => {
      const buyer = await flow.desk('buyer')
      const { page } = buyer
      await buyer.go(`/purchasing/orders/${po.id}`)
      await press(page.getByRole('button', { name: 'Add line' }).first())
      let form = dialog(page)
      await form.getByRole('searchbox', { name: 'Material' }).fill('SEED-PRO-300')
      await form.getByRole('combobox', { name: 'Material' }).selectOption({ label: 'SEED-PRO-300 · Seed shoulder protector level 2' })
      await form.getByRole('textbox', { name: 'Quantity', exact: true }).fill('36')
      await pickDate(form, 'Need date', day(40))
      await answerOf(page, 'POST', /\/lines$/, () => press(form.getByRole('button', { name: 'Add line' })))
      await expect(page.getByText('Line added.').first()).toBeVisible()
      for (const seq of ['10', '20']) {
        await page.getByRole('button', { name: `Actions for line ${seq}` }).click()
        await page.getByRole('menuitem', { name: 'Change the line…' }).click()
        form = dialog(page)
        await pickDate(form, 'Need date', day(40))
        const tolerance = form.getByRole('textbox', { name: 'Area tolerance (%)' })
        if ((await tolerance.count()) > 0) await tolerance.fill('5')
        await answerOf(page, 'PATCH', /\/lines\/[0-9a-f-]+$/, () => press(form.getByRole('button', { name: 'Save', exact: true })))
        await expect(page.getByText('Line saved.').first()).toBeVisible()
      }
      await expect(page.getByText('Nothing stops the send.').first()).toBeVisible()
      await flow.shot(page, 'po-lines')
    })

    const recipient = await flow.step('the buyer sends it: the PDF as it leaves, mailed with the confirm link', async () => {
      const buyer = await flow.desk('buyer')
      const { page } = buyer
      await buyer.go(`/purchasing/orders/${po.id}`)
      await press(page.getByRole('button', { name: 'Send to supplier' }).first())
      const form = dialog(page)
      await expect(form.getByRole('img', { name: /^Purchase order PO-.*, page 1 of/ })).toBeVisible({ timeout: 60_000 })
      const to = /[\w.+-]+@[\w.-]+\.\w+/.exec(await form.innerText())?.[0] ?? ''
      const before = to ? await flow.mailsTo(to) : 0
      const answer = await answerOf(page, 'POST', /\/send$/, () => press(form.getByRole('button', { name: 'Send', exact: true }), 60_000))
      await expect(form.getByText(/^Sent to /).first()).toBeVisible()
      await flow.shot(page, 'po-sent')
      await press(form.getByRole('button', { name: 'Done' }))
      expect(answer).toMatchObject({ order: { status: 'SENT' } })
      return { to: answer.sent.to as string, before: answer.sent.to === to ? before : 0 }
    })

    await flow.step('the supplier opens the link on a phone: what and when, never a price; confirms every line as asked', async () => {
      const link = await flow.linkSentTo(recipient.to, recipient.before)
      const supplier = await flow.visitor('supplier', link.url)
      const { page } = supplier
      await expect(page.getByRole('heading', { name: new RegExp(`Purchase order ${po.number}`) }).first()).toBeVisible({ timeout: 60_000 })
      await expect(page.getByText('This page shows what and when, never prices.').first()).toBeVisible()
      await expect(page.getByText(/€/)).toHaveCount(0)
      await page.getByRole('textbox', { name: 'Your order or confirmation number' }).fill('OC-GOLDEN-1')
      await page.getByRole('textbox', { name: 'Your name (optional)' }).fill('Mario Fornitore')
      await answerOf(page, 'POST', /^\/link\/purchase-order\/confirm$/, () => press(page.getByRole('button', { name: 'Confirm all as asked' })))
      await expect(page.getByText('Confirmed — thank you').first()).toBeVisible()
      await flow.shot(page, 'supplier-confirmed')
    })

    await flow.step('the buyer sees the answer: confirmed as asked by Mario Fornitore on the link', async () => {
      const buyer = await flow.desk('buyer')
      await flow.settle()
      await buyer.go(`/purchasing/orders/${po.id}?tab=answer`)
      await expect(buyer.page.getByRole('heading', { name: /^Confirmed as asked by Mario Fornitore on the link/ })).toBeVisible()
      expect((await flow.read(buyer.page, `/purchasing/orders/${po.id}`)).order.status).toBe('CONFIRMED')
    })
    await flow.settle()
  },
})
