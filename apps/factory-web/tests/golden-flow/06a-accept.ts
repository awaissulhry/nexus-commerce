import { expect } from '@playwright/test'
import { CUSTOMER } from './01-customer'
import { defineStage } from './_harness/stages'
import { answerOf, dialog, press } from './_harness/ui'

export default defineStage({
  proves: 'send; accept by link in a second context with a typed name; the link shows the party’s own prices; deposit request (and the bank-details page by its DEPOSIT_INFO link)',
  async run(flow) {
    const sales = await flow.desk('sales')
    const quote = flow.state.quote as { id: string; number: string }
    const to = CUSTOMER.orders.email

    const sent = await flow.step('sales sends the quote: checks, the PDF as it leaves, to Anna (orders contact)', async () => {
      const before = await flow.mailsTo(to)
      await sales.go(`/sales/quotes/${quote.id}`)
      await press(sales.page.getByRole('button', { name: /^Send to customer/ }).first())
      const form = dialog(sales.page)
      await expect(form.getByText(to).first()).toBeVisible()
      await expect(form.locator('canvas').first()).toBeVisible({ timeout: 60_000 })
      await expect(form.getByText(/^Stops the send:/)).toHaveCount(0)
      await flow.shot(sales.page, 'send-dialog')
      const answer = await answerOf(sales.page, 'POST', /\/send$/, () => press(form.getByRole('button', { name: 'Send', exact: true }), 60_000))
      await expect(form.getByText(new RegExp(`Sent to ${to.replace(/\./g, '\\.')}`)).first()).toBeVisible()
      await press(form.getByRole('button', { name: 'Done' }))
      expect(answer).toMatchObject({ quote: { status: 'SENT' }, sent: { to } })
      return { before, versionId: answer.sent.versionId as string }
    })

    const accepted = await flow.step('the customer opens the link on a phone, reads its own prices and accepts with a typed name', async () => {
      const link = await flow.linkSentTo(to, sent.before)
      const customer = await flow.visitor('customer', link.url)
      const { page } = customer
      await expect(page.getByText('The offer').first()).toBeVisible({ timeout: 60_000 })
      await expect(page.getByText(/€1,600\.00/).first()).toBeVisible()
      await expect(page.getByText(/margin|cost/i)).toHaveCount(0)
      await flow.shot(page, 'customer-offer')
      await page.getByRole('checkbox', { name: /^I have read and accept the terms and conditions/ }).check()
      await page.getByRole('textbox', { name: 'Full name' }).fill(CUSTOMER.orders.name)
      await page.getByRole('textbox', { name: 'Your email' }).fill(to)
      const answer = await answerOf(page, 'POST', /^\/link\/quote\/accept$/, () => press(page.getByRole('button', { name: /^Accept quote/ })))
      await expect(page.getByText(`Accepted — thank you, ${CUSTOMER.orders.name}`).first()).toBeVisible()
      await expect(page.getByText('Deposit by bank transfer').first()).toBeVisible()
      await flow.shot(page, 'customer-accepted')
      expect(answer).toMatchObject({ state: 'ACCEPTED', deposit: { status: 'OPEN', instructions: { method: 'BANK_TRANSFER' } } })
      return { depositId: answer.deposit.id as string, amount: answer.deposit.amount as number }
    })
    flow.state.deposit = accepted

    const order = await flow.step('the order is there, made from the accepted version', async () => {
      const { orders } = await flow.read(sales.page, `/sales/orders?partyId=${flow.state.party.id}`)
      expect(orders.length).toBe(1)
      return { id: orders[0].id as string, number: orders[0].number as string }
    })
    flow.state.order = order

    await flow.step('finance sends the bank-details page; the customer opens it: amount, IBAN, reference', async () => {
      const finance = await flow.desk('finance')
      const before = await flow.mailsTo(to)
      await finance.go(`/sales/orders/${order.id}?tab=money`)
      await press(finance.page.getByRole('button', { name: 'Send the bank-details page' }).first())
      const form = dialog(finance.page)
      await answerOf(finance.page, 'POST', /^\/payments\/deposit-requests\/[0-9a-f-]+\/link$/, () => press(form.getByRole('button', { name: 'Send the page' })))
      await expect(form.getByText(new RegExp(`Sent to ${to.replace(/\./g, '\\.')}`)).first()).toBeVisible()
      await press(form.getByRole('button', { name: 'Done' }))
      const link = await flow.linkSentTo(to, before)
      const customer = await flow.visitor('customer', link.url)
      await expect(customer.page.getByText(new RegExp(`^Deposit for order ${order.number}`)).first()).toBeVisible({ timeout: 60_000 })
      await expect(customer.page.getByText('Pay by bank transfer').first()).toBeVisible()
      await expect(customer.page.getByText(/IT60/).first()).toBeVisible()
      await flow.shot(customer.page, 'customer-deposit-page')
    })
    await flow.settle()
  },
})
