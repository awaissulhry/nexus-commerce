import { readFileSync } from 'node:fs'
import { inflateRawSync } from 'node:zlib'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { BRAND_ALPHA, BRAND_BETA, type BrandFixture } from '../../src/lib/testing/two-brands'
import { brandMarkersIn, expectNothingOf, pageWords } from './_harness/brand-scan'
import { COMPANY, seen, type Desk, type Flow, type Person } from './_harness/flow'
import { defineStage } from './_harness/stages'
import { ensureBrand, signInToPortal, type PortalDesk } from './_harness/two-brands'
import { startsWith, words } from './_harness/words'

/**
 * B-TH-247 — UI golden flow TH-4 (threads plan; SHEET.portal-sheet, SHEET.overall, SHEET.brand-fields; wall W10, W17, W39 — the
 * screens' twin of the API's golden flow B-TH-064, apps/factory-api/src/golden-flow/threads/th4.pg.vitest.test.ts). On the local
 * stack the browser golden flow starts (its own throwaway database, every outside service FAKE); it needs no W1 stage before it and
 * runs alone (`--stages th4-sheet`) or after th1b-request / th7-files in the same run (the two customers are made once: ensureBrand):
 *   S   the sales office makes the seeded P1 into Brand Alpha (customer A) and P3 into Brand Beta (customer B), each with its portal
 *       buyer; an order for each (A's from the seeded jacket, B's from a style the production manager makes for B's own label);
 *   C   the owner, on Admin › Fields "Add field to Order", makes a Text column FOR ONE CUSTOMER — Brand Alpha — shown in its portal
 *       (B-TH-242): the preview says it shows only on Brand Alpha's records;
 *   SW  sales on Sales › Orders: the sheet of every customer never offers A's or B's own column (Customise lists the column for every
 *       customer only); the Customer switcher picks Brand Alpha → its sheet offers A's column and the shared one, never B's; A's
 *       column is ticked in Customise and shows; Brand Beta's sheet offers B's column, never A's; A's sheet shows nothing of B;
 *   CE  A's column edited in its cell on A's order (saved: the API holds the value); someone else changes the order meanwhile (its
 *       note, through the API) → the next cell edit is refused in words ("someone changed it since you saw it"), nothing written;
 *       read again → the edit saves;
 *   OV  the overall view (All customers, "Group by customer"): A's header carries the server's figures and its order count opens
 *       exactly A's rows (the rows the API's filter of that door returns, all A's); the grand total is pinned under the grid;
 *   T39 customer A's buyer reads its own sheet in its portal (Orders & requests): A's column with the value as edited, never B's
 *       column, never the office's note; "Download all (Excel)" — the server's file holds A's column, its value and A's own order
 *       reference, nothing of B;
 *   T17 customer B's buyer reads its sheet (its own column and value) and downloads its file; every page B visits (its sheet, its
 *       order, the address of A's order: "Order not found") passes the DOM name scan, and its file and the file's name hold nothing
 *       of A (no name, code, contact, order number or id, column, value or note of A).
 * Writes outside the screens (set-up only, each said where it happens): the two customers' set-up (two-brands.ts), the two orders and
 * B's style (POST /sales/orders/manual, POST /product/styles), B's own column and the column for every customer (POST /fields) with
 * B's value (PUT /fields/values), and the "someone else" change of A's order note (POST /views/bulk/apply). The xlsx files are read
 * with a small zip reader (node:zlib): the file's XML parts are scanned as text — every cell, header and sheet name.
 */

const S = words('orders-sheet')
const L = words('lists')
const F = words('admin-fields')
const DS = words('ds-words')
const PO = words('portal-orders')
const PORTAL = words('portal')

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** A catalogue sentence as a regular expression: its placeholders match anything. */
const shaped = (text: string) => new RegExp(escape(text).replace(/\\\{[a-zA-Z]+\\\}/g, '.+'))

/** The columns of this flow (made-up words, codes apart from the API golden flow's: both may run on one database). */
const COLUMN = {
  alpha: { code: 'th4ui_alpha_lining', labelEn: 'Alpha lining UI (made up)', labelIt: 'Fodera Alpha UI (inventata)' },
  beta: { code: 'th4ui_beta_hanger', labelEn: 'Beta hanger UI (made up)', labelIt: 'Gruccia Beta UI (inventata)' },
  every: { code: 'th4ui_finish', labelEn: 'Finish UI (made up)', labelIt: 'Finitura UI (inventata)' },
} as const
const VALUE = { alpha: 'Made-up AL-31', alphaEdited: 'Made-up AL-32', beta: 'Made-up BH-41' } as const
const NOTE = 'Made-up: pack the Alpha jackets by size, UI flow.'

type Order = { id: string; number: string }
type Json = Record<string, any>

/** A day `days` after today (YYYY-MM-DD). */
const dayAhead = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)
const columnOf = (code: string) => `cf:${code}`
const toolLabel = (label: string) => L('custom.toolLabel', { label })

/** The page shows nothing of `brand` nor the run's own words of it; a screenshot for the record. */
async function scanned(flow: Flow, page: Page, brand: BrandFixture, extra: readonly string[], where: string): Promise<void> {
  await expectNothingOf(page, brand, extra, where)
  await flow.shot(page, where.replace(/[^a-z0-9]+/gi, '-').toLowerCase())
}

/**
 * The owner (every right: the fields' administration and the customers' read the "For: one customer" picker needs — the admin
 * template reads no customer) in a desktop context of its own, signed in through the sign-in screen like the flow's desks.
 */
async function ownerDesk(flow: Flow): Promise<Desk> {
  const person = await flow.control<Person>('POST', '/people', { key: 'th4Owner', role: 'owner', displayName: 'Olga Owner' })
  const context = await flow.browser.newContext({ baseURL: flow.web, viewport: { width: 1440, height: 900 }, locale: 'en-GB', timezoneId: 'Europe/Rome', colorScheme: 'light' })
  await context.addCookies([{ name: 'factory_locale', value: 'en', url: flow.web }])
  flow.onClose(() => context.close())
  const page = await context.newPage()
  page.on('pageerror', (error) => flow.problems.push(`${flow.stage} owner: page error: ${error.message}`))
  const desk: Desk = { person, context, page, go: async (path) => void (await page.goto(`/w/${COMPANY}${path}`)) }
  await flow.signIn(desk)
  return desk
}

/** The answer of the list's custom fields read (`GET /fields?recordType=ORDER`, the list's scope: one customer's sheet or none). */
function fieldsRead(page: Page, partyId: string | null): Promise<unknown> {
  return page.waitForResponse(
    (response) => {
      const url = new URL(response.url())
      return url.pathname === '/api/fields' && url.searchParams.get('recordType') === 'ORDER' && (url.searchParams.get('partyId') || null) === partyId && response.ok()
    },
    { timeout: 60_000 },
  )
}

/** A custom column's line in Customise ("<label> (custom field)"). */
const offered = (dialog: Locator, label: string) => dialog.getByRole('checkbox', { name: toolLabel(label), exact: true })

/**
 * Columns ▾ › Customise columns…: the dialog, once it lists `expected` (the list's custom fields are read a moment after the rows:
 * a dialog opened before lists none, so it is closed and opened again).
 */
async function openCustomise(page: Page, expected: string): Promise<Locator> {
  const dialog = page.getByRole('dialog', { name: L('tools.customise.title') })
  for (let attempt = 1; attempt <= 4; attempt++) {
    await page.getByRole('button', { name: L('tools.columnsLabel') }).first().click()
    await page.getByRole('menuitem', { name: startsWith(L('tools.customiseItem')) }).click()
    await dialog.waitFor({ state: 'visible' })
    const listed = await offered(dialog, expected)
      .waitFor({ state: 'visible', timeout: 5_000 })
      .then(() => true)
      .catch(() => false)
    if (listed) return dialog
    await closeDialog(page, dialog)
  }
  await expect(offered(dialog, expected), `Customise lists ${expected}`).toBeVisible()
  return dialog
}

async function closeDialog(page: Page, dialog: Locator): Promise<void> {
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'hidden' })
}

/**
 * Scrolls the grid to its right end (the custom columns sit before the ⋯ column; the grid draws only the columns in view) until the
 * column's header is drawn — again while the grid is still drawing its columns.
 */
async function reveal(page: Page, colId: string): Promise<void> {
  const header = page.locator(`.ag-header-cell[col-id="${colId}"]`)
  await seen(page.locator('.ag-header-cell'), 60_000)
  for (let attempt = 0; attempt < 5; attempt++) {
    await page.evaluate(() => {
      for (const element of Array.from(document.querySelectorAll('.ag-body-horizontal-scroll-viewport, .ag-center-cols-viewport'))) element.scrollLeft = element.scrollWidth
    })
    const drawn = await header
      .first()
      .waitFor({ state: 'visible', timeout: 3_000 })
      .then(() => true)
      .catch(() => false)
    if (drawn) return
  }
  await seen(header)
}

/** Ticks a custom column in Customise (Apply) unless it is shown already, then brings it into view. */
async function showColumn(page: Page, label: string, colId: string): Promise<void> {
  const dialog = await openCustomise(page, label)
  const box = offered(dialog, label)
  if (await box.isChecked()) {
    await closeDialog(page, dialog)
  } else {
    await box.check()
    await dialog.getByRole('button', { name: L('tools.customise.apply'), exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
  }
  await reveal(page, colId)
  await expect(page.getByRole('columnheader', { name: label })).toBeVisible()
}

/** The grid cell of a row and a column. */
const cellOf = (page: Page, rowId: string, colId: string) => page.locator(`.ag-row[row-id="${rowId}"] .ag-cell[col-id="${colId}"]`).first()

/** Types a value into a cell that edits (a double click opens its editor; Enter saves it through the list's bulk target). */
async function typeInCell(page: Page, rowId: string, colId: string, value: string): Promise<void> {
  const cell = cellOf(page, rowId, colId)
  await cell.waitFor({ state: 'visible' })
  await cell.dblclick()
  const editor = page.locator('.ag-cell-inline-editing input').first()
  await editor.waitFor({ state: 'visible' })
  await editor.fill(value)
  await editor.press('Enter')
}

/** A custom value as the API holds it (the office's read of the rows' values). */
async function valueOf(flow: Flow, page: Page, orderId: string, code: string): Promise<unknown> {
  const answer = await flow.write(page, 'POST', '/fields/rows/ORDER', { ids: [orderId] })
  const row = (answer.rows as Json[]).find((entry) => entry.id === orderId)
  return row?.values?.[code]?.value ?? null
}

// ---- the xlsx file: a zip whose XML parts hold every cell, header and sheet name -------------------------------------------------

/** The entries of a zip file (stored or deflated; the central directory's sizes, so a data descriptor does not matter). */
function zipEntries(zip: Buffer): Map<string, Buffer> {
  let end = -1
  for (let at = zip.length - 22; at >= Math.max(0, zip.length - 22 - 65_535); at--) {
    if (zip.readUInt32LE(at) === 0x06054b50) {
      end = at
      break
    }
  }
  if (end < 0) throw new Error('the download is not a zip (xlsx) file')
  const count = zip.readUInt16LE(end + 10)
  let at = zip.readUInt32LE(end + 16)
  const entries = new Map<string, Buffer>()
  for (let index = 0; index < count; index++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error('the xlsx file has a broken zip directory')
    const method = zip.readUInt16LE(at + 10)
    const size = zip.readUInt32LE(at + 20)
    const nameLength = zip.readUInt16LE(at + 28)
    const extraLength = zip.readUInt16LE(at + 30)
    const commentLength = zip.readUInt16LE(at + 32)
    const local = zip.readUInt32LE(at + 42)
    const name = zip.toString('utf8', at + 46, at + 46 + nameLength)
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
    const data = zip.subarray(start, start + size)
    entries.set(name, method === 0 ? Buffer.from(data) : inflateRawSync(data))
    at += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/** The text of an xlsx file: its XML parts with the tags taken out and the entities read. */
function xlsxText(bytes: Buffer): string {
  const parts = [...zipEntries(bytes)].filter(([name]) => name.endsWith('.xml')).map(([, data]) => data.toString('utf8'))
  return parts
    .join('\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** The portal's band ⋯ › "Download all (Excel)": the file the server wrote in the customer's own scope, as text, and its name. */
async function downloadAll(desk: PortalDesk): Promise<{ text: string; name: string }> {
  const { page } = desk
  await page.getByRole('button', { name: PORTAL('band.more') }).first().click()
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), page.getByRole('menuitem', { name: startsWith(PO('band.downloadAll')) }).click()])
  const path = await download.path()
  expect(path, 'the file arrived').toBeTruthy()
  const name = download.suggestedFilename()
  expect(name).toMatch(/\.xlsx$/)
  return { text: xlsxText(readFileSync(path!)), name }
}

export default defineStage({
  proves:
    'a column for customer A only is made on Admin › Fields and shows on A’s sheet only; a cell edit saves and a stale one is refused in words; the overall view’s totals open exactly the rows they count; A reads its own portal sheet and Excel; every page and the file customer B gets hold nothing of A',
  async run(flow) {
    const sales = await flow.desk('sales')
    const alphaId = await flow.seedId('party:P1')
    const betaId = await flow.seedId('party:P3')

    await flow.step('the sales office makes P1 Brand Alpha and P3 Brand Beta, each with its portal and its buyer', async () => {
      await ensureBrand(flow, sales, BRAND_ALPHA, alphaId)
      await ensureBrand(flow, sales, BRAND_BETA, betaId)
      await flow.settle()
    })

    const orders = await flow.step('set-up: an order for each customer — A’s from the seeded jacket, B’s from a style for its own label', async () => {
      const made = await flow.write(
        sales.page,
        'POST',
        '/sales/orders/manual',
        {
          companyId: flow.companyId,
          partyId: alphaId,
          customerRef: BRAND_ALPHA.customerRef,
          promiseDate: dayAhead(40),
          depositPct: null,
          lines: [{ styleId: await flow.seedId('product:style:JKT-01'), colourwayId: await flow.seedId('product:colourway:JKT-01:BLK'), sizes: [{ size: '50', quantity: 2 }, { size: '52', quantity: 3 }] }],
        },
        201,
      )
      // B's style, made by the production manager for B's own label (as the API golden flow does).
      const manager = await flow.desk('manager')
      const { style } = await flow.write(
        manager.page,
        'POST',
        '/product/styles',
        {
          code: 'TH4UI-BETA-01',
          name: 'Made-up Beta team jacket (UI flow)',
          productType: 'JACKET',
          season: 'FW27',
          brandPartyId: betaId,
          sizeScaleId: await flow.seedId('product:size-scale:EU-JKT'),
          sizes: ['50', '52'],
          baseSize: '52',
          ppeCategory: 'NOT_PPE',
          colourways: [{ code: 'BLU', name: 'Blu', colourId: await flow.seedId('product:colour:RED') }],
          generateSkus: true,
        },
        201,
      )
      await flow.write(manager.page, 'POST', `/product/styles/${style.id}/revisions`, { changeNote: 'First revision of TH4UI-BETA-01' }, 201)
      const theirs = await flow.write(
        sales.page,
        'POST',
        '/sales/orders/manual',
        { companyId: flow.companyId, partyId: betaId, customerRef: BRAND_BETA.customerRef, promiseDate: dayAhead(50), depositPct: null, lines: [{ styleId: style.id, colourwayId: style.colourways[0].id, unitPrice: '80', sizes: [{ size: '52', quantity: 4 }] }] },
        201,
      )
      await flow.settle()
      return { alpha: { id: made.order.id as string, number: made.order.number as string }, beta: { id: theirs.order.id as string, number: theirs.order.number as string } } satisfies Record<'alpha' | 'beta', Order>
    })

    /** What of customer A customer B must never see (the brand fixture's markers come from the scan itself). */
    const ofAlpha = [orders.alpha.number, orders.alpha.id, COLUMN.alpha.code, COLUMN.alpha.labelEn, COLUMN.alpha.labelIt, VALUE.alpha, VALUE.alphaEdited, NOTE]
    /** And the other way round: what this flow made of B's is on none of A's pages. */
    const ofBeta = [orders.beta.number, orders.beta.id, COLUMN.beta.code, COLUMN.beta.labelEn, COLUMN.beta.labelIt, VALUE.beta]

    await flow.step('the owner makes a Text column for Brand Alpha only on Admin › Fields, shown in its portal; set-up: B’s own column and one for every customer', async () => {
      const owner = await ownerDesk(flow)
      const { page } = owner
      // A fresh step-up first, so neither the screen's save nor the set-up writes below stop for one.
      await flow.write(page, 'POST', '/auth/office/step-up', { code: await flow.code(owner.person) })
      const editorRead = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/fields/editor' && response.ok(), { timeout: 60_000 })
      await owner.go('/admin/fields?type=ORDER')
      await editorRead
      await page.getByRole('button', { name: F('band.add'), exact: true }).first().click()
      const dialog = page.getByRole('dialog', { name: shaped(F('fieldDialog.title')) })
      await dialog.waitFor({ state: 'visible', timeout: 60_000 })
      await dialog.getByRole('radio', { name: startsWith(F('type.TEXT')) }).click()
      // Required fields: the label's mark is not part of the accessible name.
      await dialog.getByRole('textbox', { name: F('fieldDialog.labelIt'), exact: true }).fill(COLUMN.alpha.labelIt)
      await dialog.getByRole('textbox', { name: F('fieldDialog.labelEn'), exact: true }).fill(COLUMN.alpha.labelEn)
      await dialog.getByRole('textbox', { name: F('fieldDialog.code'), exact: true }).fill(COLUMN.alpha.code)
      const portal = dialog.getByRole('switch', { name: F('fieldDialog.portal') })
      if ((await portal.getAttribute('aria-checked')) !== 'true') await portal.click()
      await expect(portal).toHaveAttribute('aria-checked', 'true')
      // For: one customer only → find Brand Alpha and pick it.
      await dialog.getByRole('radio', { name: startsWith(F('customer.one')) }).click()
      await dialog.getByRole('searchbox', { name: F('customer.search') }).fill(BRAND_ALPHA.tradeName)
      await dialog.getByRole('radio', { name: new RegExp(`^${escape(BRAND_ALPHA.legalName)}`) }).click()
      await seen(dialog.getByText(shaped(F('customer.previewOne', { customer: BRAND_ALPHA.legalName }))))
      await flow.shot(page, 'field-for-alpha')
      await dialog.getByRole('button', { name: F('fieldDialog.add'), exact: true }).click()
      await flow.stepUp(page, owner.person, 4_000)
      await dialog.waitFor({ state: 'hidden', timeout: 60_000 })
      const editor = (await flow.read(page, '/fields/editor?recordType=ORDER')).fields as Json[]
      expect(editor.find((field) => field.code === COLUMN.alpha.code)).toMatchObject({ partyId: alphaId, shownInPortal: true, type: 'TEXT' })
      // Set-up (no screen needed twice): B's own column, shown in its portal, and a column for every customer (the office only).
      await flow.write(page, 'POST', '/fields', { recordType: 'ORDER', type: 'TEXT', shownInPortal: true, ...COLUMN.beta, partyId: betaId }, 201)
      await flow.write(page, 'POST', '/fields', { recordType: 'ORDER', type: 'TEXT', shownInPortal: false, ...COLUMN.every }, 201)
      const onB = await flow.write(sales.page, 'PUT', `/fields/values/ORDER/${orders.beta.id}`, { values: [{ code: COLUMN.beta.code, value: VALUE.beta, version: null }] })
      expect(onB.set).toEqual([COLUMN.beta.code])
      await flow.shot(page, 'fields-of-orders')
    })

    await flow.step('sales: the sheet of every customer offers no customer’s own column; Brand Alpha’s sheet offers A’s (never B’s) and shows it; Brand Beta’s offers B’s (never A’s)', async () => {
      const { page } = sales
      // Every customer: the column for every customer only (W17: a customer's own column is never on a list of every customer).
      const everyRead = fieldsRead(page, null)
      await sales.go('/sales/orders?rows=all')
      await everyRead
      let dialog = await openCustomise(page, COLUMN.every.labelEn)
      await expect(offered(dialog, COLUMN.alpha.labelEn)).toHaveCount(0)
      await expect(offered(dialog, COLUMN.beta.labelEn)).toHaveCount(0)
      await closeDialog(page, dialog)
      // The Customer switcher picks Brand Alpha: its title, its rows, its own columns.
      const alphaRead = fieldsRead(page, alphaId)
      await page.getByRole('button', { name: new RegExp(S('switcher.all')) }).click()
      await page.getByRole('combobox', { name: S('switcher.search') }).fill(BRAND_ALPHA.tradeName)
      await page.getByRole('option', { name: new RegExp(escape(BRAND_ALPHA.legalName)) }).click()
      await page.waitForURL(new RegExp(`party=${alphaId}`))
      await expect(page.getByRole('heading', { name: S('titleOf', { name: BRAND_ALPHA.legalName }) })).toBeVisible()
      await alphaRead
      dialog = await openCustomise(page, COLUMN.alpha.labelEn)
      await expect(offered(dialog, COLUMN.every.labelEn)).toBeVisible()
      await expect(offered(dialog, COLUMN.beta.labelEn)).toHaveCount(0)
      await closeDialog(page, dialog)
      await showColumn(page, COLUMN.alpha.labelEn, columnOf(COLUMN.alpha.code))
      await seen(page.getByRole('link', { name: orders.alpha.number, exact: true }))
      await expectNothingOf(page, BRAND_BETA, ofBeta, 'Brand Alpha’s sheet')
      await flow.shot(page, 'sheet-alpha-column')
      // Brand Beta's sheet: its own column, never A's.
      const betaRead = fieldsRead(page, betaId)
      await sales.go(`/sales/orders?rows=all&party=${betaId}`)
      await betaRead
      dialog = await openCustomise(page, COLUMN.beta.labelEn)
      await expect(offered(dialog, COLUMN.alpha.labelEn)).toHaveCount(0)
      await closeDialog(page, dialog)
      await flow.shot(page, 'sheet-beta')
    })

    await flow.step('A’s column edited in its cell: saved; a change made meanwhile refuses the next edit in words, nothing written; read again, it saves', async () => {
      const { page } = sales
      const colId = columnOf(COLUMN.alpha.code)
      const alphaRead = fieldsRead(page, alphaId)
      await sales.go(`/sales/orders?rows=all&party=${alphaId}`)
      await alphaRead
      await showColumn(page, COLUMN.alpha.labelEn, colId)
      // 1. The value typed in the cell: saved through the order's own command (the list's bulk target).
      await typeInCell(page, orders.alpha.id, colId, VALUE.alpha)
      await seen(page.getByText(shaped(DS('saveStatus.savedAt'))), 60_000)
      await expect(cellOf(page, orders.alpha.id, colId)).toContainText(VALUE.alpha)
      expect(await valueOf(flow, page, orders.alpha.id, COLUMN.alpha.code)).toBe(VALUE.alpha)
      // 2. Someone else changes the order meanwhile (set-up, through the API: the order note at the version it has now).
      const rows = (await flow.read(page, `/sales/orders?partyId=${alphaId}&limit=200`)).orders as Json[]
      const now = rows.find((row) => row.id === orders.alpha.id)!
      const applied = (await flow.write(page, 'POST', '/views/bulk/apply', { listKey: 'sales.orders', rows: [{ id: orders.alpha.id, version: now.version, changes: { note: NOTE } }] })).results as Json[]
      expect(applied[0]).toMatchObject({ id: orders.alpha.id, ok: true })
      // The screen still holds the version it read: its next edit is refused in words, never written over the other change.
      await typeInCell(page, orders.alpha.id, colId, VALUE.alphaEdited)
      // The save status says it in words: "1 change not saved — Not changed: someone changed it since you saw it. …".
      await seen(page.getByText(L('edit.refusal.stale')), 60_000)
      await seen(page.getByText(DS('saveStatus.failed', { count: 1 })))
      expect(await valueOf(flow, page, orders.alpha.id, COLUMN.alpha.code)).toBe(VALUE.alpha)
      await flow.shot(page, 'cell-stale')
      // 3. Read again: the edit saves.
      const again = fieldsRead(page, alphaId)
      await page.reload()
      await again
      await showColumn(page, COLUMN.alpha.labelEn, colId)
      await typeInCell(page, orders.alpha.id, colId, VALUE.alphaEdited)
      await seen(page.getByText(shaped(DS('saveStatus.savedAt'))), 60_000)
      expect(await valueOf(flow, page, orders.alpha.id, COLUMN.alpha.code)).toBe(VALUE.alphaEdited)
      await flow.shot(page, 'cell-saved')
    })

    await flow.step('the overall view grouped by customer: A’s header holds the server’s figures and its order count opens exactly A’s rows; the grand total is pinned', async () => {
      const { page } = sales
      await sales.go('/sales/orders?rows=all')
      await page.getByRole('combobox', { name: S('group.label') }).selectOption('party')
      await page.waitForURL(/group=party/)
      // The server's figures, as the page reads them (rows=all: the summary's terms are the customer grouping alone).
      const summary = await flow.read(page, '/sales/orders/summary?group=party')
      const group = (summary.groups as Json[]).find((entry) => entry.partyId === alphaId)
      expect(group, 'Brand Alpha has its group').toBeTruthy()
      const count = group!.figures.orders.count as number
      expect(count).toBeGreaterThan(0)
      const all = summary.all.orders.count as number
      const total = page.getByRole('group', { name: S(summary.limited ? 'totals.allMine' : 'totals.all'), exact: true })
      await expect(total.getByRole('link', { name: S('totals.orders', { count: all, n: all }), exact: true })).toBeVisible({ timeout: 60_000 })
      const figures = page.getByRole('group', { name: S('totals.of', { name: group!.name as string }), exact: true })
      const door = figures.getByRole('link', { name: S('totals.orders', { count, n: count }), exact: true })
      await door.waitFor({ state: 'visible', timeout: 60_000 })
      await flow.shot(page, 'overall-grouped')
      await door.click()
      await page.waitForURL(new RegExp(`party=${alphaId}`))
      // The door opens exactly what it counts: the rows its own filter returns, every one Brand Alpha's.
      const filter = group!.figures.orders.filter as Record<string, string>
      const opened = (await flow.read(page, `/sales/orders?limit=200&${new URLSearchParams(filter).toString()}`)).orders as Json[]
      expect(opened.length, 'the door counts its rows').toBe(count)
      expect(new Set(opened.map((row) => row.partyId))).toEqual(new Set([alphaId]))
      expect(opened.map((row) => row.id)).toContain(orders.alpha.id)
      await seen(page.getByRole('link', { name: orders.alpha.number, exact: true }), 60_000)
      expect(await pageWords(page)).not.toContain(orders.beta.number)
      await flow.shot(page, 'overall-door-alpha')
    })

    const alpha = await test.step('customer A’s buyer signs in through the portal’s screens', () => signInToPortal(flow, BRAND_ALPHA, alphaId))

    await flow.step('T39: customer A reads its own sheet in its portal — its column as edited, never B’s, never the office note — and downloads it', async () => {
      const { page } = alpha
      await alpha.go('/orders')
      await reveal(page, columnOf(COLUMN.alpha.code))
      await expect(page.getByRole('columnheader', { name: COLUMN.alpha.labelEn })).toBeVisible({ timeout: 60_000 })
      await seen(page.getByText(VALUE.alphaEdited).first())
      await expect(page.getByRole('columnheader', { name: COLUMN.beta.labelEn })).toHaveCount(0)
      const shown = await pageWords(page)
      expect(shown).not.toContain(NOTE)
      expect(shown).not.toContain(orders.alpha.number)
      expect(brandMarkersIn(shown, BRAND_BETA, ofBeta)).toEqual([])
      await flow.shot(page, 'alpha-portal-sheet')
      const file = await downloadAll(alpha)
      expect(file.text).toContain(COLUMN.alpha.labelEn)
      expect(file.text).toContain(VALUE.alphaEdited)
      expect(file.text).toContain(BRAND_ALPHA.customerRef)
      expect(file.text).not.toContain(NOTE)
      expect(brandMarkersIn(`${file.name}\n${file.text}`, BRAND_BETA, ofBeta), 'A’s file holds only A’s rows').toEqual([])
    })

    const beta = await test.step('customer B’s buyer signs in through the portal’s screens', () => signInToPortal(flow, BRAND_BETA, betaId))

    await flow.step('T17 / T00: customer B’s sheet, its file, its order and the address of A’s order hold nothing of customer A', async () => {
      const { page } = beta
      await beta.go('/orders')
      await reveal(page, columnOf(COLUMN.beta.code))
      await expect(page.getByRole('columnheader', { name: COLUMN.beta.labelEn })).toBeVisible({ timeout: 60_000 })
      await seen(page.getByText(VALUE.beta).first())
      await expect(page.getByRole('columnheader', { name: COLUMN.alpha.labelEn })).toHaveCount(0)
      await scanned(flow, page, BRAND_ALPHA, ofAlpha, 'beta portal sheet')
      const file = await downloadAll(beta)
      expect(file.text).toContain(VALUE.beta)
      expect(brandMarkersIn(`${file.name}\n${file.text}`, BRAND_ALPHA, ofAlpha), 'B’s file and its name hold nothing of A').toEqual([])
      await beta.go(`/orders/${orders.beta.id}`)
      await seen(page.getByText(BRAND_BETA.customerRef).first(), 60_000)
      await scanned(flow, page, BRAND_ALPHA, ofAlpha, 'beta own order')
      // Customer A's order by its address: the neutral page, as for any id that is not theirs.
      await beta.go(`/orders/${orders.alpha.id}`)
      await seen(page.getByText(PO('record.missing')).first(), 60_000)
      await seen(page.getByText(PO('record.missingBody')).first())
      await scanned(flow, page, BRAND_ALPHA, ofAlpha, 'beta address of A order')
    })
  },
})
