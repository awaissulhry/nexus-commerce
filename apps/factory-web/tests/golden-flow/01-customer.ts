import { expect } from '@playwright/test'
import { defineStage } from './_harness/stages'
import { answerOf, dialog, press, routerActivity } from './_harness/ui'
import { words } from './_harness/words' // F-OP-218
import { seen } from './_harness/flow' // F-CP-112

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
  proves: 'Italian B2B customer with tax identity; VIES proof (fake): an Italian VAT number is not a VIES question, and the screen says so; the customer page opens on All orders (rows=all, one document, no loop), New order and its lines open in place, Clear all goes back to All orders, a docked order shows its own files line (F-CP-112)',
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

    // ---- T.2 (customers list, cl lane): the list's band and its order — a step that writes nothing (one navigation, two address
    // writes). Most urgent first is the order; the band counts customers; a pressed door shows exactly the customers it counted.
    await flow.step('the customers list: Most urgent first, the band of customers by phase, a pressed door shows the customers it counts, then leaves', async () => {
      const CL = words('customers-list')
      const P = words('parties')
      await sales.go('/sales/customers')
      await expect(page.getByRole('button', { name: CL('sort.aria', { order: CL('sort.needs') }), exact: true })).toBeVisible()
      const band = page.getByRole('group', { name: new RegExp(`^(${CL('band.label.all')}|${CL('band.label.yours')})$`) })
      await expect(band).toBeVisible()
      const doors = band.locator('button[aria-pressed]')
      await expect(doors).toHaveCount(7)
      const counts = await doors.evaluateAll((nodes) => nodes.map((node) => Number(node.querySelector('.c')?.textContent ?? '0')))
      const first = counts.findIndex((count) => count > 0)
      const at = first >= 0 ? first : counts.length - 1
      const said = counts[at] ?? 0
      await press(doors.nth(at))
      await expect(page).toHaveURL(/[?&]work=[A-Z_]+(&|$)/)
      await expect(doors.nth(at)).toHaveAttribute('aria-pressed', 'true')
      // The count it said = the rows its press shows (the toolbar's "{shown} of {total}").
      await expect(page.getByText(P('list.count', { shown: Math.min(said, 50), total: said }), { exact: true }).first()).toBeVisible()
      await flow.shot(page, 'customers-band-door')
      // A second press leaves: the list as it was.
      await press(doors.nth(at))
      await expect(page).not.toHaveURL(/[?&]work=/)
    })

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
      // F-CP-112 (customer page plan C1, F-CP-101): the customer page opens on All orders — the entry address written once, rows=all.
      await expect(page).toHaveURL(/[?&]rows=all(&|$)/)
      expect(page.url()).not.toMatch(/[?&]status=all(&|$)/)
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

    // ---- F-CP-112 (customer page plan C2a, F-CP-104 / F-CP-113): New order from the band opens in place — the customer held (no
    // Change), Add the lines opens the New order page's own editor in a large window — with no document and no address written.
    await flow.step('New order opens in place on the customer page: the customer held (no Change), its lines in a large window, no navigation', async () => {
      const P = words('parties')
      const O = words('orders')
      await sales.go(`/sales/customers/${party.id}?tab=work`)
      await expect(page).toHaveURL(/[?&]rows=all(&|$)/)
      const at = new URL(page.url())
      const activity = await routerActivity(page, 4_000, async () => {
        await press(page.getByRole('button', { name: P('customers.band.newOrder'), exact: true }).first())
        const form = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: O('newOrder.addLines'), exact: true }) }).last()
        await seen(form, 30_000)
        // The customer is the page's: picked on open, no search, no Change.
        await expect(form.getByText(CUSTOMER.legalName).first()).toBeVisible({ timeout: 30_000 })
        await expect(form.getByRole('button', { name: O('newOrder.change'), exact: true })).toHaveCount(0)
        await expect(form.getByRole('textbox', { name: O('newOrder.customer'), exact: true })).toHaveCount(0)
        await press(form.getByRole('button', { name: O('newOrder.addLines'), exact: true }))
        // The lines window: the New order page's own editor (Discard · Confirm order) over the Work tab.
        const lines = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: O('newOrder.confirm'), exact: true }) }).last()
        await seen(lines, 30_000)
      })
      const said = activity.lines.join('\n')
      expect(activity.documents, said).toBe(0)
      expect(activity.writes, said).toBe(0)
      expect(new URL(page.url()).pathname, said).toBe(at.pathname)
      await flow.shot(page, 'customer-new-order-lines-window')
      // Nothing typed: the window closes without asking and nothing is made.
      await page.keyboard.press('Escape')
      const ask = page.getByRole('dialog', { name: O('newOrder.discardAsk.title') })
      if (await ask.isVisible().catch(() => false)) await press(ask.getByRole('button', { name: O('newOrder.discard'), exact: true }))
      await expect(page.getByRole('dialog').filter({ has: page.getByRole('button', { name: O('newOrder.confirm'), exact: true }) })).toHaveCount(0, { timeout: 15_000 })
      expect(((await flow.read(page, `/sales/orders?partyId=${party.id}&limit=5`)).orders as unknown[]).length).toBe(0)
    })

    // ---- F-CP-112 (F-CP-102): Clear all goes back to the customer page's own default — All orders (rows=all) — not Open orders.
    await flow.step('Clear all on the customer page goes back to All orders (rows=all), the terms gone', async () => {
      const S = words('orders-sheet')
      await sales.go(`/sales/customers/${party.id}?tab=work&rows=all&atRisk=true&invoiced=NONE`)
      await expect(page).toHaveURL(/[?&]atRisk=true/)
      await press(page.getByRole('button', { name: S('chips.clearAll'), exact: true }).first())
      await expect(page).not.toHaveURL(/[?&](atRisk|invoiced)=/, { timeout: 15_000 })
      await expect(page).toHaveURL(/[?&]rows=all(&|$)/)
      expect(page.url()).not.toMatch(/[?&]rows=open(&|$)/)
    })

    // ---- F-CP-112 (F-CP-111): a row of a customer's orders docks that order — its thread and its own files line (the order's set).
    await flow.step('the dock’s files line: a row of a customer’s orders docks the order with its own files line', async () => {
      const RTF = words('record-thread-files')
      const P1 = await flow.seedId('party:P1')
      const SO1 = await flow.seedId('sales:SO1')
      await sales.go(`/sales/customers/${P1}?tab=work`)
      const row = page.locator(`.ag-row[row-id="${SO1}"]`).first()
      await seen(row, 60_000)
      await row.locator('.ag-cell[col-id="status"]').first().click()
      const card = page.locator('.fw-rcf.has-thread > aside.fw-rcf-dock section.fw-rt-column.is-docked')
      await expect(card).toHaveCount(1, { timeout: 60_000 })
      const chip = card.locator('.fw-rtf-chip').first()
      await seen(chip, 60_000)
      // "Files (N)" — the order's own set, N = its Files tab's count — or, when every file is priced for this reader, the lock's words.
      const RF = words('record-files')
      const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const shown = [escape(RTF('chip.label', { count: 7 })).replace('7', '\\d+'), escape(RF('priced.lockedCount', { count: 7 })).replace('7', '\\d+'), escape(RF('priced.lockedCount', { count: 1 }))]
      await expect(chip).toHaveText(new RegExp(`^(${shown.join('|')})`))
      await chip.click()
      await expect(card.locator('.fw-rtf-all').first()).toContainText(RTF('strip.all'))
      await flow.shot(page, 'customer-dock-order-files')
    })
    // ---- end F-CP-112

    const saved = (await flow.read(page, `/parties/${party.id}`)).party
    expect(saved).toMatchObject({ code: CUSTOMER.code, legalName: CUSTOMER.legalName })
    expect(saved.contacts.map((contact: Record<string, any>) => contact.email).sort()).toEqual([CUSTOMER.orders.email, CUSTOMER.invoices.email].sort())
    await flow.settle()
  },
})
