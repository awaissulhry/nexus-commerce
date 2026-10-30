import { expect } from '@playwright/test'
import { defineStage } from './_harness/stages'
import { answerOf, dialog, press } from './_harness/ui'

export default defineStage({
  proves: 'bank transfer recorded against the deposit request → TD02 issued (the rule for an Italian business customer) → SDI (fake) delivered',
  async run(flow) {
    const finance = await flow.desk('finance')
    const { page } = finance
    const order = flow.state.order as { id: string; number: string }

    const td02 = await flow.step('finance records the deposit received by bank transfer (step-up) and issues the TD02 at once', async () => {
      await finance.go(`/sales/orders/${order.id}?tab=money`)
      await press(page.getByRole('button', { name: 'Record the payment' }).first())
      const form = dialog(page)
      await form.getByRole('textbox', { name: 'Bank reference (CRO / TRN)' }).fill('CRO-GOLDEN-0001')
      await expect(form.getByRole('checkbox', { name: 'Issue the deposit invoice (TD02) now' })).toBeChecked()
      const answer = await answerOf(page, 'POST', /^\/payments\/deposit-received$/, async () => {
        await press(form.getByRole('button', { name: /^Record €/ }))
        await flow.stepUp(page, finance.person)
      })
      await expect(page.getByText(/Deposit invoice FT-\d{4}-\d{5} issued\./).first()).toBeVisible()
      await flow.shot(page, 'deposit-recorded')
      await press(dialog(page).getByRole('button', { name: 'Done' }))
      expect(answer).toMatchObject({ depositRequest: { status: 'PAID' }, depositInvoice: { required: true, invoice: { docType: 'TD02', status: 'ISSUED' } } })
      return { id: answer.depositInvoice.invoice.id as string, number: answer.depositInvoice.invoice.number as string }
    })
    flow.state.td02 = td02

    await flow.step('the TD02 goes to SDI from its record (FAKE SDI)', async () => {
      await finance.go(`/finance/invoices/${td02.id}`)
      await press(page.getByRole('button', { name: 'Send to SDI' }).first())
      const form = dialog(page)
      await answerOf(page, 'POST', /\/sdi\/send$/, async () => {
        await press(form.getByRole('button', { name: 'Send to SDI' }))
        await flow.stepUp(page, finance.person, 4_000)
      })
      await expect(page.getByText('Sent to SDI: its answer comes by itself.').first()).toBeVisible()
    })

    await flow.step('the scheduler’s SDI poll: SDI delivered it; the record says so', async () => {
      await flow.control('POST', '/tick/sdi')
      await expect(async () => {
        await finance.go(`/finance/invoices/${td02.id}?tab=sdi`)
        await expect(page.getByText('Delivered to the customer').first()).toBeVisible({ timeout: 5_000 })
      }).toPass({ timeout: 60_000 })
      await flow.shot(page, 'td02-delivered')
      expect((await flow.read(page, `/invoicing/invoices/${td02.id}`)).invoice.status).toBe('DELIVERED')
    })
    await flow.settle()
  },
})
