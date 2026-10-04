/**
 * One DRIVER per cell editor the sheet can mount: how an operator commits a value into it by keyboard, by mouse and by
 * paste. `scripts/check-sheet-editor-coverage.mjs` reads `DRIVERS` (every editor needs all three arms, or a written reason),
 * `NETWORK_STUBS` and `KNOWN_DEFECTS` (neither may grow).
 *
 * Each arm starts on a focused cell with no editor open and ends when the operator would consider the value committed
 * (the popup closed). What reached the server, and what it stored, is the spec's business, not the driver's.
 */
import { expect, type Locator, type Page } from '@playwright/test'
import { elsewhereInRow, type ApiColumn, type ScopeName } from './grid'

export type EditorId =
  | 'FormulaCellEditor' | 'SelectPanelEditor' | 'ListPanelEditor' | 'MeasureEditor' | 'ReferenceSelectEditor'
  | 'ChannelCategoryEditor' | 'EbayPolicyEditor' | 'SlotListEditor' | 'StructuredAttributeEditor'
  | 'ImpactProtectorsEditor' | 'AxesPanelEditor' | 'Gateway' | 'MediaEditorGateway'
  | 'FormulaUnavailableEditor' | 'agLargeTextCellEditor' | 'agTextCellEditor' | 'agNumberCellEditor'
  | 'MatrixStockEditor'

export type Path = 'keyboard' | 'mouse' | 'paste'
export const PATHS: readonly Path[] = ['keyboard', 'mouse', 'paste']

/** What one arm commits: `input` is what the operator types, picks or pastes; `wire` is what must reach the server. */
export interface Pick {
  input: string
  wire: unknown
  /** What the read-back must hold, when the API normalises the wire value (a pasted name stored as its id). */
  stored?: unknown
  shows?: string
  custom?: boolean
  skip?: string
}
export interface ArmContext { page: Page; cell: Locator; column: ApiColumn; pick: Pick; scope: ScopeName }
export type Arm = ((ctx: ArmContext) => Promise<void>) | { na: string }
export interface Driver {
  /** The wire kinds / shapes this editor serves (guardrail 3 R3). */
  kinds: string[]
  keyboard: Arm
  mouse: Arm
  paste: Arm
  /** The whole editor is out of this sweep, and why. */
  abstain?: string
  /**
   * The API accepts this column's value only after asking the channel itself, which an offline stack cannot: the sweep
   * then asserts the exact write and the API's named refusal (the stored value kept), not a save.
   */
  refusedOffline?: { reason: string; answer: RegExp }
}

/**
 * Channel reads the sweep may answer itself because the real ones need the NETWORK (a live channel call, which the local
 * stack refuses). Nothing else is stubbed. Guardrail 3 (R5) holds this list's length.
 */
export const NETWORK_STUBS = [
  {
    // eBay business policies come from eBay itself (Sell Account API); made-up ones stand in.
    url: /\/api\/ebay\/policies(\?|$)/,
    body: {
      fulfillmentPolicies: [{ id: 'e2e_fp_1', name: 'E2E courier' }, { id: 'e2e_fp_2', name: 'E2E post' }, { id: 'e2e_fp_3', name: 'E2E pickup' }],
      returnPolicies: [{ id: 'e2e_rp_1', name: 'E2E 30 days' }, { id: 'e2e_rp_2', name: 'E2E 60 days' }, { id: 'e2e_rp_3', name: 'E2E none' }],
      paymentPolicies: [{ id: 'e2e_pp_1', name: 'E2E managed' }, { id: 'e2e_pp_2', name: 'E2E card' }, { id: 'e2e_pp_3', name: 'E2E transfer' }],
    },
  },
] as const

/** No failing commits are excused. The static gate prevents this list from growing. */
export const KNOWN_DEFECTS = [] as const

export const REFERENCE_KEYS = ['descriptionThemeId', 'merchant_shipping_group', 'shippingTemplate', 'shipping_profile_id', 'shop_section_id', 'return_policy_id', 'readiness_state_id']
const POLICY_KEYS = ['paymentPolicyId', 'returnPolicyId', 'fulfillmentPolicyId']
const CATEGORY_KEY: Record<string, string> = { EBAY: 'categoryId', AMAZON: 'productType', ETSY: 'taxonomy_id' }
const BOOLEAN = [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }]
/** The stock Mode list (`MODE_OPTIONS`, design-system/grid/editors/matrixColumn.ts). */
const STOCK_MODES = [{ value: 'FOLLOW', label: 'Follow' }, { value: 'PINNED', label: 'Pinned' }]

/** The editor the sheet's builders mount for this column — the same decision tree, read from the wire contract. */
export function editorOf(column: ApiColumn & { key: string }, scope: ScopeName): EditorId {
  // Mode / Qty / Buffer are the Matrix's cells (`stockColumns.tsx` → `matrixColumnDef`), whatever else the column says.
  if (column.kind === 'stockControl') return 'MatrixStockEditor'
  if (column.kind === 'variationTheme' || column.shape === 'axes') return 'AxesPanelEditor'
  if (column.shopifyField) return 'Gateway'
  if (column.key === 'productMedia') return 'MediaEditorGateway'
  if (column.key.startsWith('slots:')) return 'SlotListEditor'
  if (Array.isArray(column.validation?.recordFields)) return 'StructuredAttributeEditor'
  if (scope !== 'master' && CATEGORY_KEY[scope] === column.key) return 'ChannelCategoryEditor'
  if (scope === 'EBAY' && POLICY_KEYS.includes(column.key)) return 'EbayPolicyEditor'
  if (REFERENCE_KEYS.includes(column.key)) return 'ReferenceSelectEditor'
  if (scope === 'master' && column.key === 'impactProtectors') return 'ImpactProtectorsEditor'
  if (scope === 'master' && column.key === 'bulletPoints' && column.shape === 'list') return 'SlotListEditor'
  if (column.shape === 'list') return 'ListPanelEditor'
  if (column.shape === 'measure') return 'MeasureEditor'
  if (column.kind === 'select' || column.kind === 'boolean') return 'SelectPanelEditor'
  return 'FormulaCellEditor'
}

/* ── picking a value the cell does not hold ───────────────────────────────────────────────────────────────── */

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
/** GS1 check digit (EAN-13 / UPC-A): made-up in-store numbers (prefix 20) that pass a format check. */
function withCheckDigit(body: string) {
  const sum = [...body].reverse().reduce((total, digit, i) => total + Number(digit) * (i % 2 === 0 ? 3 : 1), 0)
  return `${body}${(10 - (sum % 10)) % 10}`
}
/** `text`, or a variant of it when the cell already holds it (a rerun on the same seed must still change the cell). */
const fresh = (text: string, current: unknown, cap: number) => (current === text.slice(0, cap) ? `${text.slice(0, cap - 2)} ·` : text.slice(0, cap))
const optionsOf = (column: ApiColumn) => column.kind === 'boolean' ? BOOLEAN.map((o) => o.value) : column.options ?? []
/** The codes whose label the sweep needs, to ask the GRID for (the sheet names some codes itself, e.g. `FIXED_PRICE`). */
export const labelledCodes = (editor: EditorId, column: ApiColumn) => (editor === 'SelectPanelEditor' || editor === 'ListPanelEditor' ? optionsOf(column) : [])

/**
 * A value for arm `n` (0, 1, 2) of this column that differs from what the cell holds now, so every commit is a real
 * change — an unchanged commit writes nothing by design and would read as a pass.
 */
export interface PickContext {
  /** The seeded description themes (the reference column's choices). */
  themes: Array<{ id: string; name: string }>
  /** The seeded categories of this scope's channel (the category column's choices), when the seed made them. */
  categories?: Array<{ id: string; name: string }>
  /** Code → the label the grid shows for it. */
  labels?: Record<string, string>
}

export function pickFor(editor: EditorId, column: ApiColumn, current: unknown, n: number, path: Path, context: PickContext): Pick {
  const { themes: seedThemes, labels = {} } = context
  const tag = `${n + 1}`
  const labelOf = (code: string) => labels[code] ?? (column.kind === 'boolean' ? BOOLEAN.find((o) => o.value === code)?.label : undefined) ?? code
  switch (editor) {
    case 'SelectPanelEditor': {
      const codes = optionsOf(column)
      // An open list also takes a typed value (#27): the keyboard arm types one the list does not hold.
      if (column.mode === 'open' && path === 'keyboard') return { input: `E2E ${column.key} ${tag}`, wire: `E2E ${column.key} ${tag}`, custom: true }
      const free = codes.filter((c) => !same(column.kind === 'boolean' ? c === 'true' : c, current))
      if (!free.length) return { input: '', wire: undefined, skip: `the list has no option besides the stored one (${codes.join(', ')})` }
      // Prefer a row past the first screen of a long list, so the list must search or scroll to reach it.
      const code = free[(free.length > 8 ? 6 + n : n) % free.length]
      return { input: labelOf(code), wire: column.kind === 'boolean' ? code === 'true' : code, shows: labelOf(code) }
    }
    case 'ReferenceSelectEditor': {
      // Only the eBay description theme's choices live in the database; the others are the channel's own (a live read).
      if (column.key !== 'descriptionThemeId') return { input: '', wire: undefined, skip: `${column.key} lists the channel's own records, read live from the channel; the seed cannot serve them` }
      const theme = seedThemes.find((t) => t.id !== current) ?? seedThemes[0]
      // A pasted NAME travels as typed and the API stores its id (channelWrite.vitest.test.ts, "reference names are resolved").
      if (path === 'paste') return { input: theme.name, wire: theme.name, stored: theme.id, shows: theme.name }
      return { input: theme.name, wire: theme.id, shows: theme.name }
    }
    case 'ChannelCategoryEditor': {
      // The seeded twin categories share one contract, so moving a row between them keeps its columns.
      const choice = (context.categories ?? []).find((c) => String(c.id) !== String(current))
      if (!choice) return { input: '', wire: null }
      const wire = column.kind === 'number' ? Number(choice.id) : choice.id
      return { input: path === 'paste' ? choice.id : choice.name, wire, shows: String(choice.id) }
    }
    case 'EbayPolicyEditor': {
      const list = NETWORK_STUBS[0].body[column.key.replace(/PolicyId$/, 'Policies') as 'fulfillmentPolicies']
      const policy = list.filter((p) => p.id !== current)[n % 2]
      return { input: policy.name, wire: policy.id, shows: policy.name }
    }
    case 'ListPanelEditor': {
      const held: Array<string | number> = Array.isArray(current) ? current.map((v) => (column.kind === 'number' && !Number.isNaN(Number(v)) ? Number(v) : String(v))) : []
      if (column.options?.length) {
        const itemOf = (code: string) => column.kind === 'number' ? Number(code) : code
        const free = column.options.filter((code) => !held.includes(itemOf(code)))
        if (!free.length) return { input: '', wire: undefined, skip: 'every option is already in the list' }
        const code = free[n % free.length], item = itemOf(code)
        // Paste replaces the whole list with what was pasted; the editors add to it.
        // The cell summarises a list (chips, a count); the read-back checks what was stored.
        return { input: labelOf(code), wire: path === 'paste' ? [item] : [...held, item] }
      }
      const text = column.kind === 'number' ? String(7 + n + (held.includes(7 + n) ? 10 : 0)) : fresh(`e2e-${column.key.slice(0, 12)}-${tag}`, held.map(String).find((h) => h.startsWith(`e2e-${column.key.slice(0, 12)}-${tag}`)) ?? null, 40)
      const item = column.kind === 'number' ? Number(text) : text
      return { input: text, wire: path === 'paste' ? [item] : [...held, item] }
    }
    case 'MeasureEditor': {
      const units = column.unitOptions ?? []
      const held = current as { value?: number; unit?: string } | null
      const unit = units.filter((u) => u !== held?.unit)[n % Math.max(1, units.length - 1)] ?? units[0] ?? null
      const value = 7 + n + (held?.value === 7 + n ? 10 : 0)
      return { input: `${value}${unit ? ` ${unit}` : ''}`, wire: { value, unit }, shows: String(value) }
    }
    case 'FormulaCellEditor': {
      if (column.kind === 'number') {
        const min = typeof column.validation?.min === 'number' ? column.validation.min : 0
        const value = min + 7 + n + (current === min + 7 + n ? 10 : 0)
        return { input: String(value), wire: value, shows: String(value) }
      }
      if (column.kind === 'date') { const day = `2026-10-${String(11 + n + (current === `2026-10-${11 + n}` ? 3 : 0)).padStart(2, '0')}`; return { input: day, wire: day, shows: day } }
      // A product identifier must be one: digits of its own length, with a valid check digit (made up, never assigned).
      const code = { gtin: 13, ean: 13, upc: 12 }[column.key as 'gtin' | 'ean' | 'upc']
      if (code) { const id = withCheckDigit(`20${String(Date.now() % 1e8).padStart(8, '0')}${n}`.slice(0, code - 1)); return { input: id, wire: id, shows: id } }
      const cap = typeof column.maxLength === 'number' ? column.maxLength : 60
      const text = cap <= 3 ? ['IT', 'FR', 'ES', 'DE'].filter((c) => c !== current)[n] : fresh(`E2E ${path} ${column.key}`, current, cap)
      return { input: text, wire: text, shows: text }
    }
    case 'MatrixStockEditor': {
      if (column.matrixCell === 'syncMode') {
        const mode = STOCK_MODES.find((m) => m.value !== current) ?? STOCK_MODES[0]
        return { input: mode.label, wire: mode.value, shows: mode.label }
      }
      // Qty and Buffer hold whole units, zero or more.
      const value = 7 + n + (current === 7 + n ? 10 : 0)
      return { input: String(value), wire: value, shows: String(value) }
    }
    case 'SlotListEditor': {
      // Shared's bullets are ONE list: the edit replaces position 1 and keeps the rest.
      const held = Array.isArray(current) ? current.map(String) : []
      const text = fresh(`E2E bullet ${path}`, held[0] ?? null, 120)
      // A paste replaces the whole list with the pasted item(s).
      return { input: text, wire: path === 'paste' ? [text] : [text, ...held.slice(1)], shows: text }
    }
    default:
      return { input: '', wire: null }
  }
}

/* ── gestures ─────────────────────────────────────────────────────────────────────────────────────────────── */

const popup = (page: Page) => page.locator('.ag-popup-editor')
const isMac = process.platform === 'darwin'
const selectAll = isMac ? 'Meta+A' : 'Control+A'

/** Select the cell the way an operator does before pasting (one click at its left edge, clear of any chevron), then paste. */
async function paste(page: Page, text: string, cell?: Locator) {
  if (cell) await cell.click({ position: { x: 6, y: 6 } })
  await page.evaluate((value) => navigator.clipboard.writeText(value), text)
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(text)
  await page.keyboard.press('ControlOrMeta+V')
}

/** Click away: the pinned product cell of the same row (`elsewhereInRow`). */
async function clickAway(ctx: ArmContext) {
  await (await elsewhereInRow(ctx.page, ctx.cell)).click()
}

/** Both lists can open on a stored value. Walk toward the target; neither list wraps at its last option. */
export async function arrowTo(page: Page, label: string) {
  for (let i = 0; i < 60; i++) {
    const state = await page.evaluate((target) => {
      const pop = document.querySelector('.ag-popup-editor')
      const options = [...(pop?.querySelectorAll('[role="option"]') ?? [])]
      const active = pop?.querySelector('[role="option"].active') ?? (document.activeElement?.getAttribute('role') === 'option' ? document.activeElement : null)
      return { active: options.indexOf(active!), target: options.findIndex((option) => option.textContent?.trim() === target) }
    }, label)
    if (state.target >= 0 && state.active === state.target) return
    await page.keyboard.press(state.target >= 0 && state.target < state.active ? 'ArrowUp' : 'ArrowDown')
  }
  throw new Error(`the list never reached "${label}"`)
}

const typeInto = async (page: Page, text: string) => { await page.keyboard.type(text, { delay: 8 }) }
/** Another driver's gesture, for an editor that driver already drives (the stock Mode cell mounts SelectPanelEditor). */
function gestureOf(editor: EditorId, path: Path): (ctx: ArmContext) => Promise<void> {
  const arm = DRIVERS[editor][path]
  if (typeof arm !== 'function') throw new Error(`${editor} has no ${path} gesture`)
  return arm
}
/**
 * Type-to-start: the first key opens the editor and is kept (P0); the rest goes in once the editor's field has focus. Keys
 * sent faster than the editor mounts can land out of order (see the P3 report: "EE keyboard color2") — a finding of its
 * own, not what this arm measures.
 */
async function typeToStart(page: Page, text: string) {
  await page.keyboard.press(text[0])
  await expect(popup(page).locator('input, textarea').first()).toBeFocused()
  await typeInto(page, text.slice(1))
}

export const DRIVERS: Record<EditorId, Driver> = {
  FormulaCellEditor: {
    kinds: ['text', 'number', 'longtext', 'date'],
    // Type-to-start keeps the first key (P0), Enter commits.
    keyboard: async ({ page, pick }) => { await typeToStart(page, pick.input); await page.keyboard.press('Enter') },
    // Double-click opens on the stored text, selected; typing replaces it; a click elsewhere commits.
    mouse: async (ctx) => {
      await ctx.cell.dblclick({ position: { x: 10, y: 10 } })
      await expect(popup(ctx.page)).toBeVisible()
      await ctx.page.keyboard.press(selectAll)
      await typeInto(ctx.page, ctx.pick.input)
      await clickAway(ctx)
    },
    paste: async ({ page, cell, pick }) => paste(page, pick.input, cell),
  },
  SelectPanelEditor: {
    kinds: ['select', 'boolean'],
    keyboard: async ({ page, pick }) => {
      await page.keyboard.press('Enter')
      await expect(popup(page).locator('[role="listbox"]')).toBeVisible()
      const searching = await popup(page).locator('input').count()
      if (pick.custom) {
        await typeInto(page, pick.input)
        await expect(popup(page).locator('[role="option"].active')).toHaveText(`Use "${pick.input}"`)
      } else if (searching) {
        await typeInto(page, pick.input)
        await arrowTo(page, pick.input)
      } else await arrowTo(page, pick.input)
      await page.keyboard.press('Enter')
    },
    // ONE click on the chevron opens the list (P0); a click on the option commits.
    mouse: async ({ page, cell, pick }) => {
      await cell.locator('.nds-ag-chev').click()
      await popup(page).getByRole('option', { name: pick.input, exact: true }).click()
    },
    // A pasted LABEL stores the CODE (the column's parser).
    paste: async ({ page, cell, pick }) => paste(page, pick.input, cell),
  },
  ReferenceSelectEditor: {
    kinds: ['text'],
    keyboard: async ({ page, pick }) => {
      await page.keyboard.press('Enter')
      await expect(popup(page).locator('input')).toBeFocused()
      await typeInto(page, pick.input)
      await expect(popup(page).locator('[role="option"].active')).toHaveText(pick.input)
      await page.keyboard.press('Enter')
    },
    mouse: async ({ page, cell, pick }) => {
      await cell.locator('.nds-ag-chev').click()
      await popup(page).getByRole('option', { name: pick.input, exact: true }).click()
    },
    paste: async ({ page, cell, pick }) => paste(page, pick.input, cell),
  },
  EbayPolicyEditor: {
    kinds: ['text'],
    refusedOffline: {
      reason: 'The API checks a business policy id against the seller\'s eBay policies before storing it.',
      answer: /policy choices could not be verified.*existing value has been kept/i,
    },
    keyboard: async ({ page, pick }) => {
      await page.keyboard.press('Enter')
      const select = popup(page).locator('select')
      await expect(select).toBeEnabled()
      await select.focus()
      await select.selectOption({ label: pick.input })
    },
    mouse: async ({ page, cell, pick }) => {
      await cell.dblclick({ position: { x: 10, y: 10 } })
      const select = popup(page).locator('select')
      await expect(select).toBeEnabled()
      await select.selectOption({ label: pick.input })
    },
    paste: async ({ page, cell, pick }) => paste(page, String(pick.wire), cell),
  },
  ListPanelEditor: {
    kinds: ['list'],
    keyboard: async ({ page, column, pick }) => {
      await page.keyboard.press('Enter')
      await expect(popup(page)).toBeVisible()
      if (column.options?.length) {
        // Search, ↓ to the box, Space ticks it, Enter saves.
        await typeInto(page, pick.input)
        await page.keyboard.press('ArrowDown')
        await page.keyboard.press('Space')
      } else await typeInto(page, pick.input)
      await page.keyboard.press('Enter')
    },
    mouse: async (ctx) => {
      await ctx.cell.dblclick({ position: { x: 10, y: 10 } })
      await expect(popup(ctx.page)).toBeVisible()
      if (ctx.column.options?.length) await popup(ctx.page).getByRole('checkbox', { name: ctx.pick.input, exact: true }).click()
      else { await popup(ctx.page).locator('input').first().click(); await typeInto(ctx.page, ctx.pick.input) }
      await clickAway(ctx)
    },
    paste: async ({ page, cell, pick }) => paste(page, pick.input, cell),
  },
  MeasureEditor: {
    kinds: ['measure'],
    // A digit opens on the number (P0); Tab goes to the units; ↓ to the unit; Enter saves both.
    keyboard: async ({ page, pick }) => {
      const [value, unit] = pick.input.split(' ')
      await typeToStart(page, value)
      await page.keyboard.press('Tab')
      if (unit) await arrowTo(page, unit)
      await page.keyboard.press('Enter')
    },
    mouse: async (ctx) => {
      const [value, unit] = ctx.pick.input.split(' ')
      await ctx.cell.dblclick({ position: { x: 10, y: 10 } })
      await expect(popup(ctx.page)).toBeVisible()
      await popup(ctx.page).getByRole('textbox', { name: 'Value' }).fill(value)
      if (unit) await popup(ctx.page).getByRole('option', { name: unit, exact: true }).click()
      await clickAway(ctx)
    },
    paste: async ({ page, cell, pick }) => paste(page, pick.input, cell),
  },
  SlotListEditor: {
    kinds: ['list'],
    // Opens on position 1; select it, type, Enter saves.
    keyboard: async ({ page, pick }) => {
      await page.keyboard.press('Enter')
      await expect(popup(page).locator('textarea').first()).toBeFocused()
      await page.keyboard.press(selectAll)
      await typeInto(page, pick.input)
      await page.keyboard.press('Enter')
    },
    mouse: async (ctx) => {
      await ctx.cell.dblclick({ position: { x: 10, y: 10 } })
      const first = popup(ctx.page).locator('textarea').first()
      await first.click()
      await ctx.page.keyboard.press(selectAll)
      await typeInto(ctx.page, ctx.pick.input)
      await clickAway(ctx)
    },
    paste: async ({ page, cell, pick }) => paste(page, pick.input, cell),
  },
  ChannelCategoryEditor: {
    kinds: ['text', 'number'],
    keyboard: async ({ page, pick }) => {
      await page.keyboard.press('Enter')
      await expect(popup(page).locator('input')).toBeFocused()
      await typeInto(page, pick.input)
      await expect(popup(page).locator('[role="option"].active')).toContainText(pick.input)
      await page.keyboard.press('Enter')
    },
    mouse: async ({ page, cell, pick }) => {
      await cell.dblclick({ position: { x: 10, y: 10 } })
      await popup(page).locator('input').fill(pick.input)
      await popup(page).getByRole('option').filter({ hasText: pick.input }).first().click()
    },
    paste: async ({ page, cell, pick }) => paste(page, pick.input, cell),
  },
  StructuredAttributeEditor: {
    kinds: ['record'],
    abstain: 'No record column in the seeded schemas yet: the node test (sheetEditorKeys.vitest.test.ts) covers its Enter and Tab.',
    keyboard: { na: 'abstained' }, mouse: { na: 'abstained' }, paste: { na: 'abstained' },
  },
  ImpactProtectorsEditor: {
    kinds: ['record'],
    abstain: 'Only on a master column the seed does not build (impactProtectors); the node test covers its Enter and Tab.',
    keyboard: { na: 'abstained' }, mouse: { na: 'abstained' }, paste: { na: 'abstained' },
  },
  AxesPanelEditor: {
    kinds: ['variationTheme'],
    abstain: 'The variation theme rewrites the family\'s structure (every child\'s axis values); one commit would change the rows the other columns use. It has its own browser spec in the variation-theme lane.',
    keyboard: { na: 'abstained' }, mouse: { na: 'abstained' }, paste: { na: 'abstained' },
  },
  Gateway: {
    kinds: ['shopify'],
    abstain: 'Shopify cells open the Shopify value dialog, not a grid editor, and their field definitions come from a live Shopify read.',
    keyboard: { na: 'abstained' }, mouse: { na: 'abstained' }, paste: { na: 'abstained' },
  },
  MediaEditorGateway: {
    kinds: ['media'],
    abstain: 'Product media opens the media dialog (uploads); it is not a cell value.',
    keyboard: { na: 'abstained' }, mouse: { na: 'abstained' }, paste: { na: 'abstained' },
  },
  FormulaUnavailableEditor: {
    kinds: [],
    abstain: 'Shown only while a cell\'s formula state is loading or failed: a message with Retry and Close, no value.',
    keyboard: { na: 'abstained' }, mouse: { na: 'abstained' }, paste: { na: 'abstained' },
  },
  agLargeTextCellEditor: {
    kinds: ['longtext'],
    abstain: 'AG\'s own long-text editor, mounted only where a long-text column refuses formulas; the seeded columns all take them. AG reads its value itself.',
    keyboard: { na: 'abstained' }, mouse: { na: 'abstained' }, paste: { na: 'abstained' },
  },
  agTextCellEditor: {
    kinds: ['text'],
    abstain: 'A selector fallback the studio always replaces with the value editor (FormulaCellEditor); never mounted on the sheet.',
    keyboard: { na: 'abstained' }, mouse: { na: 'abstained' }, paste: { na: 'abstained' },
  },
  agNumberCellEditor: {
    kinds: ['number'],
    abstain: 'A selector fallback the studio always replaces with the value editor (FormulaCellEditor). The stock Qty and Buffer cells mount it; MatrixStockEditor drives them.',
    keyboard: { na: 'abstained' }, mouse: { na: 'abstained' }, paste: { na: 'abstained' },
  },
  MatrixStockEditor: {
    kinds: ['stockControl'],
    // Mode is the DS list (`selectEditor`): Enter opens it, ↓ to the choice, Enter. Qty and Buffer are AG's number editor
    // IN the cell (`matrixColumnDef`): a digit opens it and is kept, Enter saves.
    keyboard: async (ctx) => {
      if (ctx.column.matrixCell === 'syncMode') return gestureOf('SelectPanelEditor', 'keyboard')(ctx)
      await ctx.page.keyboard.press(ctx.pick.input[0])
      await expect(ctx.cell.locator('input')).toBeFocused()
      await typeInto(ctx.page, ctx.pick.input.slice(1))
      await ctx.page.keyboard.press('Enter')
    },
    // Mode: ONE click on the chevron opens the list, a click on the option commits. Qty and Buffer: a double-click opens
    // the stored number; typing replaces it; a click elsewhere commits.
    mouse: async (ctx) => {
      if (ctx.column.matrixCell === 'syncMode') return gestureOf('SelectPanelEditor', 'mouse')(ctx)
      await ctx.cell.dblclick({ position: { x: 10, y: 10 } })
      await expect(ctx.cell.locator('input')).toBeFocused()
      await ctx.page.keyboard.press(selectAll)
      await typeInto(ctx.page, ctx.pick.input)
      await clickAway(ctx)
    },
    // A pasted Mode word (what a copied Mode cell carries) stores its code; a pasted number is the units.
    paste: async ({ page, cell, pick }) => paste(page, pick.input, cell),
  },
}
