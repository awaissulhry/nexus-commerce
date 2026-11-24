import { expect, type Locator /* cw fx10 */, type Page } from '@playwright/test'
import { defineStage } from './_harness/stages'
import { answerOf, chooseFromMenu /* cw T.2 */, dialog, press, routerActivity } from './_harness/ui'
import { exactly /* ca T.3 */, startsWith /* cw T.2 */, words } from './_harness/words' // F-OP-218
import { seen } from './_harness/flow' // F-CP-112

/**
 * cw fx4: how many rows the grids of the page show now — the DISTINCT `row-id`s of `.ag-row[row-id]`, with no container class.
 * AG Grid 36 has no `.ag-center-cols-container` any more (it is `.ag-grid-scrolling-container`: the note in packages/ui
 * grid/editors/openGesture.ts), so a locator through it found nothing and waited its whole timeout; and a pinned column draws the
 * same row two or three times, so the rows are counted by their own ids. Seen on a running page: 8 rows, 8 ids, 0 by the old class.
 */
const shownRows = (page: Page): Promise<number> => page.locator('.ag-row[row-id]').evaluateAll((rows) => new Set(rows.map((row) => row.getAttribute('row-id'))).size)

// cw fx10: tick rows so that the tick HOLDS. The shared grid takes its ticks from the page's state each time the rows' data is new;
// a tick made in the same moment as a re-read of the rows (after a door: the rows, then their depth, then the unread counts — each
// one is new row data) is taken off again, and the bar then counts one less (the end check on 5b89a0befc: "1 selected" for two
// clicks). So: the rows are picked ONCE by their own ids (the grid does not keep its rows in the order on screen), a row is ticked
// only while its own box is not ticked, and the whole is tried again until the bar counts them. The box is the grid's own:
// `.ag-selection-checkbox` with its `input[type=checkbox]` inside (read from the failed run's page).
const tickRows = async (scope: Page | Locator, count: number, said: Locator): Promise<void> => {
  const ids = (await scope.locator('.ag-row[row-id]:has(.ag-selection-checkbox)').evaluateAll((rows) => Array.from(new Set(rows.map((row) => row.getAttribute('row-id') ?? ''))))).filter((id) => id !== '').slice(0, count)
  expect(ids.length, 'the rows to tick').toBe(count)
  await expect(async () => {
    for (const id of ids) {
      const box = scope.locator(`.ag-row[row-id="${id}"] .ag-selection-checkbox`).first()
      if (!(await box.locator('input[type="checkbox"]').first().isChecked({ timeout: 5_000 }))) await box.click({ timeout: 5_000 })
    }
    await expect(said.first()).toBeVisible({ timeout: 3_000 })
  }).toPass({ timeout: 60_000 })
}

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
  proves: 'Italian B2B customer with tax identity; VIES proof (fake): an Italian VAT number is not a VIES question, and the screen says so; the customer page opens on All orders (rows=all, one document, no loop), New order and its lines open in place, Clear all goes back to All orders, a docked order shows its own files line (F-CP-112); on the Work tab a band door shows exactly its count, the order says Most urgent first, ticked rows show the bar with words and Ask production opens with Needs an answer ticked, nothing written (cw T.2); on Quotes & incoming the band shows, a door opens exactly its count, Sort ▾ says Most urgent first, one ticked row shows at most 3 acts and More ▾ with words, nothing written (cq T.2); the Overview shows its sentence and a group of its band opens Work on exactly the orders it counts, nothing written (co T.3); People & addresses opened at #addresses shows its section, and People lists the two contacts with what each gets by e-mail, nothing written (ca T.3); the payment terms set with Change terms… on Terms & requirements, #party-hold in view and the answer line naming them, nothing written (ct T.3)',
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
      // F-CW-201 (lead settle S16): … most urgent first — the default order written beside the default view, in the same ONE write.
      await expect(page).toHaveURL(/[?&]sort=urgent(&|$)/)
    })

    // F-OP-218 (order page plan N4; 11-dock §0, §3.4; D11): the customer page's dock is the same ONE card as the order page's — the pick
    // band inside it; All of <customer> read only, with its Head and the foot "Read only. Write in: [<customer> (general)]".
    // tw- T.3 (W2.1, Z4): the pick is the head's title — ONE menu, one label per thread.
    await flow.step('the customer page’s dock: the pick in the head’s title; All of <customer> with its Head and its read-only foot', async () => {
      const P = words('parties')
      const OD = words('orders')
      const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const card = page.locator('.fw-rcf.has-thread > aside.fw-rcf-dock section.fw-rt-column.is-docked')
      await expect(card).toHaveCount(1, { timeout: 60_000 })
      const pick = card.locator('.fw-rth-title button.fw-thread-pick-title')
      await expect(pick).toBeVisible()
      await expect(pick).toHaveAttribute('aria-label', new RegExp(`^${escape(P('customers.work.dock.label'))}: `))
      const allWords = P('customers.work.dock.all', { customer: CUSTOMER.legalName })
      await chooseFromMenu(pick, page.getByRole('menuitemcheckbox', { name: new RegExp(`^${escape(allWords)}`) }))
      await expect(pick).toHaveAttribute('aria-label', `${P('customers.work.dock.label')}: ${allWords}`)
      await expect(page).toHaveURL(/[?&]dock=all/)
      await expect(card.locator('.fw-rth.fw-aoc-head')).toBeVisible()
      await expect(card.locator('.fw-rt-foot')).toContainText(`${P('customers.work.dock.readOnly')}. ${OD('record.dock.writeIn')}`)
      await expect(card.locator('.fw-rt-foot').getByRole('button', { name: P('customers.work.dock.general', { customer: CUSTOMER.legalName }), exact: true })).toBeVisible()
      await flow.shot(page, 'customer-dock-all')
    })

    // F-CT-527 (customer page › Terms & requirements, ct-w2 W2.3; Z8): the payment terms have ONE editor — Change terms… on Terms &
    // requirements (the Edit window no longer carries them): a term of the library (the base seed's BB30FM), PATCH …/commercial-terms.
    await flow.step('payment terms on Terms & requirements: Change terms… picks a term of the library', async () => {
      await sales.go(`/sales/customers/${party.id}?tab=terms#party-commercial`)
      await press(page.getByRole('button', { name: 'Change terms…', exact: true }).first())
      await dialog(page).getByRole('combobox', { name: 'Payment terms', exact: true }).selectOption({ label: 'BB30FM · Bank transfer 30 days end of month' })
      // ct-fx2: BB30FM asks no share on the order, so a new quote would carry NO deposit (quoteDefaultsOf: terms with no order
      // share → none) — the later stages (06a accept, 06b TD02, 07 order, 10 release) read the deposit the sales settings gave
      // before (30 %). The customer's own default deposit keeps it: 30 %.
      await dialog(page).getByRole('textbox', { name: 'Default deposit %', exact: true }).fill('30')
      await answerOf(page, 'PATCH', /^\/parties\/[0-9a-f-]+\/commercial-terms$/, () => press(dialog(page).getByRole('button', { name: 'Save terms', exact: true })))
      await expect(page.getByText('Commercial terms saved.', { exact: false }).first()).toBeVisible()
    })

    // ---- co T.3 (customer page › Overview, co-w1 / co-w2; 15-steps T.3): the Overview on the seeded customer, WRITING NOTHING — its
    // sentence (the kit's `.fw-so-headline`, as on the order page); the Work tab's own band inside its card: a group (found by its
    // word) opens Work on exactly its orders (`phase=`), the sheet shows the count the group said; back to the Overview; what stops the
    // customer is a list by its name when something does. Selectors verified look-only on the test server (the lead, 2026-11-24).
    await flow.step('the Overview: its sentence; a group of the band opens Work on exactly its orders (phase=, the count it says); back; what stops the customer is a named list (nothing written)', async () => {
      const P = words('parties')
      const S = words('orders-sheet')
      const O = words('orders')
      const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const P1 = await flow.seedId('party:P1')
      await sales.go(`/sales/customers/${P1}?tab=overview`)
      // The sentence: the kit's own class, ONE on the tab (th9 reads the same class on the order page).
      await seen(page.locator('.fw-so-headline'), 60_000)
      await expect(page.locator('.fw-so-headline')).toHaveCount(1)
      // The band: the Work tab's own group "Orders by where they are" inside its card — found by the GROUP (the card's title says the
      // region's words too). Cancelled is not in the group.
      const group = page.getByRole('group', { name: P('customers.work.band.pipeline'), exact: true })
      await seen(group, 60_000)
      const PHASES: ReadonlyArray<readonly [string, string]> = [
        ['NOT_SENT', S('phase.NOT_SENT')],
        ['NOT_STARTED', S('phase.NOT_STARTED')],
        ['IN_PRODUCTION', O('rows.IN_PRODUCTION')],
        ['READY', O('rows.READY')],
        ['SHIPPED', O('rows.SHIPPED')],
        ['DONE', S('phase.DONE')],
      ]
      const named = (word: string) => new RegExp(`^${escape(word)}\\b`)
      let picked: { readonly phase: string; readonly word: string; readonly count: number } | null = null
      for (const [phase, word] of PHASES) {
        const button = group.getByRole('button', { name: named(word) })
        await expect(button, word).toHaveCount(1)
        // Its name is the word, a space, the count.
        const count = Number((await button.innerText()).match(/(\d+)\s*$/)?.[1] ?? '0')
        if (count > 0 && picked === null) picked = { phase, word, count }
      }
      expect(picked, 'the seeded customer has an order in a group of the band').not.toBeNull()
      const { phase, word, count } = picked!
      await press(group.getByRole('button', { name: named(word) }))
      // The door: the Work tab on exactly that group's orders (its entry adds the lock and every order, once); the group pressed there.
      await expect(page).toHaveURL(new RegExp(`[?&]phase=${phase}(&|$)`), { timeout: 30_000 })
      await expect(page).toHaveURL(/[?&]tab=work(&|$)/)
      await expect(page.getByRole('group', { name: P('customers.work.band.pipeline'), exact: true }).getByRole('button', { name: named(word) })).toHaveAttribute('aria-pressed', 'true', { timeout: 30_000 })
      // The sheet passes through 0 rows first: polled, never one read.
      await expect.poll(() => shownRows(page), { timeout: 60_000 }).toBe(count)
      await flow.shot(page, 'customer-overview-group-door')
      // Back: the Overview again, with its sentence.
      await page.goBack()
      await expect(page).toHaveURL(/[?&]tab=overview(&|$)/, { timeout: 30_000 })
      await seen(page.locator('.fw-so-headline'), 60_000)
      // What stops the customer: a list by its name (its role and its catalogue word) — drawn only when something stops it.
      const stops = page.getByRole('list', { name: new RegExp(`^${escape(P('customers.overview.strip.label', { customer: '@@' })).replace('@@', '.+')}$`) })
      if ((await stops.count()) > 0) await expect(stops.getByRole('listitem').first()).toBeVisible()
      await flow.shot(page, 'customer-overview')
    })
    // ---- end co T.3

    await flow.step('addresses: registered office + invoices; the warehouse for deliveries', async () => {
      await sales.go(`/sales/customers/${party.id}?tab=addresses`)
      // F-CA-W1 (ca-w1, Z22): with no address yet, the Addresses head says "Add the registered office" (the Owner's picture).
      await press(page.getByRole('button', { name: 'Add the registered office', exact: true }).first())
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

    // ---- ca T.3 (customer page › People & addresses; 15-steps T.3): a door to #addresses shows the Addresses section in view; People
    // lists the two contacts just added, each with what it gets by e-mail (the mail rule's words). A step that writes nothing. Its parts
    // are found by their role and their catalogue word: the Kit's section is a region named by its title, People's list is named
    // "People of <customer>", each person a list item.
    await flow.step('People & addresses: #addresses shows its section; People lists Anna and Bruno with what each gets by e-mail (nothing written)', async () => {
      const P = words('parties')
      const C = words('customer-people')
      // Nothing is written: no change reaches the customer, its contacts or addresses, an address check, the portal or a profile.
      const written: string[] = []
      const onRequest = (request: import('@playwright/test').Request) => {
        const path = new URL(request.url()).pathname
        if (request.method() !== 'GET' && /\/(parties|sales\/delivery-addresses|partners|sales\/mtm)(\/|$)/.test(path)) written.push(`${request.method()} ${path}`)
      }
      page.on('request', onRequest)
      await sales.go(`/sales/customers/${party.id}?tab=people#addresses`)
      const addresses = page.getByRole('region', { name: P('address.title'), exact: true })
      await seen(addresses, 60_000)
      await expect(addresses).toHaveCount(1)
      await expect(addresses).toBeInViewport({ timeout: 30_000 })
      const people = page.getByRole('list', { name: exactly(C('people.listLabel')) })
      await seen(people, 60_000)
      const anna = people.getByRole('listitem').filter({ hasText: CUSTOMER.orders.name })
      const bruno = people.getByRole('listitem').filter({ hasText: CUSTOMER.invoices.name })
      await expect(anna).toHaveCount(1)
      await expect(bruno).toHaveCount(1)
      // Anna is the Orders contact (the oldest with an e-mail): quotes and confirmations go to her; Bruno gets the invoices.
      await expect(anna).toContainText(C('gets.QUOTES_AND_CONFIRMATIONS'))
      await expect(bruno).toContainText(C('gets.INVOICES_AND_REMINDERS'))
      await expect(bruno).not.toContainText(C('gets.QUOTES_AND_CONFIRMATIONS'))
      await flow.shot(page, 'people-addresses')
      page.off('request', onRequest)
      expect(written, 'nothing was written').toEqual([])
    })
    // ---- end ca T.3

    await flow.step('VIES: the tax tab says an Italian number is not a VIES question (EU numbers outside Italy only)', async () => {
      await sales.go(`/sales/customers/${party.id}?tab=tax`)
      // F-CT-518 (ct-w2 W2.2): the old tax tab opens Terms & requirements; its Tax identity section says it in ONE quiet line.
      await expect(page.getByText('VIES is not needed: it checks EU VAT numbers outside Italy.')).toBeVisible()
      await expect(page.getByRole('button', { name: 'Check VIES' })).toHaveCount(0)
      await flow.shot(page, 'tax-vies')
    })

    // ---- ct T.3 (customer page › Terms & requirements, ct-t; 15-steps T.3): the Hold door lands on the Hold section in view, and the
    // answer line names the payment terms the "Change terms…" step above set (the base seed's BB30FM, its English name). A step that
    // writes nothing. Its parts are found by the ids the tab draws (`#party-hold`, the answer line `#answer`); selectors from the code.
    await flow.step('Terms & requirements: #party-hold shows the Hold section in view; the answer line names the payment terms (nothing written)', async () => {
      // Nothing is written: no change reaches the customer, its terms, holds, requirements or carrier account.
      const written: string[] = []
      const onRequest = (request: import('@playwright/test').Request) => {
        const path = new URL(request.url()).pathname
        if (request.method() !== 'GET' && /\/(parties|customer-carrier-accounts)(\/|$)/.test(path)) written.push(`${request.method()} ${path}`)
      }
      page.on('request', onRequest)
      await sales.go(`/sales/customers/${party.id}?tab=terms#party-hold`)
      const hold = page.locator('#party-hold')
      await seen(hold, 60_000)
      await expect(hold).toHaveCount(1)
      await expect(hold).toBeInViewport({ timeout: 30_000 })
      await expect(page.locator('#answer')).toContainText('Bank transfer 30 days end of month', { timeout: 30_000 })
      await flow.shot(page, 'terms-hold')
      page.off('request', onRequest)
      expect(written, 'nothing was written').toEqual([])
    })
    // ---- end ct T.3

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

    // ---- F-CP-112 (F-CP-111): a row of a customer's orders docks that order — its thread and its own files (the order's set).
    // tw- T.3 (W2.1): the files line went; the head's Files icon says "Files (N)", N = the order's Files tab's count.
    await flow.step('the dock’s Files icon: a row of a customer’s orders docks the order with its own files count', async () => {
      const HEAD = words('record-thread-head')
      const P1 = await flow.seedId('party:P1')
      const SO1 = await flow.seedId('sales:SO1')
      await sales.go(`/sales/customers/${P1}?tab=work`)
      const row = page.locator(`.ag-row[row-id="${SO1}"]`).first()
      await seen(row, 60_000)
      // cw-fx1: the Work tab's row no longer shows Status beside the dock (it is chip 1 of Where it is; Status waits in Customise).
      // Promised is in every set of the Work tab's columns; the click lands on the cell's own padding (top left), off the date's
      // link, so it is the row's click: it docks the order and navigates nowhere.
      await row.locator('.ag-cell[col-id="promised"]').first().click({ position: { x: 6, y: 6 } })
      const card = page.locator('.fw-rcf.has-thread > aside.fw-rcf-dock section.fw-rt-column.is-docked')
      await expect(card).toHaveCount(1, { timeout: 60_000 })
      const files = card.locator('.fw-rth-tools button.fw-rth-files').first()
      await seen(files, 60_000)
      // "Files (N)" — the order's own set (a priced file is counted apart, never named): look only, nothing opened.
      const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      await expect(files).toHaveAttribute('aria-label', new RegExp(`^${escape(HEAD('files.label', { count: 7 })).replace('7', '\\d+')}$`))
      await expect(card.locator('.fw-rtf-chip, .fw-rtf-line')).toHaveCount(0)
      await flow.shot(page, 'customer-dock-order-files')
    })
    // ---- end F-CP-112

    // ---- cw T.2 (customer Work tab, W1–W3): the tab's own things on the seeded customer — a band door, the tab's order, the bar of
    // ticked rows, Ask production. Found by role and by catalogue word; NOTHING is written (the note window is closed with Escape).
    await flow.step('the Work tab: a band door opens exactly its count, the order says "Most urgent first", ticked rows show the bar with words, Ask production opens with "Needs an answer" ticked (nothing written)', async () => {
      const P = words('parties')
      const S = words('orders-sheet')
      const D = words('sales-orders-depth')
      const N = words('production-notes')
      const L = words('lists')
      const P1 = await flow.seedId('party:P1')
      await sales.go(`/sales/customers/${P1}?tab=work`)
      // The entry writes the tab's own order beside its default view, and the Sort menu says it.
      await expect(page).toHaveURL(/[?&]sort=urgent(&|$)/, { timeout: 30_000 })
      await seen(page.getByRole('button', { name: S('sort.now', { sort: S('sort.urgent') }), exact: true }), 60_000)
      // cw fx4: the rows by their own ids (shownRows above) — never through a container class of the grid.
      await seen(page.locator('.ag-row[row-id]'), 60_000)
      const all = await shownRows(page)
      expect(all, 'the seeded customer has an order').toBeGreaterThan(0)
      // A door of the band (the first group that holds an order) shows exactly its count of orders; pressed again: all orders.
      // F-CQ-B: the groups are the design system's filter tiles in a named group (they were a list); each number keeps `.fw-cwb-num`.
      const doors = page.getByRole('group', { name: P('customers.work.band.pipeline'), exact: true }).getByRole('button')
      await seen(doors, 30_000)
      let door = doors.first()
      let count = 0
      for (let index = 0; index < (await doors.count()); index += 1) {
        const held = Number((await doors.nth(index).locator('.fw-cwb-num').first().innerText()).replace(/\D/g, ''))
        if (held > 0) {
          door = doors.nth(index)
          count = held
          break
        }
      }
      expect(count, 'the seeded customer has an order in a group of the band').toBeGreaterThan(0)
      await press(door)
      await expect(door).toHaveAttribute('aria-pressed', 'true', { timeout: 30_000 })
      await expect(page).toHaveURL(/[?&]phase=[A-Z_]+(&|$)/)
      await expect.poll(() => shownRows(page), { timeout: 60_000 }).toBe(count)
      await flow.shot(page, 'customer-work-band-door')
      await press(door)
      await expect(page).not.toHaveURL(/[?&]phase=/, { timeout: 30_000 })
      await expect.poll(() => shownRows(page), { timeout: 60_000 }).toBe(all)
      // Tick rows (two when the customer has two): the bar shows its acts WITH WORDS, then More ▾.
      const boxes = page.locator('.ag-row .ag-selection-checkbox')
      const ticked = Math.min(2, await boxes.count())
      expect(ticked, 'a row to tick').toBeGreaterThan(0)
      // cw fx10: ticked so that the tick holds (tickRows above) — a single click per row lost one tick in an end check.
      await tickRows(page, ticked, page.getByText(L('selected', { count: ticked }), { exact: true }))
      const ask = page.getByRole('button', { name: S('bar.ask'), exact: true }).first()
      await expect(ask).toContainText(S('bar.ask'))
      await expect(page.getByRole('button', { name: D('list.setPriority', { count: ticked }), exact: true }).first()).toContainText(D('list.setPriority', { count: ticked }))
      await seen(page.getByRole('button', { name: S('bar.more'), exact: true }), 30_000)
      await flow.shot(page, 'customer-work-bar')
      // Ask ▾ › Ask production about N…: production's Note window, "Needs an answer" ticked; Escape closes it and nothing is written.
      const written: string[] = []
      const onRequest = (request: import('@playwright/test').Request) => {
        if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/production/notes')) written.push(request.url())
      }
      page.on('request', onRequest)
      await chooseFromMenu(ask, page.getByRole('menuitem', { name: startsWith(S('bar.askProduction', { count: ticked })) }))
      const note = page.getByRole('dialog', { name: S('bar.askProductionTitle', { count: ticked }), exact: true })
      await seen(note, 30_000)
      await expect(note.getByRole('checkbox', { name: startsWith(N('needsAnswer.label')) }).first()).toBeChecked()
      await expect(note.getByText(S('bar.askProductionThen'), { exact: true })).toBeVisible()
      await flow.shot(page, 'customer-work-ask-production')
      await page.keyboard.press('Escape')
      await expect(note).toHaveCount(0, { timeout: 15_000 })
      page.off('request', onRequest)
      expect(written, 'nothing was written').toEqual([])
    })
    // ---- end cw T.2

    // ---- cq T.2 (customer page › Quotes & incoming, W1–W3): the tab's own things on the seeded customer — the band "Before an order",
    // a door's number = the rows it opens, Sort ▾ Most urgent first, one ticked quote's bar (at most 3 acts + More ▾, each with words).
    // Found by role and by catalogue word; NOTHING is written (Escape leaves; no write reaches a quote, a request, a thread or a task).
    await flow.step('Quotes & incoming: the band shows, a door opens exactly its count, Sort ▾ says "Most urgent first", one ticked row shows at most 3 acts and More ▾ with words (nothing written)', async () => {
      const B = words('before-order')
      const P = words('parties')
      const Q = words('sales')
      const S = words('orders-sheet')
      const L = words('lists')
      const P1 = await flow.seedId('party:P1')
      const written: string[] = []
      const onRequest = (request: import('@playwright/test').Request) => {
        const path = new URL(request.url()).pathname
        if (request.method() !== 'GET' && /\/(sales\/(quotes|inquiries|order-requests)|threads|partners|tasks)(\/|$)/.test(path) && !/\/(pictures|unread)$/.test(path)) written.push(`${request.method()} ${path}`)
      }
      page.on('request', onRequest)
      await sales.go(`/sales/customers/${P1}?tab=quotes`)
      // The band: "Before an order · <customer>", its doors in life order, each a filter tile (a button) with its number.
      // F-CQ-B: the doors are the design system's filter tiles in a named group (they were links in a list); each number keeps `.fw-bo-count`.
      const band = page.getByRole('region', { name: startsWith(B('band.title')) })
      await seen(band, 60_000)
      const doors = band.getByRole('group', { name: B('band.pipeline'), exact: true }).getByRole('button')
      await seen(doors, 30_000)
      await flow.shot(page, 'customer-quotes-band')
      // A door that holds something (the seeded customer has its quotes): the lists below show exactly its count of rows.
      let door = doors.first()
      let count = 0
      for (let index = 0; index < (await doors.count()); index += 1) {
        const held = Number((await doors.nth(index).locator('.fw-bo-count').first().innerText()).replace(/\D/g, ''))
        if (held > 0) {
          door = doors.nth(index)
          count = held
          break
        }
      }
      expect(count, 'the seeded customer has something before an order').toBeGreaterThan(0)
      await door.click()
      await expect(page).toHaveURL(/[?&]group=[A-Z_]+(&|$)/, { timeout: 30_000 })
      // cw fx4 (the same cause as the Work step above; this step's own locator, nothing else of it touched): the rows by their ids.
      await expect.poll(() => shownRows(page), { timeout: 60_000 }).toBe(count)
      await flow.shot(page, 'customer-quotes-door')
      // The same door again: everything again (the address without the door, one replace).
      await door.click()
      await expect(page).not.toHaveURL(/[?&]group=/, { timeout: 30_000 })
      // The Quotes section: Sort ▾ says "Most urgent first".
      const quotes = page.getByRole('region', { name: P('customers.quotesTab.quotes'), exact: true })
      await seen(quotes, 30_000)
      const sort = quotes.getByRole('combobox', { name: S('sort.label'), exact: true })
      await expect(sort).toHaveValue('urgent', { timeout: 30_000 })
      await expect(sort.locator('option:checked')).toHaveText(Q('list.sort.urgent'))
      // One ticked quote: the bar shows at most 3 acts, each with words, and More ▾ (with its word) when there are more.
      const boxes = quotes.locator('.ag-row .ag-selection-checkbox')
      await seen(boxes, 60_000)
      // cw fx10: the same tick that holds as the Work step's (tickRows above; the same grid, the same shape).
      await tickRows(quotes, 1, quotes.getByText(L('selected', { count: 1 }), { exact: true }))
      const bar = quotes.locator('.fw-many-bar')
      await seen(bar, 30_000)
      const more = bar.getByRole('button').filter({ hasText: B('acts.more') })
      const acts = bar.getByRole('button').filter({ hasNotText: B('acts.more') })
      const shown = await acts.count()
      expect(shown, 'at most 3 acts on the bar').toBeLessThanOrEqual(3)
      for (let index = 0; index < shown; index += 1) expect((await acts.nth(index).innerText()).trim(), 'each act says what it does').not.toBe('')
      // A role that changes none reads one line instead (never an empty bar).
      if (shown === 0) await expect(bar.getByText(B('acts.noAct'), { exact: true })).toBeVisible()
      if ((await more.count()) > 0) await expect(more.first()).toHaveAttribute('aria-label', new RegExp(B('acts.moreLabel', { count: 0 }).replace('0', '\\d+')))
      await flow.shot(page, 'customer-quotes-bar')
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 15_000 })
      page.off('request', onRequest)
      expect(written, 'nothing was written').toEqual([])
    })
    // ---- end cq T.2

    const saved = (await flow.read(page, `/parties/${party.id}`)).party
    expect(saved).toMatchObject({ code: CUSTOMER.code, legalName: CUSTOMER.legalName })
    expect(saved.contacts.map((contact: Record<string, any>) => contact.email).sort()).toEqual([CUSTOMER.orders.email, CUSTOMER.invoices.email].sort())
    await flow.settle()
  },
})
