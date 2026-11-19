import { expect } from '@playwright/test'
import { defineStage } from './_harness/stages'
import { answerOf, dialog, press, routerActivity } from './_harness/ui'
import { words } from './_harness/words' // F-OP-218

/** The customer of the first order (made up): an Italian brand that sells under its own label. */
export const CUSTOMER = {
  code: 'GF-BRAND',
  legalName: 'Marchio Esempio Golden S.r.l.',
  vatNumber: '01234560009',
  sdiCode: 'GFC0DE1',
  orders: { name: 'Anna Golden', email: 'acquisti@marchio-golden.example.com' },
  invoices: { name: 'Bruno Golden', email: 'amministrazione@marchio-golden.example.com' },
}

export default defineStage({
  proves: 'Italian B2B customer with tax identity; VIES proof (fake): an Italian VAT number is not a VIES question, and the screen says so',
  async run(flow) {
    const sales = await flow.desk('sales')
    const { page } = sales

    const party = await flow.step('sales makes the customer: tax identity, legal name, roles customer + brand', async () => {
      await sales.go('/sales/customers')
      await press(page.getByRole('button', { name: 'New customer' }).first())
      const form = dialog(page)
      await expect(form).toBeVisible()
      await form.getByRole('textbox', { name: 'VAT number', exact: true }).fill(CUSTOMER.vatNumber)
      await form.getByRole('textbox', { name: 'Codice fiscale', exact: true }).fill(CUSTOMER.vatNumber)
      await form.getByRole('textbox', { name: 'SDI recipient code', exact: true }).fill(CUSTOMER.sdiCode)
      await form.getByRole('textbox', { name: 'Legal name', exact: true }).fill(CUSTOMER.legalName)
      await form.getByRole('textbox', { name: 'Code', exact: true }).fill(CUSTOMER.code)
      await form.getByRole('checkbox', { name: 'Brand', exact: true }).check()
      const made = await answerOf(page, 'POST', /^\/parties$/, () => press(form.getByRole('button', { name: 'Create customer' })))
      await page.waitForURL(/\/sales\/customers\/[0-9a-f-]{36}/)
      await flow.shot(page, 'customer-made')
      return made.party as Record<string, any>
    })
    flow.state.party = { id: party.id, code: party.code }
    expect(party.roles).toEqual(expect.arrayContaining(['CUSTOMER', 'BRAND']))

    // fx-12 (the Owner's test server, 2026-11-19: the customer page asked its tabs ~480 times each): the page opens and rests —
    // over 10 s one document, the Work tab's one address write, a handful of the router's requests; never a loop.
    await flow.step('the customer page rests: over 10 s a handful of navigations at most (no loop)', async () => {
      const seen = await routerActivity(page, 10_000, () => sales.go(`/sales/customers/${party.id}`))
      const said = seen.lines.join('\n')
      expect(seen.documents, said).toBe(1)
      expect(seen.navigations, said).toBeLessThanOrEqual(5)
      // fx-13: a production build prefetches each visible link once (many addresses, once each); a loop asks ONE address again and again.
      expect(seen.mostOneAddress, said).toBeLessThanOrEqual(3)
      await expect(page).toHaveURL(new RegExp(`tab=work.*party=${party.id}`))
    })

    // F-OP-218 (order page plan N4; 11-dock §0, §3.4; D11): the customer page's dock is the same ONE card as the order page's — the pick
    // band inside it; All of <customer> read only, with its Head and the foot "Read only. Write in: [<customer> (general)]".
    await flow.step('the customer page’s dock: the pick band in the one card; All of <customer> with its Head and its read-only foot', async () => {
      const P = words('parties')
      const RT = words('record-thread')
      const OD = words('orders')
      const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const card = page.locator('.fw-rcf.has-thread > aside.fw-rcf-dock section.fw-rt-column.is-docked')
      await expect(card).toHaveCount(1, { timeout: 60_000 })
      const pick = card.locator('.fw-rt-top').getByRole('radiogroup', { name: P('customers.work.dock.label'), exact: true })
      await expect(pick).toBeVisible()
      const all = pick.getByRole('radio', { name: new RegExp(`^(${escape(P('customers.work.dock.all', { customer: CUSTOMER.legalName }))}|${escape(RT('allOfCustomer.view.all'))})`) })
      await all.click()
      await expect(all).toHaveAttribute('aria-checked', 'true')
      await expect(page).toHaveURL(/[?&]dock=all/)
      await expect(card.locator('.fw-rth.fw-aoc-head')).toBeVisible()
      await expect(card.locator('.fw-rt-foot')).toContainText(`${P('customers.work.dock.readOnly')}. ${OD('record.dock.writeIn')}`)
      await expect(card.locator('.fw-rt-foot').getByRole('button', { name: P('customers.work.dock.general', { customer: CUSTOMER.legalName }), exact: true })).toBeVisible()
      await flow.shot(page, 'customer-dock-all')
    })

    await flow.step('payment terms on the identity card', async () => {
      // F-SA-271 (sales page plan, pick R5): a customer opens on Work for Sales; the identity card is the Overview's.
      await sales.go(`/sales/customers/${party.id}?tab=overview`)
      await press(page.getByRole('button', { name: 'Edit', exact: true }).first())
      await dialog(page).getByRole('textbox', { name: 'Payment terms', exact: true }).fill('Bonifico 30 gg d.f.')
      await answerOf(page, 'PATCH', /^\/parties\/[0-9a-f-]+$/, () => press(dialog(page).getByRole('button', { name: 'Save' })))
      await expect(page.getByText('Saved.').first()).toBeVisible()
    })

    await flow.step('addresses: registered office + invoices; the warehouse for deliveries', async () => {
      await sales.go(`/sales/customers/${party.id}?tab=addresses`)
      await press(page.getByRole('button', { name: 'Add address', exact: true }).first())
      let form = dialog(page)
      await form.getByRole('checkbox', { name: 'Deliveries', exact: true }).uncheck()
      await form.getByRole('checkbox', { name: 'Default delivery address' }).uncheck()
      await form.getByRole('textbox', { name: 'Street and number', exact: true }).fill('Via del Marchio 5')
      await form.getByRole('textbox', { name: 'CAP', exact: true }).fill('50100')
      await form.getByRole('textbox', { name: 'City', exact: true }).fill('Firenze')
      await form.getByRole('textbox', { name: 'Province', exact: true }).fill('FI')
      await answerOf(page, 'POST', /^\/parties\/[0-9a-f-]+\/addresses$/, () => press(form.getByRole('button', { name: 'Add address' })))
      await expect(page.getByText('Address added.').first()).toBeVisible()

      await press(page.getByRole('button', { name: 'Add address', exact: true }).first())
      form = dialog(page)
      await form.getByRole('textbox', { name: 'Name', exact: true }).fill('Magazzino')
      await form.getByRole('textbox', { name: 'Street and number', exact: true }).fill('Via del Deposito 9')
      await form.getByRole('textbox', { name: 'CAP', exact: true }).fill('50019')
      await form.getByRole('textbox', { name: 'City', exact: true }).fill('Sesto Fiorentino')
      await form.getByRole('textbox', { name: 'Province', exact: true }).fill('FI')
      await form.getByRole('checkbox', { name: 'Default delivery address' }).check()
      await answerOf(page, 'POST', /^\/parties\/[0-9a-f-]+\/addresses$/, () => press(form.getByRole('button', { name: 'Add address' })))
    })

    await flow.step('contacts: orders (Anna) and invoices (Bruno)', async () => {
      await press(page.getByRole('button', { name: 'Add contact' }).first())
      let form = dialog(page)
      await form.getByRole('textbox', { name: 'Name', exact: true }).fill(CUSTOMER.orders.name)
      await form.getByRole('textbox', { name: 'Email', exact: true }).fill(CUSTOMER.orders.email)
      await answerOf(page, 'POST', /^\/parties\/[0-9a-f-]+\/contacts$/, () => press(form.getByRole('button', { name: 'Add contact' })))
      await expect(page.getByText('Contact added.').first()).toBeVisible()

      await press(page.getByRole('button', { name: 'Add contact' }).first())
      form = dialog(page)
      await form.getByRole('textbox', { name: 'Name', exact: true }).fill(CUSTOMER.invoices.name)
      await form.getByRole('textbox', { name: 'Email', exact: true }).fill(CUSTOMER.invoices.email)
      await form.getByRole('checkbox', { name: /^Orders/ }).uncheck()
      await form.getByRole('checkbox', { name: /^Invoices/ }).check()
      await answerOf(page, 'POST', /^\/parties\/[0-9a-f-]+\/contacts$/, () => press(form.getByRole('button', { name: 'Add contact' })))
      await flow.shot(page, 'addresses-contacts')
    })

    await flow.step('VIES: the tax tab says an Italian number is not a VIES question (EU numbers outside Italy only)', async () => {
      await sales.go(`/sales/customers/${party.id}?tab=tax`)
      await expect(page.getByText('VIES checks EU VAT numbers outside Italy. This party has none to check.')).toBeVisible()
      await expect(page.getByRole('button', { name: 'Check VIES' })).toHaveCount(0)
      await flow.shot(page, 'tax-vies')
    })

    const saved = (await flow.read(page, `/parties/${party.id}`)).party
    expect(saved).toMatchObject({ code: CUSTOMER.code, legalName: CUSTOMER.legalName })
    expect(saved.contacts.map((contact: Record<string, any>) => contact.email).sort()).toEqual([CUSTOMER.orders.email, CUSTOMER.invoices.email].sort())
    await flow.settle()
  },
})
