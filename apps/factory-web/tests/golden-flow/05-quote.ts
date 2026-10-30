import { expect } from '@playwright/test'
import { CUSTOMER } from './01-customer'
import { STYLE } from './02-style'
import { defineStage } from './_harness/stages'
import { answerOf, day, dialog, pickDate, press } from './_harness/ui'

/** The size run of the first order: RED 50 ×2, 52 ×4, 54 ×2, at a price under the margin floor. */
export const SIZES = { '50': 2, '52': 4, '54': 2 } as const
export const UNIT_PRICE = '200'

export default defineStage({
  proves: 'size-grid quote under the margin floor → approval (the asker never decides; finance approves from Home)',
  async run(flow) {
    const sales = await flow.desk('sales')
    const { page } = sales

    const quote = await flow.step('sales makes the quote for GF-BRAND (contact Anna, customer ref RFQ-GOLDEN-1)', async () => {
      await sales.go('/sales/quotes?new=1')
      const form = dialog(page)
      await form.getByRole('searchbox', { name: 'Customer' }).fill(CUSTOMER.code)
      await form.getByRole('radio', { name: new RegExp(`^${CUSTOMER.legalName.replace(/\./g, '\\.')}`) }).first().click()
      await form.getByRole('textbox', { name: 'Customer reference', exact: true }).fill('RFQ-GOLDEN-1')
      const number = /QT-\d{4}-\d{5}/.exec(await form.innerText())?.[0]
      const made = await answerOf(page, 'POST', /^\/sales\/quotes$/, () => press(form.getByRole('button', { name: 'Create draft' })))
      await page.waitForURL(/\/sales\/quotes\/[0-9a-f-]{36}\?tab=lines/)
      expect(made.quote.number ?? number).toMatch(/QT-\d{4}-\d{5}/)
      return { id: made.quote.id as string, number: (made.quote.number ?? number) as string }
    })
    flow.state.quote = quote

    await flow.step('the size grid: GF-JKT-01 RED 50 ×2, 52 ×4, 54 ×2 (autosaved)', async () => {
      await sales.go(`/sales/quotes/${quote.id}?tab=lines`)
      await page.getByRole('searchbox', { name: 'Style' }).fill(STYLE.code)
      await page.getByRole('radio', { name: new RegExp(`^${STYLE.code} · `) }).first().click()
      await press(page.getByRole('button', { name: 'Add the style with 1 colour' }))
      for (const [size, quantity] of Object.entries(SIZES)) await page.getByRole('textbox', { name: new RegExp(`^RED · Rosso, size ${size}`) }).fill(String(quantity))
      await expect(page.getByText(/^All changes saved · /).first()).toBeVisible({ timeout: 30_000 })
    })

    await flow.step(`the unit price ${UNIT_PRICE}: under the margin floor, the send waits for an approval`, async () => {
      await sales.go(`/sales/quotes/${quote.id}?tab=lines`)
      const price = page.getByRole('textbox', { name: 'Unit price of RED · Rosso' })
      await price.fill(UNIT_PRICE)
      await answerOf(page, 'PATCH', /^\/sales\/quotes\/[0-9a-f-]+\/lines\/[0-9a-f-]+$/, () => price.press('Enter'))
      await expect(page.getByText('Needs approval: margin under the floor').first()).toBeVisible()
      await expect(page.getByText(/under the [\d.]+% floor, needs approval/).first()).toBeVisible()
      await flow.shot(page, 'quote-under-floor')
    })

    await flow.step('the promise date, 60 days out, on Terms & delivery', async () => {
      await sales.go(`/sales/quotes/${quote.id}?tab=terms`)
      await pickDate(page, 'Promise date', day(60))
      await answerOf(page, 'PATCH', /^\/sales\/quotes\/[0-9a-f-]+$/, () => press(page.getByRole('button', { name: 'Save terms' })))
      await expect(page.getByText('Terms saved.').first()).toBeVisible()
    })

    await flow.step('sales asks for the approval with a note; the asker may not approve', async () => {
      await sales.go(`/sales/quotes/${quote.id}`)
      await expect(page.getByRole('button', { name: /^Send to customer/ }).first()).toBeDisabled()
      await press(page.getByRole('button', { name: 'Ask for approval' }).first())
      const form = dialog(page)
      await form.getByRole('textbox', { name: 'Note to the approver' }).fill('First order of a new brand: launch price')
      await answerOf(page, 'POST', /\/approval$/, () => press(form.getByRole('button', { name: 'Send request' })))
      await expect(page.getByText('Waiting for approval').first()).toBeVisible()
      const current = (await flow.read(page, `/sales/quotes/${quote.id}`)).quote
      expect(current.status).toBe('PENDING_APPROVAL')
      // The one who asked never decides (the route refuses; the screen offers no Approve to sales).
      await flow.write(page, 'POST', `/sales/quotes/${quote.id}/approval/approve`, { version: current.version }, 403)
      await flow.shot(page, 'quote-asked')
    })

    await flow.step('finance finds it on Home › Approvals and approves it', async () => {
      const finance = await flow.desk('finance')
      await finance.go('/home/approvals')
      const row = finance.page.getByRole('link', { name: new RegExp(quote.number) }).first()
      await row.click()
      const review = finance.page.getByRole('dialog', { name: new RegExp(`^Approve quote ${quote.number}`) })
      await expect(review.getByText(/^Still current · checked/)).toBeVisible()
      await review.getByRole('textbox', { name: 'Decision note' }).fill('Approved for the launch')
      await answerOf(finance.page, 'POST', /\/approval\/approve$/, () => press(review.getByRole('button', { name: /^Approve/ })))
      await expect(finance.page.getByText(new RegExp(`${quote.number} approved`)).first()).toBeVisible()
      await flow.shot(finance.page, 'approved')
    })

    await flow.step('the quote reads Approved for sales: the send is open', async () => {
      await sales.go(`/sales/quotes/${quote.id}`)
      await expect(page.getByText('Approved').first()).toBeVisible()
      await expect(page.getByRole('button', { name: /^Send to customer/ }).first()).toBeEnabled()
    })
    await flow.settle()
  },
})
