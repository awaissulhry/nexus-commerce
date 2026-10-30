import { expect } from '@playwright/test'
import { defineStage } from './_harness/stages'
import { answerOf, dialog, press } from './_harness/ui'

export default defineStage({
  proves: 'TD24 from the DDT with the deposit deducted → SDI (fake) delivered → balance payment allocated to the invoice → order CLOSED',
  async run(flow) {
    const finance = await flow.desk('finance')
    const { page } = finance
    const ddt = flow.state.ddt as { id: string; number: string }
    const td02 = flow.state.td02 as { id: string; number: string }
    const order = flow.state.order as { id: string; number: string }

    const invoice = await flow.step('finance invoices the shipped goods: the DDT, a deferred invoice (TD24), the deposit deducted', async () => {
      await finance.go('/finance/invoices')
      await expect(page.getByText(`DDT ${ddt.number}`).first()).toBeVisible()
      await press(page.getByRole('button', { name: 'Invoice shipped goods' }).first())
      const form = dialog(page)
      await form.getByRole('combobox', { name: 'Customer', exact: true }).selectOption(flow.state.party.id)
      await form.getByRole('checkbox', { name: new RegExp(`^DDT ${ddt.number.replace(/[/.]/g, '\\$&')} · `) }).check()
      await form.getByRole('radio', { name: /TD24/ }).check()
      const made = await answerOf(page, 'POST', /^\/invoicing\/invoices\/from-ddts$/, () => press(form.getByRole('button', { name: 'Create the draft invoice' })))
      await page.waitForURL(/\/finance\/invoices\/[0-9a-f-]{36}/)
      expect(made.invoice.docType).toBe('TD24')
      return { id: made.invoice.id as string }
    })

    const issued = await flow.step('the draft: the TD02 deducted, every check passes; issued and sent to SDI at once (step-up)', async () => {
      await finance.go(`/finance/invoices/${invoice.id}?tab=lines`)
      await expect(page.getByText(new RegExp(`Deposit deducted: deposit invoice ${td02.number}`)).first()).toBeVisible()
      await expect(page.getByText(/^Every check passes\. It will get number /).first()).toBeVisible()
      await flow.shot(page, 'td24-draft')
      await press(page.getByRole('button', { name: 'Check and issue' }).first())
      const form = page.getByRole('dialog', { name: 'Issue the invoice and send it to SDI?' })
      await expect(form.getByRole('checkbox', { name: 'Send it to SDI at once' })).toBeChecked()
      const answer = await answerOf(page, 'POST', /^\/invoicing\/invoices\/[0-9a-f-]+\/issue$/, async () => {
        await press(form.getByRole('button', { name: 'Issue and send' }))
        await flow.stepUp(page, finance.person)
      })
      await expect(page.getByText(/is issued and sent to SDI\.$/).first()).toBeVisible()
      expect(answer.invoice).toMatchObject({ docType: 'TD24', status: 'ISSUED' })
      return { number: answer.invoice.number as string }
    })
    flow.state.invoice = { ...invoice, ...issued }

    await flow.step('the scheduler’s SDI poll: delivered to the customer', async () => {
      await flow.control('POST', '/tick/sdi')
      await expect(async () => {
        await finance.go(`/finance/invoices/${invoice.id}?tab=sdi`)
        await expect(page.getByText('Delivered to the customer').first()).toBeVisible({ timeout: 5_000 })
      }).toPass({ timeout: 60_000 })
      await flow.shot(page, 'td24-delivered')
    })

    await flow.step('the customer pays the balance: recorded and placed on the invoice', async () => {
      await finance.go(`/finance/invoices/${invoice.id}`)
      await page.getByRole('link', { name: 'Record payment' }).or(page.getByRole('button', { name: 'Record payment' })).first().click()
      await page.waitForURL(/\/finance\/payments\?/)
      let form = page.getByRole('dialog', { name: 'Record a payment' })
      await expect(form.getByRole('textbox', { name: 'Amount', exact: true })).not.toHaveValue('', { timeout: 30_000 })
      await form.getByRole('textbox', { name: 'Bank reference (CRO or TRN)' }).fill('CRO-GOLDEN-0002')
      await press(form.getByRole('button', { name: 'Next: where it goes' }))
      form = page.getByRole('dialog', { name: /^Where the money of .* goes$/ })
      await expect(form.getByRole('checkbox', { name: new RegExp(`^Invoice ${issued.number}`) })).toBeChecked()
      await answerOf(page, 'POST', /^\/payments$/, () => press(form.getByRole('button', { name: /^Record .+ and place it$/ })))
      const done = page.getByRole('dialog', { name: 'Payment recorded' })
      await expect(done.getByText(new RegExp(`Invoice ${issued.number}`)).first()).toBeVisible()
      await flow.shot(page, 'payment-recorded')
      await press(done.getByRole('button', { name: 'Done' }))
    })

    await flow.step('settled: the worker closes the order; the order studio says Closed', async () => {
      await flow.settle()
      const settlement = (await flow.read(page, `/invoicing/orders/${order.id}/settlement`)).settlement
      expect(settlement).toMatchObject({ settled: true, gaps: [], balanceDueAmount: 0 })
      await expect(async () => {
        await finance.go(`/sales/orders/${order.id}`)
        await expect(page.getByText(/^Closed on .*: nothing on it changes any more\.$/).first()).toBeVisible({ timeout: 5_000 })
      }).toPass({ timeout: 60_000 })
      expect((await flow.read(page, `/sales/orders/${order.id}`)).order.status).toBe('CLOSED')
      await flow.shot(page, 'order-closed')
    })
  },
})
