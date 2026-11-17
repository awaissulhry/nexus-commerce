import { deflateSync } from 'node:zlib'
import { expect, test, type Page } from '@playwright/test'
import { BRAND_ALPHA, BRAND_BETA, type BrandFixture } from '../../src/lib/testing/two-brands'
import { expectNothingOf, pageWords } from './_harness/brand-scan'
import { COMPANY, seen, type Desk, type Flow } from './_harness/flow'
import { defineStage } from './_harness/stages'
import { ensureBrand, signInToPortal, type PortalDesk } from './_harness/two-brands'
import { pdf } from './_harness/ui'
import { words } from './_harness/words'

/**
 * B-TH-284 — UI golden flow TH-7: CUSTOMERS SEND FILES (threads plan TH-7; P-CUS-NEW.files, T9, T6-F05/F07/F08; walls W25, W26 — the
 * screens' twin of the API's golden flow B-TH-087, apps/factory-api golden-flow/threads/th7). On the local stack the browser golden
 * flow starts (its own throwaway database, every outside service FAKE, the virus scanner too: the stack's control `/scanner`), it
 * needs no W1 stage before it and runs after th1b-request as well (the two brands are made once per run):
 *   S   the sales office makes the seeded P1 into Brand Alpha (customer A) and P3 into Brand Beta (customer B), each with its portal
 *       and its buyer, who may also upload files (the upload capability), and signs in through the portal's screens;
 *   1   customer A writes a request on New order and drops two photos and a PDF it ticks "This is a measurement sheet"; Send: the
 *       receipt says its own number and "3 files sent" (they go right after Send, scanned clean by the fake scanner); the request
 *       page shows the three files in its conversation; the office reads them on the request, the sheet filed MEASUREMENTS;
 *   2   held for the virus scan until clean: with the scanner down, a file customer A adds on its request page says "Held for the
 *       virus scan" (QUARANTINED, scan PENDING on the office's read); the scanner back and its sweep run, the file is clean;
 *   3   the office (sales) opens the request in Sales › Incoming's reading pane: the customer's message carries the two photos and
 *       the measurement sheet, each with its Open;
 *   4   the production manager (sales.measurements.view) opens the measurement sheet from the pane: its download answers;
 *   5   finance (no sales.measurements.view, no sales.inquiries.view) opens the request's record page: the photos by name, the sheet
 *       never named ("Measurement sheet — you cannot open it"); the sheet answers 404 and is listed locked and nameless (its API read);
 *   T00 customer B sends its own request with a photo of its own and visits its receipt, Home, Orders & requests, its own request
 *       and the address of customer A's request ("Request not found", neutral words): every page passes the DOM name scan — no name,
 *       code, number, PO, id or file name of customer A, nor the office number of A's request.
 * Writes outside the screens: only the set-up (the two customers as th1b-request makes them, each buyer's upload capability, the
 * office step-up before it) as the sales office, and the fake scanner switched on, down and back through the stack's control.
 */

const ORDERING = words('portal-ordering')
const COMPOSE = words('request-compose')
const REQUEST = words('portal-requests')
const CARD = words('record-thread-card')

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** A catalogue sentence as a regular expression: its placeholders match anything. */
const shaped = (text: string) => new RegExp(escape(text).replace(/\\\{[a-zA-Z]+\\\}/g, '.+'))

const SUBJECT = 'Made-up: eight made-to-measure jackets'
const PHOTO_FRONT = 'alpha-front-photo.png'
const PHOTO_BACK = 'alpha-back-photo.png'
const SHEET = 'alpha-measurements.pdf'
const LATE = 'alpha-collar-photo.png'
const BETA_SUBJECT = 'Made-up: three team vests'
const BETA_PHOTO = 'beta-vest-photo.png'

type Json = Record<string, any>
type Upload = { name: string; mimeType: string; buffer: Buffer }

// ---- made-up files: a real 1×1 PNG (any reader decodes it) and the harness's one-page PDF ----------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (bytes: Buffer): number => {
  let c = 0xffffffff
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type: string, data: Buffer): Buffer => {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}
/** A 1×1 RGB PNG of one colour (each photo its own colour, so each has its own bytes). */
function png(name: string, rgb: readonly [number, number, number]): Upload {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(1, 0)
  header.writeUInt32BE(1, 4)
  header.set([8, 2, 0, 0, 0], 8)
  const pixels = deflateSync(Buffer.from([0, ...rgb]))
  const buffer = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', pixels), chunk('IEND', Buffer.alloc(0))])
  return { name, mimeType: 'image/png', buffer }
}

// ---- the screens ------------------------------------------------------------------------------------------------------------

/** A fresh office step-up (the next authenticator code) before the set-up's signing act. */
async function steppedUp(flow: Flow, office: Desk): Promise<void> {
  await flow.write(office.page, 'POST', '/auth/office/step-up', { code: await flow.code(office.person) })
}

/** The brand's buyer may also upload files (B-TH-085: the portal's uploads need the upload capability). Set-up, once per run. */
async function buyerUploads(flow: Flow, office: Desk, brand: BrandFixture, partyId: string): Promise<void> {
  const access = await flow.read(office.page, `/partners/${partyId}`)
  const person = (access.people as Json[]).find((entry) => String(entry.email).toLowerCase() === brand.portalPerson.email.toLowerCase())
  expect(person, `${brand.tradeName}'s buyer is invited`).toBeTruthy()
  if ((person!.capabilities as string[]).includes('upload')) return
  await steppedUp(flow, office)
  await flow.write(office.page, 'PATCH', `/partners/${partyId}/people/${person!.id}`, { capabilities: [...new Set([...(person!.capabilities as string[]), 'comment', 'upload'])], version: person!.version })
}

/** The office's files of the request (the sales office reads them: names, kinds, the sheet's category, the scan). */
async function officeFiles(flow: Flow, office: Desk, inquiryId: string): Promise<Json[]> {
  return (await flow.read(office.page, `/files?recordType=Inquiry&recordId=${inquiryId}`)).files as Json[]
}

/**
 * New order as an e-mail with files (B-TH-220, B-TH-282): the subject, the message, the files dropped in the drop area (a sheet
 * ticked "This is a measurement sheet"), under "Add details" the PO; Send. The files go right after Send: waits until the receipt
 * says they were all sent. Returns the receipt's own number and the request's id (from the receipt's "Open the request").
 */
async function sendRequest(desk: PortalDesk, input: { subject: string; message: string; customerRef: string; files: readonly Upload[]; sheets?: readonly string[] }): Promise<{ seq: number; id: string }> {
  const { page } = desk
  await desk.go('/orders/new')
  await page.getByLabel(COMPOSE('subject.label'), { exact: true }).fill(input.subject)
  await page.getByRole('textbox', { name: COMPOSE('message.label'), exact: true }).fill(input.message)
  // The drop area once the portal said files go (GET /portal/inquiries/open: open on the local stack); the input behind "browse".
  const area = page.locator('.fw-rqc-files.is-open')
  await area.locator('.nds-dropzone').waitFor({ state: 'visible', timeout: 60_000 })
  await area.locator('input[type="file"]').setInputFiles([...input.files])
  const listed = page.getByRole('list', { name: COMPOSE('files.listLabel'), exact: true })
  for (const file of input.files) await seen(listed.getByText(file.name, { exact: true }))
  // "This is a measurement sheet" on the PDF (body data: in the office only the people who handle measurements open it).
  for (const name of input.sheets ?? []) {
    await listed.getByRole('listitem').filter({ hasText: name }).getByRole('checkbox', { name: new RegExp(`^${escape(COMPOSE('files.sheet'))}`) }).check()
  }
  await page.getByText(COMPOSE('details.title'), { exact: true }).click()
  await page.getByLabel(COMPOSE('details.ref'), { exact: true }).fill(input.customerRef)
  await page.getByRole('button', { name: COMPOSE('send.send'), exact: true }).click()
  const title = await seen(page.getByText(shaped(ORDERING('receipt.title'))), 60_000)
  const seq = Number(/(\d+)\.$/.exec((await title.textContent()) ?? '')?.[1])
  expect(seq, 'the receipt names the customer’s own number').toBeGreaterThan(0)
  // The files' outcome on the receipt: every file sent (scanned clean); one held or failed would never let this count show.
  await seen(page.getByText(COMPOSE('files.outcome.sent', { count: input.files.length })), 60_000)
  const href = await page.getByRole('link', { name: ORDERING('receipt.open') }).first().getAttribute('href')
  const id = /\/orders\/requests\/([0-9a-f-]{36})/.exec(href ?? '')?.[1]
  expect(id, `the receipt opens the request (${href})`).toBeTruthy()
  return { seq, id: id! }
}

/** The page shows nothing of `brand` nor the run's own words of it (numbers, ids, subject, file names); a screenshot for the record. */
async function scanned(flow: Flow, page: Page, brand: BrandFixture, extra: readonly string[], where: string): Promise<void> {
  await expectNothingOf(page, brand, extra, where)
  await flow.shot(page, where.replace(/[^a-z0-9]+/gi, '-').toLowerCase())
}

export default defineStage({
  proves:
    'customer A sends a request with two photos and a ticked measurement sheet (fake virus scanner: a file is held until its scan says clean); the office opens the request in Incoming’s reading pane and sees the files; the production manager opens the sheet, finance never sees it named; every page customer B visits passes the DOM name scan (no file or name of customer A)',
  // B-TH-280: the generic record page finance reaches (/records/Inquiry/<id>) is the office thread now (B-TH-272): the sheet reads
  // "Measurement sheet — you cannot open it" there too, so nothing of this stage is blocked any more.
  async run(flow) {
    const sales = await flow.desk('sales')
    const alphaId = await flow.seedId('party:P1')
    const betaId = await flow.seedId('party:P3')
    type Run = { id: string; seq: number; office: string; files: Record<'front' | 'back' | 'sheet' | 'late', string> }
    const run = {} as Run

    // The fake virus scanner for this stage only; the process's own (off) again afterwards, whatever happens.
    await flow.control('POST', '/scanner', { mode: 'fake' })
    try {
      await flow.step('the sales office makes P1 Brand Alpha and P3 Brand Beta (once per run), each buyer may also upload files', async () => {
        await ensureBrand(flow, sales, BRAND_ALPHA, alphaId)
        await ensureBrand(flow, sales, BRAND_BETA, betaId)
        await buyerUploads(flow, sales, BRAND_ALPHA, alphaId)
        await buyerUploads(flow, sales, BRAND_BETA, betaId)
        await flow.settle()
      })

      // Not a kept step: a run attached to a kept stack (FACTORY_BGF_RESUME) signs both buyers in again in its new browser.
      const { alpha, beta } = await test.step('each buyer signs in through the portal’s screens (the mailed link, Continue, the first visit)', async () => ({
        alpha: await signInToPortal(flow, BRAND_ALPHA, alphaId),
        beta: await signInToPortal(flow, BRAND_BETA, betaId),
      }))

      Object.assign(
        run,
        await flow.step('customer A sends a request with two photos and a PDF ticked “This is a measurement sheet”: the receipt says its own number and 3 files sent', async () => {
          const sent = await sendRequest(alpha, {
            subject: SUBJECT,
            message: `${BRAND_ALPHA.message}\nEight jackets, the jacket from both sides and the riders’ sizes attached.`,
            customerRef: BRAND_ALPHA.customerRef,
            files: [png(PHOTO_FRONT, [20, 20, 20]), png(PHOTO_BACK, [200, 30, 30]), { ...pdf('alpha rider sizes'), name: SHEET }],
            sheets: [SHEET],
          })
          await flow.shot(alpha.page, 'alpha-receipt-files')
          await flow.settle()
          const record = (await flow.read(sales.page, `/sales/inquiries/${sent.id}`)).inquiry
          expect(record).toMatchObject({ source: 'PORTAL', party: { id: alphaId }, customerRef: BRAND_ALPHA.customerRef })
          expect(await pageWords(alpha.page)).not.toContain(record.number as string)
          // On the request, each scanned clean; the PDF filed MEASUREMENTS (the tick), the photos as photos.
          const files = await officeFiles(flow, sales, sent.id)
          const named = (name: string) => files.find((file) => file.originalName === name)
          for (const name of [PHOTO_FRONT, PHOTO_BACK, SHEET]) expect(named(name), name).toMatchObject({ status: 'AVAILABLE', scanStatus: 'CLEAN' })
          expect(named(PHOTO_FRONT)).toMatchObject({ kind: 'PHOTO' })
          expect(named(SHEET)).toMatchObject({ category: 'MEASUREMENTS' })
          expect(named(PHOTO_FRONT)?.category ?? null).not.toBe('MEASUREMENTS')
          return { ...sent, office: record.number as string, files: { front: named(PHOTO_FRONT)!.id as string, back: named(PHOTO_BACK)!.id as string, sheet: named(SHEET)!.id as string, late: '' } }
        }),
      )

      await flow.step('customer A’s request page shows the three files in its conversation', async () => {
        const { page } = alpha
        await alpha.go(`/orders/requests/${run.id}`)
        await seen(page.getByRole('heading', { name: REQUEST('title', { seq: run.seq }) }), 60_000)
        for (const name of [PHOTO_FRONT, PHOTO_BACK, SHEET]) await seen(page.getByText(name, { exact: true }), 60_000)
        await flow.shot(page, 'alpha-request-files')
      })

      run.files.late = await flow.step('held for the virus scan until clean: with the scanner down a file added on the request page waits; the scanner back, its sweep makes it clean', async () => {
        const { page } = alpha
        await flow.control('POST', '/scanner', { mode: 'down' })
        // "Add files" beside the thread (the request's door while undecided): sent at once with "Send the file".
        const area = page.locator('.fw-preq-files .fw-rqc-files.is-open')
        await area.locator('.nds-dropzone').waitFor({ state: 'visible', timeout: 60_000 })
        await area.locator('input[type="file"]').setInputFiles(png(LATE, [30, 30, 200]))
        await seen(area.getByText(LATE, { exact: true }))
        await area.getByRole('button', { name: COMPOSE('files.send', { count: 1 }), exact: true }).click()
        await seen(area.getByText(COMPOSE('files.state.scanning')), 60_000)
        await flow.shot(page, 'alpha-file-held-for-scan')
        const held = (await officeFiles(flow, sales, run.id)).find((file) => file.originalName === LATE)
        expect(held, 'the held file is on the request').toMatchObject({ status: 'QUARANTINED', scanStatus: 'PENDING' })
        // The scanner back: the scheduler's sweep scans what waits; the file becomes clean (AVAILABLE).
        await flow.control('POST', '/scanner', { mode: 'fake' })
        await flow.control('POST', '/tick/scan', {})
        const clean = (await officeFiles(flow, sales, run.id)).find((file) => file.originalName === LATE)
        expect(clean, 'the swept file').toMatchObject({ status: 'AVAILABLE', scanStatus: 'CLEAN' })
        return clean!.id as string
      })

      await flow.step('the office opens the request in Incoming’s reading pane: the customer’s message carries the two photos and the measurement sheet', async () => {
        const { page } = sales
        await sales.go(`/sales/incoming?open=${run.id}`)
        await seen(page.getByText(SUBJECT).first(), 60_000)
        for (const name of [PHOTO_FRONT, PHOTO_BACK, SHEET]) await seen(page.getByRole('button', { name: CARD('files.open', { name }), exact: true }), 60_000)
        await flow.shot(page, 'office-pane-files')
      })

      await flow.step('the production manager opens the measurement sheet from the pane: its download answers', async () => {
        const manager = await flow.desk('manager')
        const { page } = manager
        await manager.go(`/sales/incoming?open=${run.id}`)
        await seen(page.getByText(SUBJECT).first(), 60_000)
        const open = await seen(page.getByRole('button', { name: CARD('files.open', { name: SHEET }), exact: true }), 60_000)
        const [answer] = await Promise.all([page.waitForResponse((response) => new URL(response.url()).pathname === `/api/files/${run.files.sheet}/download`, { timeout: 30_000 }), open.click()])
        expect(answer.status(), 'the sheet’s download for the production manager').toBe(200)
        // Named for him (he holds sales.measurements.view): the list reads it unlocked.
        const listed = (await flow.read(page, `/files?recordType=Inquiry&recordId=${run.id}`)).files as Json[]
        expect(listed.find((file) => file.id === run.files.sheet)).toMatchObject({ originalName: SHEET })
        expect(listed.find((file) => file.id === run.files.sheet)?.locked).toBeUndefined()
        await flow.shot(page, 'manager-opened-sheet')
      })

      await flow.step('finance opens the request’s record page: the photos by name, the measurement sheet never named; locked and 404 for finance', async () => {
        const finance = await flow.desk('finance')
        const { page } = finance
        await finance.go(`/records/Inquiry/${run.id}?label=${encodeURIComponent(run.office)}&company=${flow.companyId}`)
        await seen(page.getByText(PHOTO_FRONT).first(), 60_000)
        const shown = await pageWords(page)
        expect(shown, 'finance’s record page names the sheet').not.toContain(SHEET)
        // B-TH-280: the old record panels are gone — the page's thread says the sheet is locked, in words, without its name.
        await seen(page.getByText('Measurement sheet — you cannot open it').first(), 30_000)
        await flow.shot(page, 'finance-record-page')
        // finance's own reads: the sheet is listed locked and nameless, and answers 404 by every door (no name in the refusal).
        const listed = (await flow.read(page, `/files?recordType=Inquiry&recordId=${run.id}`)).files as Json[]
        expect(JSON.stringify(listed)).not.toContain(SHEET)
        expect(listed.find((file) => file.id === run.files.sheet)).toMatchObject({ locked: 'MEASUREMENTS', originalName: '' })
        expect(listed.find((file) => file.id === run.files.front)).toMatchObject({ originalName: PHOTO_FRONT })
        for (const path of [`/files/${run.files.sheet}`, `/files/${run.files.sheet}/download`, `/files/${run.files.sheet}/preview`]) {
          const answer = await page.request.get(`/api${path}`, { headers: { 'x-factory-company': COMPANY } })
          expect(answer.status(), `finance GET ${path}`).toBe(404)
          expect(await answer.text(), path).not.toContain(SHEET)
        }
      })

      await flow.step('T00: customer B sends its own request with a photo of its own; every page it visits holds nothing of customer A', async () => {
        const extra = [run.office, run.id, SUBJECT, PHOTO_FRONT, PHOTO_BACK, SHEET, LATE, ...Object.values(run.files).filter(Boolean)]
        const own = await sendRequest(beta, { subject: BETA_SUBJECT, message: `${BRAND_BETA.message}\nThree vests, a photo of the one we wear now.`, customerRef: BRAND_BETA.customerRef, files: [png(BETA_PHOTO, [30, 160, 30])] })
        await flow.settle()
        const { page } = beta
        await scanned(flow, page, BRAND_ALPHA, extra, 'beta receipt with a file')
        await beta.go('')
        await seen(page.getByRole('heading', { name: words('portal-customer-home')('title'), exact: true }), 60_000)
        await scanned(flow, page, BRAND_ALPHA, extra, 'beta home')
        await beta.go('/orders')
        await seen(page.getByText(BETA_SUBJECT).first(), 60_000)
        await scanned(flow, page, BRAND_ALPHA, extra, 'beta orders and requests')
        await beta.go(`/orders/requests/${own.id}`)
        await seen(page.getByRole('heading', { name: REQUEST('title', { seq: own.seq }) }), 60_000)
        // Its own file only, in its own conversation.
        await seen(page.getByText(BETA_PHOTO, { exact: true }), 60_000)
        await scanned(flow, page, BRAND_ALPHA, extra, 'beta own request with its file')
        // Customer A's request by its address: the neutral page, as for any id that is not theirs.
        await beta.go(`/orders/requests/${run.id}`)
        await seen(page.getByText(REQUEST('missing.title')).first(), 60_000)
        await seen(page.getByText(REQUEST('missing.body')).first())
        await scanned(flow, page, BRAND_ALPHA, extra, 'beta address of A request')
      })
    } finally {
      await flow.control('POST', '/scanner', { mode: 'process' }).catch(() => {})
    }
  },
})
