/** Production-only typing proof. No pause is inserted between the start key, later keys, or Enter. */
import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { decodeSheetCells } from '@nexus/shared/sheet-cell-wire'

interface Seed { workspace: string; families: { AMAZON: { family: string; name: string; connection: string; variations: number } } }
interface Sheet { rows: Array<{ id: string; isParent: boolean; values: Record<string, { value: unknown; writable?: boolean }> }> }
const seedFile = process.env.E2E_FAST_SEED
const seed: Seed | null = seedFile ? JSON.parse(readFileSync(seedFile, 'utf8')) : null
const auth = process.env.E2E_AUTH_STATE
const base = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3026'
const local = (url: string) => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)

async function focus(page: Page, id: string) {
  await expect(page.locator('.ag-row .ag-cell').first()).toBeVisible({ timeout: 90_000 })
  const at = await page.evaluate(id => {
    interface Grid { forEachNode(fn: (row: { rowIndex: number; data?: { id: string } }) => void): void; setColumnsVisible(keys: string[], show: boolean): void; ensureIndexVisible(index: number, at: string): void; ensureColumnVisible(key: string, at: string): void; setFocusedCell(index: number, key: string): void }
    interface Fiber { memoizedProps?: { api?: Grid }; return?: Fiber }
    for (const element of document.querySelectorAll('.ag-cell, .ag-cell *')) {
      const key = Object.keys(element).find(key => key.startsWith('__reactFiber$'))
      for (let fiber = key ? (element as unknown as Record<string, Fiber>)[key] : undefined; fiber; fiber = fiber.return) {
        const api = fiber.memoizedProps?.api
        if (!api?.forEachNode) continue
        let index = -1
        api.forEachNode(row => { if (row.data?.id === id) index = row.rowIndex })
        if (index < 0) continue
        api.setColumnsVisible(['color'], true)
        api.ensureIndexVisible(index, 'middle')
        api.ensureColumnVisible('color', 'middle')
        api.setFocusedCell(index, 'color')
        return index
      }
    }
    throw new Error('typing fixture row not found')
  }, id)
  const cell = page.locator(`.ag-row[row-index="${at}"] .ag-cell[col-id="color"]`)
  await expect(cell).toBeVisible()
  await cell.focus()
  return cell
}

async function open(page: Page) {
  if (!local(base) || !seed!.workspace.startsWith('e2e_fast_')) throw new Error('use this lane\'s private local typing fixture')
  await page.route('**/*', route => local(route.request().url()) ? route.continue() : route.abort())
  const family = seed!.families.AMAZON
  const first = page.waitForResponse(response => response.request().method() === 'GET' && response.url().includes(`/products/${family.family}/studio/sheet?`), { timeout: 90_000 })
  await page.goto(`/w/${seed!.workspace}/products/${family.family}/edit/studio?scope=AMAZON&market=IT&account=${family.connection}&locale=it&tab=sheet`, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  const response = await first
  expect(response.status()).toBe(200)
  const sheet = decodeSheetCells(await response.json()) as Sheet
  expect(sheet.rows).toHaveLength(151)
  await expect(page.getByText(family.name).first()).toBeVisible({ timeout: 90_000 })
  const row = sheet.rows.filter(row => !row.isParent).at(-1)!
  expect(row.values.color.writable).toBe(true)
  await focus(page, row.id)
  const read = async (): Promise<Sheet> => {
    const url = new URL(response.url())
    const next = await page.request.get(url.pathname + url.search, { headers: { 'x-nexus-workspace-id': seed!.workspace } })
    expect(next.status()).toBe(200)
    return decodeSheetCells(await next.json()) as Sheet
  }
  return { row, read }
}

test.describe('production type-to-start', () => {
  test.skip(!seed || !auth, 'Needs E2E_FAST_SEED and E2E_AUTH_STATE for a 151-row synthetic local fixture.')
  test.use({ storageState: auth, viewport: { width: 1680, height: 1000 } })
  test.setTimeout(120_000)

  test('uses the requested React bundle and mode', async ({ page }, info) => {
    await page.addInitScript(`window.__typingBundles=[]; window.__REACT_DEVTOOLS_GLOBAL_HOOK__={ supportsFiber:true, renderers:new Map(), inject(r){window.__typingBundles.push(r.bundleType);return window.__typingBundles.length}, checkDCE(){}, onCommitFiberRoot(){}, onCommitFiberUnmount(){}, onPostCommitFiberRoot(){} }`)
    await open(page)
    const bundles = await page.evaluate('window.__typingBundles') as number[]
    await info.attach('react-builds', { body: JSON.stringify(bundles), contentType: 'application/json' })
    expect(bundles.length).toBeGreaterThan(0)
    const development = process.env.E2E_TYPING_MODE === 'development'
    if (development) expect(bundles).toContain(1)
    else expect(bundles.every(bundle => bundle === 0)).toBe(true)
    if (development) expect(await page.evaluate(() => {
      interface Fiber { type?: unknown; return?: Fiber }
      for (const element of document.querySelectorAll('.ag-cell, .ag-cell *')) {
        const key = Object.keys(element).find(key => key.startsWith('__reactFiber$'))
        for (let fiber = key ? (element as unknown as Record<string, Fiber>)[key] : undefined; fiber; fiber = fiber.return) {
          if (fiber.type === Symbol.for('react.strict_mode')) return true
        }
      }
      return false
    })).toBe(true)
  })

  for (const theme of ['light', 'dark'] as const) for (const width of [1680, 390]) for (const delay of [0, 5, 15]) test(`${theme} ${width}px keeps every character in order at ${delay} ms`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 1000 })
    await page.emulateMedia({ colorScheme: theme })
    await page.addInitScript(theme => localStorage.setItem('nexus:theme', theme), theme)
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error' || message.type() === 'warning') errors.push(message.text()) })
    if (process.env.E2E_TYPING_TRACE === '1') await page.addInitScript(() => {
      const trace: unknown[] = []
      Object.assign(window, { __typingTrace: trace })
      for (const type of ['keydown', 'keyup', 'beforeinput', 'input', 'focusin', 'selectionchange']) document.addEventListener(type, event => {
        const target = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement ? event.target : null
        const active = document.activeElement
        trace.push({ type, at: performance.now(), key: event instanceof KeyboardEvent ? event.key : null,
          data: event instanceof InputEvent ? event.data : null, target: event.target instanceof Element ? event.target.tagName : null,
          active: active?.tagName, popup: active instanceof Element && !!active.closest('.ag-popup-editor'),
          value: target?.value, caret: target?.selectionStart, composing: event instanceof KeyboardEvent ? event.isComposing : false })
      }, true)
    })
    const { row, read } = await open(page)
    await expect.poll(() => page.locator('html').evaluate(element => element.classList.contains('dark'))).toBe(theme === 'dark')
    const saves: unknown[] = []
    page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/products/bulk-save')) saves.push(request.postDataJSON()) })
    const value = `E2E fast color ${Date.now()}`
    const save = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/products/bulk-save'), { timeout: 15_000 }).catch(error => ({ error: String(error) }))
    await page.keyboard.type(value, { delay })
    await page.keyboard.press('Enter')
    const response = await save
    if (process.env.E2E_TYPING_TRACE === '1') await info.attach('typing-events', { body: JSON.stringify(await page.evaluate('window.__typingTrace'), null, 2), contentType: 'application/json' })
    await info.attach('after-typing', { body: JSON.stringify({ wanted: value,
      inputs: await page.locator('.ag-popup-editor input, .ag-popup-editor textarea').evaluateAll(elements => elements.map(element => ({ value: (element as HTMLInputElement).value, focused: element === document.activeElement }))),
      dialogs: await page.getByRole('dialog').allTextContents(),
    }, null, 2), contentType: 'application/json' })
    if ('error' in response) throw new Error(response.error)
    expect(response.status()).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({ saved: 1, failed: 0 })
    expect(body.units).toHaveLength(1)
    expect(body.units[0].status).toBe(200)
    expect(body.units[0].body.errors ?? []).toEqual([])
    const wire = response.request().postDataJSON()
    const stored = (await read()).rows.find(current => current.id === row.id)!.values.color.value
    await info.attach('typing-result', { body: JSON.stringify({ wanted: value, wire: wire.units[0].changes[0].value, stored }, null, 2), contentType: 'application/json' })
    expect(wire.units[0].changes[0].value).toBe(value)
    expect(stored).toBe(value)
    await page.reload({ waitUntil: 'domcontentloaded' })
    const cell = await focus(page, row.id)
    await expect(cell).toContainText(value)
    expect(saves).toHaveLength(1)
    if (delay === 0) {
      // Opening by keyboard, cancelling, and Tab still belong to their usual editor paths.
      await page.keyboard.press('F2')
      const input = page.locator('.ag-popup-editor input').first()
      await expect(input).toHaveValue(value)
      await expect(input).toBeFocused()
      const screenshot = info.outputPath(`${theme}-${width}-editor.png`)
      await page.screenshot({ path: screenshot })
      await info.attach('editor', { path: screenshot, contentType: 'image/png' })
      await page.keyboard.type('Cancelled', { delay: 0 })
      await page.keyboard.press('Escape')
      await expect(input).toHaveCount(0)
      expect((await read()).rows.find(current => current.id === row.id)!.values.color.value).toBe(value)
      await cell.focus()
      await page.keyboard.press('Tab')
      await expect(cell).not.toBeFocused()
      expect(saves).toHaveLength(1)
      for (const [index, commit] of ['Tab', 'outside'].entries()) {
        await focus(page, row.id)
        const nextValue = `E2E ${commit} color ${Date.now()}`
        const nextSave = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/products/bulk-save'))
        await page.keyboard.type(nextValue, { delay: 0 })
        if (commit === 'Tab') await page.keyboard.press('Tab')
        else await page.getByText(seed!.families.AMAZON.name).first().click()
        const saved = await nextSave
        expect(saved.status()).toBe(200)
        const result = await saved.json()
        expect(result).toMatchObject({ saved: 1, failed: 0 })
        expect(result.units).toHaveLength(1)
        expect(result.units[0].status).toBe(200)
        expect(result.units[0].body.errors ?? []).toEqual([])
        expect(saved.request().postDataJSON().units[0].changes[0].value).toBe(nextValue)
        // Tab may open the untouched next cell; Escape leaves that value alone.
        if (commit === 'Tab') await page.keyboard.press('Escape')
        expect((await read()).rows.find(current => current.id === row.id)!.values.color.value).toBe(nextValue)
        expect(saves).toHaveLength(index + 2)
      }
    }
    expect(errors).toEqual([])
  })
})
