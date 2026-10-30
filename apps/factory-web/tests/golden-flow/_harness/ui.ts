import { expect, test, type Locator, type Page } from '@playwright/test'

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
  await chooseDate(page, iso)
}

/** Picks `iso` in the open calendar ("Pick a date"): to its month, then its day. */
export async function chooseDate(page: Page, iso: string): Promise<void> {
  const pop = page.getByRole('dialog', { name: /Pick a date|date/i }).last()
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

/** Marks a part of a stage the screens do not do yet (done through the API instead), in the report. */
export function byApi(what: string): void {
  test.info().annotations.push({ type: 'by API', description: what })
}
