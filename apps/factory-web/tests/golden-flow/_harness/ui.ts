import { expect, test, type Locator, type Page } from '@playwright/test'
import { words } from './words' // op-fx11

/**
 * Small helpers for the design system's parts the stages meet on every screen (B-W1-06): the open dialog, the date
 * picker (a button and a calendar, no typed date), a held button (aria-disabled with its reason), today's dates in the
 * plant's zone, and a made-up one-page PDF for every upload.
 */

/** The dialog on top (a Modal is role=dialog, named by its title). */
export const dialog = (page: Page): Locator => page.getByRole('dialog').filter({ visible: true }).last()

/** Today in Europe/Rome as YYYY-MM-DD, `days` later. */
export function day(days = 0): string {
  const at = new Date(Date.now() + days * 86_400_000)
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']

/**
 * Picks `iso` (YYYY-MM-DD) in a DS DateField: opens it by its label, walks the calendar ("Previous month" / "Next
 * month") to the date's month, clicks the day (each day button is named by its long en-GB date).
 */
export async function pickDate(scope: Page | Locator, label: string | RegExp | Locator, iso: string): Promise<void> {
  const page = 'page' in scope ? scope.page() : scope
  const trigger =
    typeof label === 'string' || label instanceof RegExp
      ? scope.getByRole('button', { name: typeof label === 'string' ? new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`) : label }).first()
      : label
  await trigger.click()
  // os-fx5: a DateField given an aria label names its calendar by it (DS DateField: `aria-label={ariaLabel ?? words.pickDate}`).
  await chooseDate(page, iso, typeof label === 'string' ? label : undefined)
}

/**
 * Picks `iso` in the open calendar ("Pick a date", or — os-fx5 — the field's own aria label `named` when it has one): to its month,
 * then its day.
 */
export async function chooseDate(page: Page, iso: string, named?: string): Promise<void> {
  const generic = page.getByRole('dialog', { name: /Pick a date|date/i })
  const pop = (named ? page.getByRole('dialog', { name: named, exact: true }).or(generic) : generic).last()
  await pop.waitFor({ state: 'visible' })
  const [year, month, date] = iso.split('-').map(Number)
  const name = await page.evaluate(([y, m, d]) => new Date(y!, m! - 1, d!).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }), [year, month, date])
  const target = (year! * 12 + month! - 1) as number
  for (let turn = 0; turn < 80; turn++) {
    const button = pop.getByRole('button', { name: new RegExp(`^${name.replace(',', ',?')}$`) })
    if ((await button.count()) > 0) {
      await button.first().click()
      return
    }
    const header = (await pop.innerText()).toLowerCase()
    const shown = /([a-z]+) (\d{4})/.exec(header.split('\n').find((line) => MONTHS.some((m) => line.includes(m))) ?? '')
    const at = shown ? Number(shown[2]) * 12 + MONTHS.indexOf(shown[1]!) : target - 1
    await pop.getByRole('button', { name: at < target ? 'Next month' : 'Previous month' }).click()
  }
  throw new Error(`could not reach ${iso} in the date picker`)
}

/** A made-up one-page PDF that every viewer opens (the stores keep the bytes; nothing reads them as a document). */
export function pdf(title: string): { name: string; mimeType: string; buffer: Buffer } {
  const objects = ['%PDF-1.4', '1 0 obj <</Type /Catalog /Pages 2 0 R>> endobj', '2 0 obj <</Type /Pages /Kids [3 0 R] /Count 1>> endobj', '3 0 obj <</Type /Page /Parent 2 0 R /MediaBox [0 0 200 200]>> endobj', `% made-up document of the browser golden flow: ${title}`]
  let text = `${objects.join('\n')}\n`
  const xref = text.length
  text += `xref\n0 4\n0000000000 65535 f \ntrailer <</Size 4 /Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`
  return { name: `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.pdf`, mimeType: 'application/pdf', buffer: Buffer.from(text) }
}

/** Clicks a button once it is no longer held; a held one fails with the reason it gives (aria-description). */
export async function press(button: Locator, timeout = 30_000): Promise<void> {
  await button.waitFor({ state: 'visible', timeout })
  try {
    await expect(button).toBeEnabled({ timeout })
  } catch (error) {
    const reason = (await button.getAttribute('aria-description').catch(() => null)) ?? (await button.getAttribute('title').catch(() => null))
    throw new Error(`the button "${await button.innerText().catch(() => '?')}" stays held${reason ? `: ${reason}` : ''}`, { cause: error })
  }
  await button.click()
}

/**
 * Waits for the answer of the API call a screen action makes, and returns its JSON (the screen did the call). A 403 is
 * passed over: a write that needs a fresh step-up answers 403 first, the screen asks the code and sends it again.
 */
export async function answerOf(page: Page, method: string, path: RegExp, action: () => Promise<unknown>, status = /^2/): Promise<Record<string, any>> {
  const matches = (entry: import('@playwright/test').Response) => entry.request().method() === method && path.test(new URL(entry.url()).pathname.replace(/^\/api/, '')) && entry.status() !== 403
  const [response] = await Promise.all([page.waitForResponse(matches, { timeout: 60_000 }), action()])
  const body = await response.json().catch(() => ({}))
  expect(String(response.status()), `${method} ${response.url()}: ${JSON.stringify(body).slice(0, 400)}`).toMatch(status)
  return body as Record<string, any>
}

/**
 * Opens a DS Menu by its trigger and picks an item. A grid that draws its rows again (a save, a live update) closes a menu
 * opened on one of its rows, so the menu is opened again until the item is picked.
 */
export async function chooseFromMenu(trigger: Locator, item: Locator): Promise<void> {
  await expect(async () => {
    if (!(await item.isVisible())) await trigger.click()
    await item.click({ timeout: 3_000 })
  }).toPass({ timeout: 45_000 })
}

// ---- op-fx11 (F-OP-302, end check run 7's 07-order): a pill of the record band, read where a person reads it ----------------------------
const FRAME = words('record-frame')
const escapeText = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** The band's "+N", named "N more details: show the details" (one or several). */
const FOLD_NAME = new RegExp(`^(?:${[1, 2].map((count) => escapeText(FRAME('details.more', { count })).replace(String(count), '\\d+')).join('|')})$`)

/**
 * The record band (RecordFrame) folds the pills that do not fit its track behind "+N": a folded pill stays in the track only to be
 * measured again (hidden, inert, aria-hidden), and a text locator still finds it there. So the pill is read where it is drawn: in the
 * band when it fits, else in Details, which "+N" opens (the count must be there). Details is closed again; returns where it was read.
 */
export async function expectBandPill(page: Page, text: string | RegExp, timeout = 30_000): Promise<'band' | 'details'> {
  const band = page.locator('.fw-rcf-meta')
  const details = page.getByRole('dialog', { name: FRAME('details.title'), exact: true })
  let where = 'band' as 'band' | 'details' // set inside the retried read
  await expect(async () => {
    if (!(await details.isVisible())) {
      if ((await band.getByText(text).filter({ visible: true }).count()) > 0) {
        where = 'band'
        return
      }
      await band.getByRole('button', { name: FOLD_NAME }).first().click({ timeout: 2_000 })
    }
    await expect(details.getByText(text).first()).toBeVisible({ timeout: 2_000 })
    where = 'details'
  }).toPass({ timeout })
  if (where === 'details') {
    await page.keyboard.press('Escape')
    await expect(details).toHaveCount(0)
  }
  return where
}
// ---- end op-fx11

/** Marks a part of a stage the screens do not do yet (done through the API instead), in the report. */
export function byApi(what: string): void {
  test.info().annotations.push({ type: 'by API', description: what })
}

/**
 * fx-12 (the customer page that reloaded itself, 2026-11-19): what a page asks over `ms` after `action` (its arrival) — the main
 * frame's navigations, the documents it loads and the Next router's own requests (`rsc: 1`: navigations, prefetches, refreshes,
 * connectivity checks). A page at rest asks a handful; a loop asks hundreds.
 * op-fx4 (F-OP-218): `writes` = the navigations to another address than the one before (the page's own history writes). Next 16's
 * app router echoes each `history.replaceState` / `pushState` of a page with one of its own to the SAME address (its HistoryUpdater
 * stores the router's tree in the entry's state, node_modules/next/dist/client/components/app-router.js): one pick of the dock's
 * scope is one write and two navigations.
 */
export async function routerActivity(page: Page, ms: number, action: () => Promise<unknown>): Promise<{ navigations: number; writes: number; documents: number; router: number; mostOneAddress: number; lines: string[] }> {
  // fx-13: `mostOneAddress` = the most times ONE address (method + path + query) was asked by the router. A loop asks the same
  // address again and again; a production build (`next start`) prefetches each visible link once, so the total alone is no sign.
  const seen = { navigations: 0, writes: 0, documents: 0, router: 0, mostOneAddress: 0, lines: [] as string[] }
  const perAddress = new Map<string, number>()
  const started = Date.now()
  let address = page.mainFrame().url()
  const note = (what: string) => seen.lines.length < 40 && seen.lines.push(`${((Date.now() - started) / 1000).toFixed(2)} ${what}`)
  const onNavigated = (frame: import('@playwright/test').Frame) => {
    if (frame !== page.mainFrame()) return
    seen.navigations += 1
    const now = frame.url()
    if (now !== address) seen.writes += 1
    note(`navigated ${new URL(now).search}${now === address ? ' (same address)' : ''}`)
    address = now
  }
  const onRequest = (request: import('@playwright/test').Request) => {
    if (request.resourceType() === 'document') {
      seen.documents += 1
      note(`document ${new URL(request.url()).pathname}`)
    } else if (request.headers()['rsc'] === '1') {
      seen.router += 1
      const url = new URL(request.url())
      const search = url.search.replace(/[&?]_rsc=[^&]*/, '')
      const key = `${request.method()} ${url.pathname}${search}`
      const count = (perAddress.get(key) ?? 0) + 1
      perAddress.set(key, count)
      seen.mostOneAddress = Math.max(seen.mostOneAddress, count)
      note(`router ${request.method()} ${url.pathname}${search}`)
    }
  }
  page.on('framenavigated', onNavigated)
  page.on('request', onRequest)
  try {
    await action()
    await page.waitForTimeout(Math.max(0, ms - (Date.now() - started)))
  } finally {
    page.off('framenavigated', onNavigated)
    page.off('request', onRequest)
  }
  return seen
}

// ---- tw- T.3 (W2.3, 10-design §10): the composer's audience chip — ONE menu of radio rows ("Office note · Reply to X by email · In X's
// portal"); its name says the audience in use ("Who reads what you write: Office note"). Rows are matched with the party left open.
const COMPOSER = words('record-thread-composer')
export const audienceChip = (scope: Page | Locator): Locator => scope.getByRole('button', { name: new RegExp(`^${escapeText(COMPOSER('modeLabel'))}: `) })
/**
 * A row of the chip's menu: `note`, `reply` (by email) or `portal`, whatever the party's name. tw- fx1 (end check 1, th5): the DS
 * draws the row in use with a "✓" before its words (`[aria-checked='true']::before`, part of its accessible name) — the row may
 * start with it.
 */
const TICK = '(?:✓\\s*)?'
export const audienceRow = (way: 'note' | 'reply' | 'portal'): RegExp =>
  way === 'note' ? new RegExp(`^${TICK}${escapeText(COMPOSER('mode.note'))}$`) : new RegExp(`^${TICK}${escapeText(COMPOSER(way === 'reply' ? 'modeMenu.reply' : 'modeMenu.portal', { party: '@@' })).replace('@@', '.+')}$`)
export async function chooseAudience(page: Page, scope: Page | Locator, way: 'note' | 'reply' | 'portal'): Promise<void> {
  await chooseFromMenu(audienceChip(scope).first(), page.getByRole('menuitemcheckbox', { name: audienceRow(way) }))
  await expect(audienceChip(scope).first()).toHaveAttribute('aria-label', way === 'note' ? `${COMPOSER('modeLabel')}: ${COMPOSER('mode.note')}` : new RegExp(`^${escapeText(COMPOSER('modeLabel'))}: `))
}
// ---- end tw- T.3
