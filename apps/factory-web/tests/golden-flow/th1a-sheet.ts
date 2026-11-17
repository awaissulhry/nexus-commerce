import { expect } from '@playwright/test'
import { BRAND_ALPHA, BRAND_BETA } from '../../src/lib/testing/two-brands'
import { expectNothingOf, pageWords, brandMarkersIn } from './_harness/brand-scan'
import { COMPANY, type Desk, type Flow, type Person } from './_harness/flow'
import { defineStage } from './_harness/stages'
import { words } from './_harness/words'

/**
 * B-TH-302 — UI golden flow TH-1a (threads plan, pictures 23 + 24; wall W17, W19, W27, W30; T00 at the screen level). Runs after
 * the W1 stages, on their world: customer A = the flow's own customer (01-customer, with its order of 06a) renamed Brand Alpha,
 * customer B = the seeded customer SEED-C1 (its seeded orders) renamed Brand Beta — the two made-up brands of
 * src/lib/testing/two-brands.ts. Through the screens:
 *   1. sales opens Sales › Orders: the sheet's Picture, Brand and Invoiced columns, every customer; the Customer switcher picks
 *      Brand Alpha → the title, the rows and the chip follow; Export ▾ names Brand Alpha and the file holds only Brand Alpha's
 *      orders (the export job's own file, read back);
 *   2. a person limited to Brand Beta (a sales role over that customer only) opens the sheet: the switcher is a fixed label,
 *      every row is Brand Beta's, and the DOM name scan finds nothing of Brand Alpha (no name, PO, order number); the same
 *      person's address naming Brand Alpha shows "not available" and no row.
 * Writes outside the screens (only the renames, as sales — the admin template reads no customer — and the limited person's
 * role, as the admin) go through flow.write.
 */

const S = words('orders-sheet')

async function limitedDesk(flow: Flow, from: Desk, party: string): Promise<Desk> {
  // The limited person: a sales role over Brand Beta only (its all-companies assignment ended).
  const made = await flow.control<Person & { password: string }>('POST', '/people', { key: 'betaOnly', role: 'sales', displayName: 'Bea Beta-only' })
  const admin = await flow.desk('admin')
  const roles = await flow.read(admin.page, `/auth/users/${made.id}/roles`)
  const live = (roles.assignments as Array<{ id: string; roleId: string; version: number; live: boolean }>).filter((entry) => entry.live)
  await flow.write(admin.page, 'POST', '/auth/office/step-up', { code: await flow.code(admin.person) })
  await flow.write(admin.page, 'POST', `/auth/users/${made.id}/roles`, { roleId: live[0]!.roleId, allCompanies: true, partyIds: [party] })
  for (const entry of live) await flow.write(admin.page, 'POST', `/auth/role-assignments/${entry.id}/end`, { version: entry.version })
  // Its own browser context (the same browser and web as the flow's desks), signed in through the sign-in screen.
  const context = await from.context.browser()!.newContext({ baseURL: new URL(from.page.url()).origin, viewport: { width: 1440, height: 900 }, locale: 'en-GB' })
  await context.addCookies([{ name: 'factory_locale', value: 'en', url: new URL(from.page.url()).origin }])
  const page = await context.newPage()
  const desk: Desk = { person: made, context, page, go: async (path) => void (await page.goto(`/w/${COMPANY}${path}`)) }
  flow.onClose(() => context.close())
  await flow.signIn(desk)
  return desk
}

export default defineStage({
  proves: 'the Orders sheet switched to customer A shows and exports customer A only (Picture, Brand, Invoiced); a person limited to customer B passes the DOM name scan (no row, count or file name of customer A)',
  async run(flow) {
    const sales = await flow.desk('sales')
    const { page } = sales
    const alphaId = flow.state.party.id as string
    const betaId = await flow.seedId('party:P1')
    const alphaOrder = flow.state.order as { id: string; number: string }

    await flow.step('the two customers become Brand Alpha and Brand Beta (made-up names)', async () => {
      for (const [id, brand] of [[alphaId, BRAND_ALPHA], [betaId, BRAND_BETA]] as const) {
        const party = (await flow.read(page, `/parties/${id}`)).party
        await flow.write(page, 'PATCH', `/parties/${id}`, { version: party.version, legalName: brand.legalName, tradeName: brand.tradeName })
      }
    })

    await flow.step('sales: the sheet of every customer — Picture, Brand, Invoiced; every number is a link', async () => {
      await sales.go('/sales/orders?rows=all')
      await expect(page.getByRole('columnheader', { name: S('col.picture') })).toBeVisible()
      await expect(page.getByRole('columnheader', { name: S('col.brand') })).toBeVisible()
      await expect(page.getByRole('columnheader', { name: S('col.invoiced') })).toBeVisible()
      await expect(page.getByRole('link', { name: alphaOrder.number, exact: true }).first()).toHaveAttribute('href', new RegExp(`/sales/orders/${alphaOrder.id}$`))
      await flow.shot(page, 'sheet-all')
    })

    await flow.step('sales picks Brand Alpha in the switcher: the title, the rows and the export follow', async () => {
      await page.getByRole('button', { name: new RegExp(S('switcher.all')) }).click()
      await page.getByRole('combobox', { name: S('switcher.search') }).fill('Brand Alpha')
      await page.getByRole('option', { name: new RegExp(BRAND_ALPHA.legalName.replace(/\./g, '\\.')) }).click()
      await page.waitForURL(new RegExp(`party=${alphaId}`))
      await expect(page.getByRole('heading', { name: S('titleOf', { name: BRAND_ALPHA.legalName }) })).toBeVisible()
      const rows = (await flow.read(page, `/sales/orders?partyId=${alphaId}&limit=200`)).orders as Array<{ partyId: string }>
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.every((row) => row.partyId === alphaId)).toBe(true)
      // Nothing of Brand Beta on Brand Alpha's sheet.
      await expectNothingOf(page, BRAND_BETA, [], 'Brand Alpha’s sheet')
      // The file: Export ▾ names Brand Alpha; the job's file holds Brand Alpha's orders only.
      await page.getByRole('button', { name: words('lists')('tools.exportLabel') }).click()
      await expect(page.getByText(S('export.heading', { customer: BRAND_ALPHA.legalName, view: words('orders')('rows.all') })).first()).toBeVisible()
      await page.keyboard.press('Escape')
      const job = await flow.write(page, 'POST', '/exports', { listKey: 'sales.orders', format: 'CSV', query: `rows=all&party=${alphaId}`, columns: [{ key: 'number', label: 'Number' }, { key: 'customer', label: 'Customer' }, { key: 'brand', label: 'Brand' }], title: 'Orders', locale: 'en' }, 201)
      await flow.settle()
      const done = (await flow.read(page, `/exports/${job.job.id}`)).job
      expect(done.status).toBe('DONE')
      expect(done.rowCount).toBe(rows.length)
      expect(brandMarkersIn(JSON.stringify(done), BRAND_BETA)).toEqual([])
      await flow.shot(page, 'sheet-alpha')
    })

    await flow.step('a person limited to Brand Beta: a fixed label, Brand Beta’s rows only, nothing of Brand Alpha (T00)', async () => {
      const beta = await limitedDesk(flow, sales, betaId)
      await beta.go('/sales/orders?rows=all')
      await expect(beta.page.getByText(S('switcher.fixed', { name: BRAND_BETA.legalName })).first()).toBeVisible()
      const rows = (await flow.read(beta.page, '/sales/orders?limit=200')).orders as Array<{ partyId: string }>
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.every((row) => row.partyId === betaId)).toBe(true)
      const customers = await flow.read(beta.page, '/sales/orders/customers')
      expect(customers).toMatchObject({ limited: true, total: 1 })
      await expectNothingOf(beta.page, BRAND_ALPHA, [alphaOrder.number, alphaId], 'Brand Beta’s person: the sheet')
      // A link naming Brand Alpha: "not available", no row, still no name.
      await beta.go(`/sales/orders?rows=all&party=${alphaId}`)
      await expect(beta.page.getByText(S('switcher.unavailable')).first()).toBeVisible()
      await expectNothingOf(beta.page, BRAND_ALPHA, [alphaOrder.number], 'Brand Beta’s person: a link to Brand Alpha')
      expect(brandMarkersIn(await pageWords(beta.page), BRAND_ALPHA)).toEqual([])
      await flow.shot(beta.page, 'sheet-beta-only')
    })
  },
})
