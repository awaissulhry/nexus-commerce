/**
 * MS.3 / MS.4 — the master sheet's WRITE dispatch.
 *
 * This is the half of the sheet that was browser-verified only. Everything here is a way the sheet
 * can lie to an operator about production data: reporting a save that the server refused, sending an
 * attribute to the endpoint that cannot write it, dropping a per-cell refusal that arrived inside a
 * 200, or quietly setting a field on rows nobody selected. Each test names the lie it prevents.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/backend-url', () => ({ getBackendUrl: () => 'https://api.test' }))

const { saveSheetCell, bulkSetCells } = await import('./useMasterSheet')
import type { SheetColumn, SheetRow } from './types'

const col = (over: Partial<SheetColumn> & Pick<SheetColumn, 'key'>): SheetColumn => ({
  writeField: `attr_${over.key}`,
  label: over.key,
  group: 'Attributes',
  kind: 'text',
  storage: 'categoryAttributes',
  scope: 'global',
  requiredBy: [],
  editable: true,
  defaultVisible: true,
  ...over,
})

const row = (over: Partial<SheetRow> & Pick<SheetRow, 'id'>): SheetRow => ({
  sku: over.id,
  name: over.id,
  parentId: null,
  isParent: false,
  status: 'ACTIVE',
  productType: 'COAT',
  version: 3,
  basePrice: 10,
  childCount: 0,
  values: {},
  listings: {},
  readiness: {},
  completeness: { overall: { filled: 0, total: 0, pct: 0 }, required: { filled: 0, total: 0, missing: [] }, byGroup: [] },
  ...over,
})

let fetchMock: ReturnType<typeof vi.fn>
const jsonRes = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

const lastBody = () => JSON.parse((fetchMock.mock.calls.at(-1)![1] as RequestInit).body as string)
const lastUrl = () => String(fetchMock.mock.calls.at(-1)![0])

describe('saveSheetCell — routing', () => {
  it('sends an attribute to the bulk endpoint with its write field and the row version', async () => {
    fetchMock.mockResolvedValue(jsonRes(200, { updated: 1, currentVersion: 4 }))
    const out = await saveSheetCell({ row: row({ id: 'p1', version: 3 }), column: col({ key: 'material' }), value: 'Leather', locale: 'it' })
    expect(out).toEqual({ ok: true, version: 4 })
    expect(lastUrl()).toBe('https://api.test/api/products/bulk')
    expect(lastBody()).toEqual({ changes: [{ id: 'p1', field: 'attr_material', value: 'Leather' }], expectedVersion: 3 })
  })

  it('sends a locale field to the per-product global route, not the bulk one', async () => {
    // The bulk endpoint writes Product columns and attr_*; it has no route into a locale slot, so a
    // title sent there would be silently accepted against the wrong field or refused as unknown.
    fetchMock.mockResolvedValue(jsonRes(200, { ok: true }))
    const out = await saveSheetCell({
      row: row({ id: 'p1' }),
      column: col({ key: 'title', storage: 'localizedContent', writeField: 'title' }),
      value: 'Giacca',
      locale: 'it',
    })
    expect(out.ok).toBe(true)
    expect(lastUrl()).toBe('https://api.test/api/products/p1/global')
    expect(lastBody()).toEqual({ patch: { it: { title: 'Giacca' } } })
  })

  it('writes a plain column under its own name, without the attr_ prefix', async () => {
    fetchMock.mockResolvedValue(jsonRes(200, { updated: 1 }))
    await saveSheetCell({ row: row({ id: 'p1' }), column: col({ key: 'brand', storage: 'column', writeField: 'brand' }), value: 'Xavia', locale: 'it' })
    expect(lastBody().changes[0].field).toBe('brand')
  })

  it('turns an emptied cell into null rather than an empty string', async () => {
    // An empty string is a VALUE; the operator clearing a cell means "no value".
    fetchMock.mockResolvedValue(jsonRes(200, { updated: 1 }))
    await saveSheetCell({ row: row({ id: 'p1' }), column: col({ key: 'material' }), value: '', locale: 'it' })
    expect(lastBody().changes[0].value).toBeNull()
  })
})

describe('saveSheetCell — the server said no', () => {
  it('reports a version conflict in words an operator can act on', async () => {
    fetchMock.mockResolvedValue(jsonRes(409, { code: 'VERSION_CONFLICT', currentVersion: 9 }))
    const out = await saveSheetCell({ row: row({ id: 'p1' }), column: col({ key: 'material' }), value: 'x', locale: 'it' })
    expect(out.ok).toBe(false)
    expect(out.reason).toMatch(/Someone else changed this row \(v9\)/)
  })

  it('surfaces a per-cell refusal that arrived inside a 200', async () => {
    // The trap: the bulk endpoint reports partial success, so `res.ok` is true while THIS cell was
    // refused. Trusting the status code would paint the cell green over a value that never landed.
    fetchMock.mockResolvedValue(jsonRes(200, { updated: 0, errors: [{ id: 'p1', field: 'attr_material', error: 'not a valid material' }] }))
    const out = await saveSheetCell({ row: row({ id: 'p1' }), column: col({ key: 'material' }), value: 'x', locale: 'it' })
    expect(out).toMatchObject({ ok: false, reason: 'not a valid material' })
  })

  it('ignores another row’s error in the same response', async () => {
    fetchMock.mockResolvedValue(jsonRes(200, { updated: 1, errors: [{ id: 'SOMEONE-ELSE', error: 'nope' }] }))
    const out = await saveSheetCell({ row: row({ id: 'p1' }), column: col({ key: 'material' }), value: 'x', locale: 'it' })
    expect(out.ok).toBe(true)
  })

  it('refuses a save the server accepted while changing nothing', async () => {
    // `updated: 0` with no error means the write was a no-op — reporting "saved" would be a lie.
    fetchMock.mockResolvedValue(jsonRes(200, { updated: 0 }))
    const out = await saveSheetCell({ row: row({ id: 'p1' }), column: col({ key: 'material' }), value: 'x', locale: 'it' })
    expect(out.ok).toBe(false)
    expect(out.reason).toMatch(/changed nothing/)
  })

  it('reads the prose reason the /global route returns instead of a field-keyed one', async () => {
    fetchMock.mockResolvedValue(jsonRes(400, { error: 'invalid_patch', details: ['title must be a string'] }))
    const out = await saveSheetCell({ row: row({ id: 'p1' }), column: col({ key: 'title', storage: 'localizedContent' }), value: 1, locale: 'it' })
    expect(out).toMatchObject({ ok: false, reason: 'title must be a string' })
  })

  it('turns a thrown network error into a refusal, never an exception', async () => {
    // A refusal is a RESULT the cell paints; an exception would escape into the grid's event handler.
    fetchMock.mockRejectedValue(new Error('Failed to fetch'))
    const out = await saveSheetCell({ row: row({ id: 'p1' }), column: col({ key: 'material' }), value: 'x', locale: 'it' })
    expect(out).toEqual({ ok: false, reason: 'Failed to fetch' })
  })
})

describe('bulkSetCells', () => {
  const applies = (r: SheetRow, c: SheetColumn) => !(r.isParent && c.scope === 'per_variant')

  it('sends one request carrying a change per applicable row', async () => {
    fetchMock.mockResolvedValue(jsonRes(200, { updated: 2 }))
    const out = await bulkSetCells({
      rows: [row({ id: 'a' }), row({ id: 'b' })],
      column: col({ key: 'material' }), value: 'Leather', locale: 'it', applies,
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(lastBody().changes).toEqual([
      { id: 'a', field: 'attr_material', value: 'Leather' },
      { id: 'b', field: 'attr_material', value: 'Leather' },
    ])
    expect(out.updated).toEqual(['a', 'b'])
  })

  it('never sends a version, because one cannot be right for N rows', async () => {
    fetchMock.mockResolvedValue(jsonRes(200, { updated: 1 }))
    await bulkSetCells({ rows: [row({ id: 'a' })], column: col({ key: 'material' }), value: 'x', locale: 'it', applies })
    expect(lastBody().expectedVersion).toBeUndefined()
  })

  it('skips a row the column cannot apply to, and says why — without sending it', async () => {
    // The defect: asking the server to set a size on a parent, then reporting its refusal as an
    // error. It is not an error; it is a question that should never have been asked.
    fetchMock.mockResolvedValue(jsonRes(200, { updated: 1 }))
    const out = await bulkSetCells({
      rows: [row({ id: 'parent', isParent: true }), row({ id: 'child' })],
      column: col({ key: 'size', scope: 'per_variant' }), value: 'M', locale: 'it', applies,
    })
    expect(lastBody().changes.map((c: { id: string }) => c.id)).toEqual(['child'])
    expect(out.skipped).toEqual([{ id: 'parent', reason: 'belongs to each variation' }])
    expect(out.updated).toEqual(['child'])
  })

  it('does not call the server at all when nothing applies', async () => {
    const out = await bulkSetCells({
      rows: [row({ id: 'parent', isParent: true })],
      column: col({ key: 'size', scope: 'per_variant' }), value: 'M', locale: 'it', applies,
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/No selected row can hold this field/)
  })

  it('splits a partial success into the rows that took it and the rows that did not', async () => {
    fetchMock.mockResolvedValue(jsonRes(200, { updated: 1, errors: [{ id: 'b', error: 'too long' }] }))
    const out = await bulkSetCells({
      rows: [row({ id: 'a' }), row({ id: 'b' })],
      column: col({ key: 'material' }), value: 'x', locale: 'it', applies,
    })
    expect(out.updated).toEqual(['a'])
    expect(out.refused).toEqual([{ id: 'b', reason: 'too long' }])
  })

  it('fans a locale column out per product, since the bulk route cannot reach a locale slot', async () => {
    fetchMock.mockResolvedValue(jsonRes(200, { ok: true }))
    const out = await bulkSetCells({
      rows: [row({ id: 'a' }), row({ id: 'b' })],
      column: col({ key: 'title', storage: 'localizedContent', writeField: 'title' }), value: 'Giacca', locale: 'it', applies,
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls.every((c) => String(c[0]).endsWith('/global'))).toBe(true)
    expect(out.updated.sort()).toEqual(['a', 'b'])
  })

  it('reports a hard failure without claiming any row was set', async () => {
    fetchMock.mockResolvedValue(jsonRes(500, { error: 'boom' }))
    const out = await bulkSetCells({
      rows: [row({ id: 'a' })], column: col({ key: 'material' }), value: 'x', locale: 'it', applies,
    })
    expect(out.ok).toBe(false)
    expect(out.updated).toEqual([])
    expect(out.error).toBe('boom')
  })
})
