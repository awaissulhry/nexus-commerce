/**
 * The sweep's handle on the grid and the sheet contract. The grid is found through its own cells (the AG api every cell
 * renderer receives); nothing here writes except through the gestures in `drivers.ts`.
 */
import { expect, type Locator, type Page } from '@playwright/test'
import { decodeSheetCells } from '@nexus/shared/sheet-cell-wire'
import type { SheetSeed } from './seed'

/** The AG api of the sheet's grid, found from any rendered cell and kept on `window` for the page's life. */
const FIND_API = `(() => {
  if (window.__sweepApi && !window.__sweepApi.isDestroyed()) return window.__sweepApi
  for (const el of document.querySelectorAll('.ag-row .ag-cell, .ag-row .ag-cell *')) {
    const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$'))
    for (let f = key ? el[key] : null; f; f = f.return) {
      const p = f.memoizedProps
      if (p && p.api && typeof p.api.getDisplayedRowCount === 'function') { window.__sweepApi = p.api; return p.api }
    }
  }
  return null
})()`
const withApi = (body: string) => `(() => { const api = ${FIND_API}; if (!api) throw new Error('the sheet grid is not mounted'); ${body} })()`

export type ScopeName = 'master' | 'EBAY' | 'AMAZON' | 'ETSY'

export interface Scope {
  name: ScopeName
  family: string
  /** The studio page for this scope. */
  page: string
  /** The API read of the same scope (the contract). */
  api: string
  locale: string
  channel?: string
  market?: string
  connection?: string
}

export function scopeOf(seed: SheetSeed, name: ScopeName, f = seed.families[name]): Scope {
  const locale = name === 'ETSY' ? 'en' : 'it'
  if (name === 'master') {
    return { name, family: f.family, locale, page: `/w/${seed.workspace}/products/${f.family}/edit/studio?scope=master&market=IT&locale=${locale}&tab=sheet`,
      api: `/backend/api/products/${f.family}/studio/sheet?scope=master&market=IT&locale=${locale}` }
  }
  return { name, family: f.family, locale, channel: f.channel, market: f.market, connection: f.connection,
    page: `/w/${seed.workspace}/products/${f.family}/edit/studio?scope=${f.channel}&market=${f.market}&account=${f.connection}&locale=${locale}&tab=sheet`,
    api: `/backend/api/products/${f.family}/studio/sheet?scope=channel&channel=${f.channel}&market=${f.market}&locale=${locale}&accountId=${f.connection}` }
}

export interface ApiColumn {
  key: string; label: string; kind: string; shape?: string; mode?: string; options?: string[]; optionLabels?: Record<string, string>
  unitOptions?: string[]; editable: boolean; defaultVisible?: boolean; writeField?: string; maxLength?: number | null
  validation?: { min?: number; max?: number; recordFields?: unknown[]; [k: string]: unknown }; cardinality?: { min?: number; max?: number | null }
  shopifyField?: unknown; slot?: unknown
}
export interface ApiCell { value: unknown; writable?: boolean; editable?: boolean; writeField?: string; writeTarget?: string; contentAddress?: unknown }
export interface ApiRow { id: string; rowId?: string; isParent: boolean; version: number; listing?: { version?: number } | null; values: Record<string, ApiCell> }
export interface SheetRead { columns: ApiColumn[]; rows: ApiRow[]; scope: { kind: string; channel: string | null; marketplace: string | null; connectionId: string | null; locale: string } }

/** The sheet contract, read with the page's own session (and business header, as the browser's patched fetch sends it). */
export async function readSheet(page: Page, scope: Scope, workspace: string): Promise<SheetRead> {
  const response = await page.request.get(`${scope.api}&cells=compact`, { headers: { 'x-nexus-workspace-id': workspace }, maxRedirects: 0 })
  expect(response.status(), `GET ${scope.api}`).toBe(200)
  return decodeSheetCells(await response.json()) as SheetRead
}

export async function openSheet(page: Page, scope: Scope) {
  await page.goto(scope.page)
  await page.waitForFunction(() => document.querySelectorAll('.ag-row[row-id] .ag-cell').length > 1, null, { timeout: 120_000 })
  await expect.poll(() => page.evaluate(`!!${FIND_API}`), { timeout: 30_000 }).toBe(true)
}

/**
 * Every column the grid built, shown. Hidden-by-default columns are revealed through the grid's own column model, which
 * the sheet does not persist (only sizing, pinning and sort are saved), so the sweep leaves no layout behind.
 */
export async function revealAllColumns(page: Page): Promise<string[]> {
  return page.evaluate(withApi(`
    const ids = api.getColumns().map((c) => c.getColId())
    api.setColumnsVisible(ids, true)
    return api.getColumns().filter((c) => c.isVisible()).map((c) => c.getColId())`)) as Promise<string[]>
}

/** Brings one cell on screen (rows and columns are virtualised) and gives it keyboard focus, as a click would. */
export async function focusCell(page: Page, productId: string, colId: string): Promise<Locator> {
  const rowIndex = await page.evaluate(withApi(`
    let at = -1
    api.forEachNode((n) => { if (at < 0 && n.data && n.data.id === ${JSON.stringify(productId)}) at = n.rowIndex })
    if (at < 0) throw new Error('row not in the grid: ' + ${JSON.stringify(productId)})
    api.ensureIndexVisible(at, 'middle')
    // The sheet re-applies its view after some saves (a column shown by the sweep can be hidden again): show it each time.
    api.setColumnsVisible([${JSON.stringify(colId)}], true)
    api.ensureColumnVisible(${JSON.stringify(colId)}, 'middle')
    api.setFocusedCell(at, ${JSON.stringify(colId)})
    return at`)) as number
  const cell = page.locator(`.ag-row[row-index="${rowIndex}"] .ag-cell[col-id="${colId}"]`)
  await expect(cell).toBeVisible()
  await cell.evaluate((el: HTMLElement) => el.focus())
  return cell
}

/**
 * The pinned product cell of the same row — always rendered, whatever the horizontal scroll. Clicking it is the click-away
 * that commits an open editor (`stopEditingWhenCellsLoseFocus`).
 */
export function elsewhereInRow(page: Page, cell: Locator): Promise<Locator> {
  return cell.evaluate((el) => el.closest('.ag-row')?.getAttribute('row-index') ?? '').then((index) =>
    page.locator(`.ag-row[row-index="${index}"] .ag-cell.ag-cell-last-left-pinned`).first())
}

/** How the grid names each code in this column (its own formatter: the sheet adds names the contract lacks). */
export async function gridLabels(page: Page, colId: string, codes: string[], list = false): Promise<Record<string, string>> {
  if (!codes.length) return {}
  return page.evaluate(withApi(`
    const def = api.getColumnDef(${JSON.stringify(colId)}) || {}
    const out = {}
    for (const code of ${JSON.stringify(codes)}) {
      let label = code
      try {
        if (typeof def.valueFormatter === 'function') {
          const shown = def.valueFormatter({ value: ${list} ? [code] : code, colDef: def, api, data: undefined, node: undefined })
          if (typeof shown === 'string' && shown) label = shown
        }
      } catch (_) {}
      out[code] = label
    }
    return out`)) as Promise<Record<string, string>>
}

export async function editingCells(page: Page): Promise<number> {
  return page.evaluate(withApi('return api.getEditingCells().length')) as Promise<number>
}
