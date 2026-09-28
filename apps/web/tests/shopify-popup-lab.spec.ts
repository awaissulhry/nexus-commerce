/**
 * The Shopify cell pop-up on the lab (/design/shopify-popup) — Lane B slice B1, docs/shopify-metafields/PLAN-2026-09-28.md
 * §7 L7: the store types by keyboard only, the refusal sentence, Esc and open+close write nothing, focus stays in the
 * pop-up and comes back to its row, Ctrl/⌘+Enter in a multi-line box, the rating stepper, a new entry through the real
 * entry editor, and the phone sheet in dark mode. Every test fails on a console error or an uncaught page error.
 *
 * The lab needs no store and no API: its made-up store answers the pop-up's calls in the page. The app shell around it
 * reads `/api/auth/me` and `/api/notifications`; a browser that is not logged in gets 401 for those two, which Chrome logs
 * as resource errors. Those two — and only those two — are not the pop-up's errors and are ignored.
 *
 *   cd apps/web && PLAYWRIGHT_BASE_URL=http://127.0.0.1:3110 npx playwright test shopify-popup-lab
 */
import { expect, test, type Page } from '@playwright/test'

const SHELL_401 = /Failed to load resource: the server responded with a status of 401/
let problems: string[] = []
let shellUnauthorized = 0

test.beforeEach(async ({ page }) => {
  problems = []; shellUnauthorized = 0
  page.on('response', r => { if (r.status() === 401 && /\/api\/(auth\/me|notifications)(\?|$)/.test(new URL(r.url()).pathname + '?')) shellUnauthorized++ })
  page.on('console', m => { if (m.type() === 'error' && !(SHELL_401.test(m.text()) && shellUnauthorized > 0)) problems.push(m.text()) })
  page.on('pageerror', e => problems.push(String(e)))
  await page.goto('/design/shopify-popup')
  await expect(page.getByRole('heading', { name: 'Shopify pop-up lab' })).toBeVisible()
})
test.afterEach(() => { expect(problems, problems.join('\n')).toEqual([]) })

const row = (page: Page, name: string) => page.getByRole('button', { name, exact: true })
const popup = (page: Page, name: string) => page.getByRole('dialog', { name: `${name}: SAMPLE-100` })
async function openByKeyboard(page: Page, name: string) {
  await row(page, name).focus()
  await page.keyboard.press('Enter')
  await expect(popup(page, name)).toBeVisible()
  await expect.poll(() => popup(page, name).evaluate(d => d.contains(document.activeElement))).toBe(true)
}
const cellOf = (page: Page, name: string) => page.locator('.nds-prow').filter({ has: row(page, name) }).locator('.nds-prow-body')

const STORE_ROWS = ['Average rating', 'Rating count', 'Feed: custom product', 'Colour (category)', 'Swatch app settings', 'Icons with text', 'Short summary',
  'Search words', 'Related items', 'Related items display', 'Size guide page', 'Swatch picture', 'Swatch colour', 'Sort position']

test('every store-type row opens by keyboard with focus inside; Esc writes nothing and hands focus back', async ({ page }) => {
  test.setTimeout(120_000)
  for (const name of STORE_ROWS) {
    const before = await cellOf(page, name).textContent()
    await openByKeyboard(page, name)
    await page.keyboard.press('Escape')
    await expect(popup(page, name)).toHaveCount(0)
    await expect(cellOf(page, name)).toHaveText(before ?? '')
    await expect(row(page, name)).toBeFocused()
  }
})

test('a refused value keeps the pop-up open with one plain sentence; a good one saves on Enter', async ({ page }) => {
  await openByKeyboard(page, 'Rating count')
  await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.type('-1'); await page.keyboard.press('Enter')
  await expect(popup(page, 'Rating count').getByText('Not saved: Enter 0 or more.')).toBeVisible()
  await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.type('7'); await page.keyboard.press('Enter')
  await expect(popup(page, 'Rating count')).toHaveCount(0)
  await expect(page.getByText('Rating count saved in the lab.')).toBeVisible()
  await expect(cellOf(page, 'Rating count')).toContainText('7')
})

test('a click outside saves a good value and is held back while the value is refused', async ({ page }) => {
  await openByKeyboard(page, 'Swatch colour')
  const hex = popup(page, 'Swatch colour').getByLabel('Swatch colour hex')
  await hex.fill('#12345')
  await page.getByRole('heading', { name: 'Shopify pop-up lab' }).click()
  await expect(popup(page, 'Swatch colour').getByText('Not saved: Enter a colour as # and six characters, for example #1A2B3C.')).toBeVisible()
  await hex.fill('#1a2b3c')
  await page.getByRole('heading', { name: 'Shopify pop-up lab' }).click()
  await expect(popup(page, 'Swatch colour')).toHaveCount(0)
  await expect(cellOf(page, 'Swatch colour')).toContainText('#1a2b3c')
})

test('the rating editor shows the store’s scale as a fact and steps inside it', async ({ page }) => {
  await openByKeyboard(page, 'Average rating')
  const p = popup(page, 'Average rating')
  await expect(p.getByText('Scale 1 to 5, set by the store.')).toBeVisible()
  await expect(p.getByLabel('Scale minimum')).toHaveCount(0)
  await p.getByRole('button', { name: 'Raise Average rating' }).click()
  await expect(p.getByRole('button', { name: 'Raise Average rating' })).toBeDisabled()
  await page.keyboard.press('Enter')
  await expect(cellOf(page, 'Average rating')).toContainText('5 / 5')
})

test('yes/no uses the cell’s words', async ({ page }) => {
  await openByKeyboard(page, 'Feed: custom product')
  const options = await popup(page, 'Feed: custom product').locator('option').allTextContents()
  expect(options).toEqual(['Not set', 'Yes', 'No'])
})

test('in a multi-line box Enter adds a line and Ctrl/⌘+Enter saves', async ({ page }) => {
  await page.getByRole('tab', { name: /Every Shopify type/ }).click()
  await openByKeyboard(page, 'Multi line text')
  const p = popup(page, 'Multi line text')
  await expect(p.getByText('Enter adds a line · Ctrl+Enter (⌘+Enter on a Mac) saves')).toBeVisible()
  await p.getByRole('textbox').press('End'); await page.keyboard.press('Enter'); await page.keyboard.type('Third line')
  await expect(p).toBeVisible()
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect(p).toHaveCount(0)
  await expect(page.getByText('Multi line text saved in the lab.')).toBeVisible()
})

test('a new entry made through "Add new entry" is picked into the field and saved', async ({ page }) => {
  test.setTimeout(60_000)
  await openByKeyboard(page, 'Icons with text')
  await popup(page, 'Icons with text').getByRole('button', { name: 'Add new entry' }).click()
  const editor = page.getByRole('dialog', { name: 'New Icon with text' })
  await editor.getByRole('textbox', { name: 'Heading' }).fill('Breathable')
  await editor.getByRole('button', { name: 'Review entry changes' }).click()
  await page.getByRole('dialog', { name: 'Save reusable entry to Shopify?' }).getByRole('button', { name: 'Save to Shopify' }).click()
  await expect(editor).toHaveCount(0)
  /* B2: the new entry is picked (a chip) AND now shows ticked in the list below, which is read again after the save. */
  await expect(popup(page, 'Icons with text').locator('.nds-mchip-label', { hasText: 'Breathable' })).toBeVisible()
  await expect(popup(page, 'Icons with text').getByRole('option', { name: /Breathable/ })).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Enter')
  await expect(page.locator('.nds-prow').filter({ has: row(page, 'Icons with text') }).locator('[aria-label*="Breathable"]')).toHaveCount(1)
})

test('on a phone in dark mode the pop-up is a full-width sheet and the page never scrolls sideways', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ colorScheme: 'dark' })
  await openByKeyboard(page, 'Search words')
  const box = (await popup(page, 'Search words').boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(8); expect(box.x + box.width).toBeLessThanOrEqual(390 - 8); expect(box.width).toBeGreaterThan(340)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await page.keyboard.press('Escape')
  await expect(row(page, 'Search words')).toBeFocused()
})

/* ── Slice B2: entries (docs/shopify-metafields/PLAN-2026-09-28.md §6.2). ── */

test('a new category Color entry: plain rules only after the first try, taxonomy values from Shopify’s list, a readable handle', async ({ page }) => {
  test.setTimeout(90_000)
  await openByKeyboard(page, 'Colour (category)')
  await popup(page, 'Colour (category)').getByRole('button', { name: 'Add new entry' }).click()
  const editor = page.getByRole('dialog', { name: 'New Color' })
  await expect(editor.getByText('Saves to Shopify now — for every product that uses this entry. To delete an entry, use Shopify admin.')).toBeVisible()
  await expect(editor.getByText('Enter a value. Shopify needs this field.')).toHaveCount(0)
  await editor.getByRole('button', { name: 'Review entry changes' }).click()
  await expect(editor.getByText('Fix the 3 fields marked below, then save.')).toBeVisible()
  await expect(editor.getByText('Enter a value. Shopify needs this field.')).toHaveCount(3)
  await editor.getByRole('textbox', { name: 'Label' }).fill('Teal Green')
  await expect(editor.getByRole('textbox', { name: 'Entry handle' })).toHaveValue(/^teal-green-[a-z0-9]{4}$/)
  const baseColor = editor.getByRole('region', { name: 'Base color' })
  await baseColor.getByRole('option', { name: /Blue/ }).click()
  await baseColor.getByRole('option', { name: /Green/ }).click()
  await expect(baseColor.getByRole('option', { name: /Solid/ })).toHaveCount(0)
  const basePattern = editor.getByRole('region', { name: 'Base pattern' })
  await basePattern.getByRole('option', { name: /Solid/ }).click()
  /* A taxonomy value is Shopify's own data, not an entry: nothing offers to edit or copy it (B2 review). */
  await expect(baseColor.getByRole('button', { name: /Edit entry|Make a separate copy/ })).toHaveCount(0)
  await expect(basePattern.getByRole('button', { name: /Edit entry|Make a separate copy/ })).toHaveCount(0)
  await editor.getByRole('button', { name: 'Review entry changes' }).click()
  await page.getByRole('dialog', { name: 'Save reusable entry to Shopify?' }).getByRole('button', { name: 'Save to Shopify' }).click()
  await expect(editor).toHaveCount(0)
  const cellPopup = popup(page, 'Colour (category)')
  await expect(cellPopup.getByRole('option', { name: /Teal Green/ })).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(page.locator('.nds-prow').filter({ has: row(page, 'Colour (category)') }).locator('[aria-label*="Teal Green"]')).toHaveCount(1)
})

test('a new entry can be added from a field inside an entry, and lands in that field', async ({ page }) => {
  test.setTimeout(90_000)
  await page.getByRole('tab', { name: /Entry kinds/ }).click()
  await page.getByRole('button', { name: 'Highlights', exact: true }).click()
  await page.getByRole('group', { name: 'Highlights entries' }).getByRole('button', { name: 'Highlights 1', exact: true }).click()
  const outer = page.getByRole('dialog', { name: 'Highlights 1' })
  const related = outer.getByRole('region', { name: 'Related icon' })
  await related.getByRole('button', { name: 'Add new entry' }).click()
  const inner = page.getByRole('dialog', { name: 'New Icon with text' })
  await inner.getByRole('textbox', { name: 'Heading' }).fill('Night reflective')
  await inner.getByRole('button', { name: 'Review entry changes' }).click()
  await page.getByRole('dialog', { name: 'Save reusable entry to Shopify?' }).getByRole('button', { name: 'Save to Shopify' }).click()
  await expect(inner).toHaveCount(0)
  await expect(outer).toBeVisible()
  await expect(related.getByRole('option', { name: /Night reflective/ })).toHaveAttribute('aria-selected', 'true')
})

test('a read-only field is shown with its reason and does not block the rest of the entry', async ({ page }) => {
  test.setTimeout(60_000)
  await page.getByRole('tab', { name: /Entry kinds/ }).click()
  await page.getByRole('button', { name: 'Knowledge facts', exact: true }).click()
  await page.getByRole('group', { name: 'Knowledge facts entries' }).getByRole('button', { name: 'Knowledge facts 1', exact: true }).click()
  const editor = page.getByRole('dialog', { name: 'Knowledge facts 1' })
  const externalId = editor.getByRole('region', { name: 'External ID' })
  await expect(externalId.getByText('An app owns this field. Change it in that app.')).toBeVisible()
  await expect(externalId.getByRole('textbox')).toBeDisabled()
  await editor.getByRole('textbox', { name: 'Title' }).fill('Returns within 30 days')
  await editor.getByRole('button', { name: 'Review entry changes' }).click()
  await page.getByRole('dialog', { name: 'Save reusable entry to Shopify?' }).getByRole('button', { name: 'Save to Shopify' }).click()
  /* After the save the editor is titled by the entry's new name. */
  await expect(page.getByRole('dialog', { name: 'Returns within 30 days' }).getByText('Entry saved and verified in Shopify.')).toBeVisible()
})

/* ── Slice B3a: the 32 measurement kinds (docs/shopify-metafields/PLAN-2026-09-28.md §6.3, G13 and G14). ── */

test.describe('B3a · measurements', () => {
  const typesTab = (page: Page) => page.getByRole('tab', { name: /Every Shopify type/ }).click()
  const wholeRow = (page: Page, name: string) => page.locator('.nds-prow').filter({ has: row(page, name) })
  /* The drawn value alone (MetafieldValue's text), not the row's type code and rule line beside it. */
  const shown = (page: Page, name: string) => cellOf(page, name).locator('.nds-mf-text')
  async function enter(page: Page, name: string, value: string) {
    await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.type(value); await page.keyboard.press('Enter')
    await expect(popup(page, name)).toBeVisible()
  }

  test('every newer kind shows its value in words in the cell, and the lab lists no G13 or G14 gap', async ({ page }) => {
    await typesTab(page)
    for (const [name, text] of [['Temperature', '2.5 celsius'], ['Speed', '2.5 kilometers per hour'], ['Data storage capacity', '64 megabytes'],
      ['Duration', '45 minutes'], ['Thermal power', '2.5 british thermal units per hour'], ['Weight', '1.2 kilograms']] as const) {
      await expect(shown(page, name)).toHaveText(text)
    }
    await expect(cellOf(page, 'List of duration')).toContainText('45 minutes')
    await expect(cellOf(page, 'List of duration')).toContainText('46 minutes')
    await expect(page.locator('.nds-prow-body', { hasText: '"unit"' })).toHaveCount(0)
    for (const name of ['Temperature', 'List of temperature', 'Speed', 'Antenna gain']) await expect(wholeRow(page, name)).not.toContainText(/G1[34] ·/)
  })

  test('a limit in another unit refuses with the exact sentence; a value inside saves — keyboard only', async ({ page }) => {
    await typesTab(page)
    await openByKeyboard(page, 'Temperature')
    const p = popup(page, 'Temperature')
    await expect(p.getByText('14 fahrenheit to 323.15 kelvin', { exact: true })).toBeVisible()
    await enter(page, 'Temperature', '-10.5')
    await expect(p.getByText('Not saved: Enter 14 fahrenheit or more.', { exact: true })).toBeVisible()
    await enter(page, 'Temperature', '50.5')
    await expect(p.getByText('Not saved: Enter 323.15 kelvin or less.', { exact: true })).toBeVisible()
    await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.type('-10'); await page.keyboard.press('Enter')
    await expect(p).toHaveCount(0)
    await expect(page.getByText('Temperature saved in the lab.')).toBeVisible()
    await expect(shown(page, 'Temperature')).toHaveText('-10 celsius')
    await expect(row(page, 'Temperature')).toBeFocused()

    await openByKeyboard(page, 'Speed')
    await enter(page, 'Speed', '50')
    await expect(popup(page, 'Speed').getByText('Not saved: Enter 30 miles per hour or less.', { exact: true })).toBeVisible()
    await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.type('48'); await page.keyboard.press('Enter')
    await expect(popup(page, 'Speed')).toHaveCount(0)
    await expect(shown(page, 'Speed')).toHaveText('48 kilometers per hour')
  })

  test('a value inside the limit under one reading of the unit is left to Shopify; one outside under every reading is refused', async ({ page }) => {
    await typesTab(page)
    await openByKeyboard(page, 'Data storage capacity')
    const p = popup(page, 'Data storage capacity')
    await expect(p.getByText('4 kilobytes to 2 gigabytes', { exact: true })).toBeVisible()
    await enter(page, 'Data storage capacity', '2049')
    await expect(p.getByText('Not saved: Enter 2 gigabytes or less.', { exact: true })).toBeVisible()
    /* 2,040 MB is over 2 GB of 1,000 MB but under 2 GB of 1,024 MB: Shopify does not say which, so Nexus does not refuse. */
    await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.type('2040'); await page.keyboard.press('Enter')
    await expect(p).toHaveCount(0)
    await expect(shown(page, 'Data storage capacity')).toHaveText('2040 megabytes')
  })
})

/* ── Slice B3c: mixed and disclosure references on the tick list (docs/shopify-metafields/PLAN-2026-09-28.md §6.3, G18). ── */

test.describe('B3c · mixed and disclosure references', () => {
  test.beforeEach(async ({ page }) => { await page.getByRole('tab', { name: /Every Shopify type/ }).click() })
  const chip = (page: Page, name: string, label: string) => popup(page, name).locator('.nds-mchip', { has: page.locator('.nds-mchip-label', { hasText: label }) })
  /* A row's own name (a picked row also carries its "Edit entry" actions). */
  const rowNames = (list: ReturnType<Page['getByRole']>) => list.locator('.nds-mpick-label')

  test('a list of mixed, by keyboard only: an FAQ entry, then the kind switch, then a Press quote entry; Enter saves both', async ({ page }) => {
    test.setTimeout(60_000)
    const name = 'List of mixed reference'
    await expect(cellOf(page, name).getByText(/G18/)).toHaveCount(0)
    await openByKeyboard(page, name)
    const p = popup(page, name)
    await expect(p.getByRole('radiogroup', { name: 'Entry kind' }).getByRole('radio')).toHaveText(['FAQ', 'Press quote'])
    await expect(p.getByRole('radio', { name: 'FAQ' })).toHaveAttribute('aria-checked', 'true')
    await expect(p.getByText('Reusable entry type')).toHaveCount(0)
    /* The two starting entries go (Backspace in the empty search line), then "2" finds FAQ 2 and Enter ticks it. */
    await expect(chip(page, name, 'Press quote 1')).toHaveCount(1)
    await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace')
    await expect(p.locator('.nds-mchip')).toHaveCount(0)
    await page.keyboard.type('2')
    const faqList = p.getByRole('listbox', { name: 'FAQ entries' })
    await expect(rowNames(faqList)).toHaveText(['FAQ 2'])
    await page.keyboard.press('Enter')
    await expect(chip(page, name, 'FAQ 2')).toHaveCount(1)
    await expect(p).toBeVisible()
    /* Tab: the chip line's Clear, then the kind switch; → picks Press quote and the list follows it. */
    await page.keyboard.press('Tab'); await page.keyboard.press('Tab')
    await expect(p.getByRole('radio', { name: 'FAQ' })).toBeFocused()
    /* Every drawn frame is watched: the list named "Press quote entries" never shows an FAQ row, even while it loads. */
    await p.evaluate(d => {
      const w = window as unknown as { staleRows: boolean }; w.staleRows = false
      new MutationObserver(() => { if (/FAQ/.test(d.querySelector('[role="listbox"][aria-label="Press quote entries"]')?.textContent ?? '')) w.staleRows = true })
        .observe(d, { subtree: true, childList: true, characterData: true, attributes: true })
    })
    await page.keyboard.press('ArrowRight')
    await expect(p.getByRole('radio', { name: 'Press quote' })).toBeFocused()
    await expect(p.getByRole('radio', { name: 'Press quote' })).toHaveAttribute('aria-checked', 'true')
    const pressList = p.getByRole('listbox', { name: 'Press quote entries' })
    await expect(rowNames(pressList)).toHaveText(['Press quote 1', 'Press quote 2'])
    expect(await page.evaluate(() => (window as unknown as { staleRows: boolean }).staleRows)).toBe(false)
    await expect(p.getByRole('button', { name: 'Add new Press quote entry' })).toBeVisible()
    await page.keyboard.press('Tab')
    await expect(pressList).toBeFocused()
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('Space')
    await expect(pressList.getByRole('option', { name: /Press quote 1/ })).toHaveAttribute('aria-selected', 'true')
    /* Chips of both kinds, each with its own picture or none (FAQ entries have no picture: no empty slot). */
    await expect(chip(page, name, 'Press quote 1').locator('img')).toHaveCount(1)
    await expect(chip(page, name, 'FAQ 2').locator('img, .nds-media-mark')).toHaveCount(0)
    /* Each chip names its own kind (its tooltip), whatever kind the list shows now. */
    await expect(chip(page, name, 'FAQ 2')).toHaveAttribute('title', 'FAQ')
    await expect(chip(page, name, 'Press quote 1')).toHaveAttribute('title', 'Press quote')
    await page.keyboard.press('Enter')
    await expect(p).toHaveCount(0)
    await expect(page.getByText(`${name} saved in the lab.`)).toBeVisible()
    await expect(cellOf(page, name).locator('[aria-label="2 references: FAQ 2, Press quote 1"]')).toHaveCount(1)
    await expect(row(page, name)).toBeFocused()
  })

  test('one mixed entry, by keyboard only: Change, switch the kind, pick a Press quote; the card names its kind', async ({ page }) => {
    test.setTimeout(60_000)
    const name = 'Mixed reference'
    await openByKeyboard(page, name)
    const p = popup(page, name)
    await expect(p.locator('small', { hasText: 'FAQ' })).toBeVisible()
    await p.getByRole('button', { name: 'Change' }).focus(); await page.keyboard.press('Enter')
    await expect(p.getByRole('combobox', { name: 'Search FAQ' })).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await expect(p.getByRole('radio', { name: 'FAQ' })).toBeFocused()
    await page.keyboard.press('ArrowRight')
    await expect(p.getByRole('radio', { name: 'Press quote' })).toBeFocused()
    /* The card still names the chosen entry's own kind, not the kind the list now shows. */
    await expect(p.locator('small')).toHaveText('FAQ')
    await page.keyboard.press('Tab')
    await expect(p.getByRole('combobox', { name: 'Search Press quote' })).toBeFocused()
    await page.keyboard.type('2')
    await expect(rowNames(p.getByRole('listbox', { name: 'Press quote entries' }))).toHaveText(['Press quote 2'])
    await page.keyboard.press('Enter')
    await expect(p.getByRole('radiogroup')).toHaveCount(0)
    await expect(p.locator('small', { hasText: 'Press quote' })).toBeVisible()
    await expect.poll(() => p.evaluate(d => d.contains(document.activeElement))).toBe(true)
    await page.keyboard.press('Enter')
    await expect(p).toHaveCount(0)
    await expect(cellOf(page, name).locator('[aria-label="1 reference: Press quote 2"]')).toHaveCount(1)
    await expect(cellOf(page, name).locator('img')).toHaveCount(1)
  })

  test('"Add new entry" makes an entry of the chosen kind and picks it', async ({ page }) => {
    test.setTimeout(60_000)
    const name = 'List of mixed reference'
    await openByKeyboard(page, name)
    const p = popup(page, name)
    await p.getByRole('radio', { name: 'Press quote' }).click()
    await p.getByRole('button', { name: 'Add new Press quote entry' }).click()
    const editor = page.getByRole('dialog', { name: 'New Press quote' })
    await editor.getByRole('textbox', { name: 'Quote' }).fill('Dry after a day of rain')
    await editor.getByRole('button', { name: 'Review entry changes' }).click()
    await page.getByRole('dialog', { name: 'Save reusable entry to Shopify?' }).getByRole('button', { name: 'Save to Shopify' }).click()
    await expect(editor).toHaveCount(0)
    await expect(chip(page, name, 'Dry after a day of rain')).toHaveCount(1)
    await expect(p.getByRole('listbox', { name: 'Press quote entries' }).getByRole('option', { name: /Dry after a day of rain/ })).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('ControlOrMeta+Enter')
    await expect(cellOf(page, name).locator('[aria-label="3 references: FAQ 1, Press quote 1, Dry after a day of rain"]')).toHaveCount(1)
  })

  test('a kind whose list cannot be read says so — never a spinner for ever, never the other kind’s rows', async ({ page }) => {
    const name = 'List of mixed reference'
    /* The store fails for Press quote entries only (a wrapper over the lab's own stand-in, in the page). */
    await page.evaluate(() => {
      const before = window.fetch
      window.fetch = (input, init) => /metaobjectType=lab_press/.test(String(input instanceof Request ? input.url : input))
        ? Promise.resolve(new Response(JSON.stringify({ error: 'Shopify could not be reached. Try again.' }), { status: 502, headers: { 'Content-Type': 'application/json' } }))
        : before(input, init)
    })
    await openByKeyboard(page, name)
    const p = popup(page, name)
    await expect(rowNames(p.getByRole('listbox', { name: 'FAQ entries' }))).toHaveText(['FAQ 1', 'FAQ 2'])
    await p.getByRole('radio', { name: 'Press quote' }).click()
    const pressList = p.getByRole('listbox', { name: 'Press quote entries' })
    await expect(pressList.getByRole('alert')).toHaveText('Shopify could not be reached. Try again.')
    await expect(pressList.getByText('Loading…')).toHaveCount(0)
    await expect(rowNames(pressList)).toHaveCount(0)
    await p.getByRole('radio', { name: 'FAQ' }).click()
    await expect(rowNames(p.getByRole('listbox', { name: 'FAQ entries' }))).toHaveText(['FAQ 1', 'FAQ 2'])
  })

  test('a disclosure field: one kind, so no switch; its own entries; Backspace removes one and Enter saves', async ({ page }) => {
    const name = 'List of disclosure reference'
    await openByKeyboard(page, name)
    const p = popup(page, name)
    await expect(p.getByRole('radiogroup')).toHaveCount(0)
    await expect(rowNames(p.getByRole('listbox', { name: 'Disclosure (made up) entries' }))).toHaveText(['Disclosure (made up) 1', 'Disclosure (made up) 2'])
    await expect(p.getByRole('button', { name: 'Add new entry' })).toBeVisible()
    await expect(p.getByText('Disclosure (made up) entries · Up to 5 entries', { exact: true })).toBeVisible()
    await page.keyboard.press('Backspace')
    await expect(p.locator('.nds-mchip')).toHaveCount(1)
    await page.keyboard.press('Enter')
    await expect(p).toHaveCount(0)
    await expect(cellOf(page, name).locator('[aria-label="1 reference: Disclosure (made up) 1"]')).toHaveCount(1)
  })

  test('on a phone in dark mode the kind switch fits the sheet and the page never scrolls sideways', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.emulateMedia({ colorScheme: 'dark' })
    const name = 'List of mixed reference'
    await openByKeyboard(page, name)
    const p = popup(page, name)
    const sheet = (await p.boundingBox())!, kinds = (await p.getByRole('radiogroup', { name: 'Entry kind' }).boundingBox())!
    expect(sheet.width).toBeGreaterThan(340)
    expect(kinds.x).toBeGreaterThanOrEqual(sheet.x); expect(kinds.x + kinds.width).toBeLessThanOrEqual(sheet.x + sheet.width)
    await expect(p.getByRole('listbox', { name: 'FAQ entries' }).getByRole('option')).toHaveCount(2)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
    /* Dark for real: the app's theme class is on, and the sheet is drawn dark (its background is a dark colour). */
    expect(await page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(true)
    const [r, g, b] = (await p.evaluate(d => getComputedStyle(d).backgroundColor)).match(/\d+(\.\d+)?/g)!.map(Number)
    expect(0.2126 * r + 0.7152 * g + 0.0722 * b).toBeLessThan(80)
    await page.keyboard.press('Escape')
    await expect(row(page, name)).toBeFocused()
  })
})
