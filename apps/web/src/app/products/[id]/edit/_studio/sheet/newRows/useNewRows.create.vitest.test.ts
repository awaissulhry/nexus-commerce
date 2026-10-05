/**
 * Add rows (R2–R3) — what typing a SKU into an empty row does: checked, created at once (a variation under the family's
 * parent with the parent's name; a listing alias with the SKU on this account), refusals kept on the row in the
 * server's words, a lost answer kept as "Not confirmed" with the row's key, ONE sheet read per batch, paste spreading,
 * removal, and the wire: one Idempotency-Key per row, reused after a lost answer.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/backend-url', () => ({ getBackendUrl: () => 'http://api.test' }))

import type { FamilyResponse } from '../master/family'
import { NEW_ROWS_WORDS } from './newRows'
import { NEW_ROW_FOCUS_FRAMES, NewRowsStore, addRowsAndFocus, aliasTarget, focusMayMove, focusNewRow, lostAnswer, newRowsContextMenu, newRowsGridKey, newRowsPaste, sheetNewRowsApi, variationTarget, type CreateOutcome, type NewRowsApi, type NewRowsHost, type NewRowsTargetAnswer } from './useNewRows'
import { sharedNewRow } from './newRowsGrid'
import type { LandingRowNode } from '@/design-system/grid'

const family = {
  role: 'parent', self: { id: 'parent', sku: 'GALE', name: 'Gale jacket', isParent: true, parentId: null, variationTheme: null, variationAxes: ['Size'] },
  parent: null, children: [{ id: 'm', sku: 'GALE-M' }], siblings: [],
} as unknown as FamilyResponse

/** A server whose answers the test releases one by one. */
function fakeApi() {
  const calls: Array<{ kind: 'variation' | 'alias'; input: Record<string, unknown>; settle: (o: CreateOutcome | Error) => void }> = []
  const pending = (kind: 'variation' | 'alias') => (input: Record<string, unknown>) => new Promise<CreateOutcome>((resolve, reject) => {
    calls.push({ kind, input, settle: (o) => (o instanceof Error ? reject(o) : resolve(o)) })
  })
  const api: NewRowsApi = { createVariation: pending('variation') as NewRowsApi['createVariation'], createAlias: pending('alias') as NewRowsApi['createAlias'] }
  return { api, calls }
}

function store(over: Partial<NewRowsHost> & { targets?: Partial<Record<'variation' | 'alias', NewRowsTargetAnswer>> } = {}) {
  const { api, calls } = fakeApi()
  const said: Array<{ message: string; tone: string }> = []
  const reads = { n: 0, kinds: [] as string[][] }
  const targets: Record<'variation' | 'alias', NewRowsTargetAnswer> = {
    variation: { kind: 'variation', parentId: 'parent', parentName: 'Gale jacket' },
    alias: { kind: 'alias', productId: 'parent', channel: 'EBAY', marketplace: 'IT', accountId: 'acc-b' },
    ...over.targets,
  }
  const s = new NewRowsStore({
    api, target: (kind) => targets[kind],
    skuContext: () => ({ family, takenSkus: ['GALE', 'GALE-M'] }),
    onCreated: (kinds) => { reads.n++; reads.kinds.push([...kinds]) }, say: (message, tone) => { said.push({ message, tone }) },
    ...over,
  })
  return { s, calls, said, reads }
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('typing a SKU into an empty row', () => {
  it('creates a draft variation under the family\'s parent, with the parent\'s name and the row as its key slot', async () => {
    const { s, calls, reads } = store()
    const [row] = s.add('variation', 1)
    expect(s.type(row.id, '  GALE-L ')).toBe('saving')
    expect(s.rowFor(row.id)).toMatchObject({ sku: 'GALE-L', state: 'saving' })
    expect(s.busy).toBe(true)
    expect(calls).toEqual([expect.objectContaining({ kind: 'variation', input: { parentId: 'parent', sku: 'GALE-L', name: 'Gale jacket', slot: row.id } })])
    calls[0].settle({ ok: true, id: 'new-child' })
    await flush()
    expect(s.rowFor(row.id)).toMatchObject({ state: 'created', createdId: 'new-child' })
    expect(s.busy).toBe(false)
    expect(reads.n).toBe(1)
    // The sheet read shows the new product: the empty row gives its place to it.
    s.landed(new Set(['new-child']))
    expect(s.getSnapshot()).toEqual([])
  })

  it('creates a listing alias with the SKU on this channel, market and account', async () => {
    const { s, calls } = store()
    const [row] = s.add('alias', 1)
    s.type(row.id, 'IT-GALE-2')
    expect(calls[0]).toMatchObject({ kind: 'alias', input: { productId: 'parent', channel: 'EBAY', marketplace: 'IT', accountId: 'acc-b', sku: 'IT-GALE-2', slot: row.id } })
  })

  it('names a SKU the client check refuses on the row and sends nothing', () => {
    const { s, calls } = store()
    const [a, b] = s.add('variation', 2)
    expect(s.type(a.id, 'GALE M')).toBe('refused')
    expect(s.rowFor(a.id)?.reason).toBe('Use only letters, numbers, dots (.), hyphens (-) and underscores (_). No spaces.')
    expect(s.type(b.id, 'gale-m')).toBe('refused')
    expect(s.rowFor(b.id)?.reason).toBe('GALE-M is already in this family.')
    expect(calls).toHaveLength(0)
    // Emptying a refused row puts it back to empty.
    expect(s.type(a.id, '')).toBe('empty')
    expect(s.rowFor(a.id)).toMatchObject({ sku: '', reason: null })
  })

  it('keeps the server\'s refusal on the row, verbatim, and lets the person type another SKU', async () => {
    const { s, calls, reads } = store()
    const [row] = s.add('variation', 1)
    s.type(row.id, 'GALE-L')
    calls[0].settle({ ok: false, reason: 'SKU "GALE-L" already exists' })
    await flush()
    expect(s.rowFor(row.id)).toMatchObject({ state: 'refused', reason: 'SKU "GALE-L" already exists', sku: 'GALE-L' })
    expect(reads.n).toBe(0)
    expect(s.type(row.id, 'GALE-XL')).toBe('saving')
  })

  it('keeps a lost answer as "Not confirmed": the same SKU again resends on the same key slot', async () => {
    const { s, calls } = store()
    const [row] = s.add('variation', 1)
    s.type(row.id, 'GALE-L')
    calls[0].settle({ ok: false, reason: 'Failed to fetch', unknown: true })
    await flush()
    expect(s.rowFor(row.id)).toMatchObject({ state: 'unknown', reason: lostAnswer('Failed to fetch') })
    s.type(row.id, 'GALE-L')
    expect(calls[1].input).toMatchObject({ sku: 'GALE-L', slot: row.id })
    // A create that threw (no outcome at all) is a lost answer too.
    calls[1].settle(new TypeError('Load failed'))
    await flush()
    expect(s.rowFor(row.id)?.state).toBe('unknown')
  })

  it('refuses the row in the scope\'s words when that kind cannot be created now', () => {
    const { s, said } = store({ targets: { variation: { refused: 'Only a parent can hold variations. Promote this product first.' } } })
    expect(s.add('variation', 3)).toEqual([])
    expect(said).toEqual([{ message: 'Only a parent can hold variations. Promote this product first.', tone: 'warning' }])
  })
})

describe('a batch', () => {
  it('reads the sheet ONCE after the last create of a paste settles, and says what was left over', async () => {
    const { s, calls, reads, said } = store()
    const rows = s.add('variation', 3)
    const result = s.paste(rows[0].id, [['GALE-L', 'Red'], ['GALE-XL'], ['GALE-XXL'], ['GALE-S'], ['GALE-XS']])
    expect(result.fill.map((f) => f.sku)).toEqual(['GALE-L', 'GALE-XL', 'GALE-XXL'])
    expect(result.leftOver).toBe(2)
    expect(said.at(-1)).toEqual({ message: '2 SKUs were left over: add 2 more rows, then paste them again. Only the SKUs were used. The other cells open once each row is created.', tone: 'warning' })
    // One after another (F10): the first create is sent, the others wait for its answer — all three rows say so.
    expect(calls).toHaveLength(1)
    expect(s.getSnapshot().map((r) => r.state)).toEqual(['saving', 'saving', 'saving'])
    calls[0].settle({ ok: false, reason: 'SKU "GALE-L" already exists' })
    await flush()
    expect(calls).toHaveLength(2)
    calls[1].settle({ ok: true, id: 'p-xl' })
    await flush()
    expect(reads.n).toBe(0)
    calls[2].settle({ ok: true, id: 'p-xxl' })
    await flush()
    expect(reads.n).toBe(1)
    expect(reads.kinds).toEqual([['variation']])
    expect(s.getSnapshot().map((r) => r.state)).toEqual(['refused', 'created', 'created'])
    expect(s.busy).toBe(false)
  })

  it('says which kinds a batch created (a new listing may need the sheet to show every listing)', async () => {
    const { s, calls, reads } = store()
    const [v] = s.add('variation', 1)
    const [a] = s.add('alias', 1)
    s.type(v.id, 'GALE-L')
    s.type(a.id, 'IT-GALE-2')
    calls[0].settle({ ok: true, id: 'p-l' })
    await flush()
    calls[1].settle({ ok: true, id: 'alias-2' })
    await flush()
    expect(reads.kinds).toEqual([['variation', 'alias']])
  })

  it('F10 (browser check 2026-10-05): a paste of several SKUs creates them ONE AFTER ANOTHER, each on its own key — a server that refuses a create while another one changes the family refuses none', async () => {
    let active = 0
    const sent: Array<{ sku: string; slot: string }> = []
    const create = async (input: { sku: string; slot: string }): Promise<CreateOutcome> => {
      sent.push({ sku: input.sku, slot: input.slot })
      if (active > 0) return { ok: false, reason: 'This family changed during the operation. Reload it and review the action again.' }
      active++
      await new Promise((resolve) => setTimeout(resolve, 5))
      active--
      return { ok: true, id: `id-${input.sku}` }
    }
    const api: NewRowsApi = { createVariation: create, createAlias: create }
    const { s, reads } = store({ api })
    const rows = s.add('variation', 4)
    s.paste(rows[0].id, ['GALE-A1', 'GALE-A2', 'GALE-A3', 'GALE-A4'])
    await vi.waitFor(() => expect(s.busy).toBe(false))
    expect(s.getSnapshot().map((r) => [r.sku, r.state])).toEqual([['GALE-A1', 'created'], ['GALE-A2', 'created'], ['GALE-A3', 'created'], ['GALE-A4', 'created']])
    expect(sent.map((c) => c.sku)).toEqual(['GALE-A1', 'GALE-A2', 'GALE-A3', 'GALE-A4'])
    expect(new Set(sent.map((c) => c.slot))).toEqual(new Set(rows.map((r) => r.id)))
    // The sheet is read once, after the last create.
    expect(reads.n).toBe(1)
  })

  it('F10: a refused create in the line keeps its SKU and sentence; the next one still goes; one read at the end', async () => {
    const { s, calls, reads } = store()
    const rows = s.add('variation', 3)
    s.paste(rows[0].id, ['GALE-B1', 'GALE-B2', 'GALE-B3'])
    calls[0].settle({ ok: true, id: 'b1' })
    await flush()
    calls[1].settle({ ok: false, reason: 'SKU "GALE-B2" already exists' })
    await flush()
    expect(reads.n).toBe(0)
    calls[2].settle({ ok: true, id: 'b3' })
    await flush()
    expect(reads.n).toBe(1)
    expect(s.rowFor(rows[1].id)).toMatchObject({ sku: 'GALE-B2', state: 'refused', reason: 'SKU "GALE-B2" already exists' })
    // The read lands the created rows; the refused row stays, and a Reload keeps it too (its SKU and sentence are the person's).
    s.landed(new Set(['b1', 'b3']))
    s.clear()
    expect(s.getSnapshot().map((r) => [r.sku, r.state])).toEqual([['GALE-B2', 'refused']])
  })

  it('F8 (browser check 2026-10-05): a refusal is said at once in the sheet\'s toast — once per distinct sentence in a batch; a lost answer is not', async () => {
    const family409 = 'This family changed during the operation. Reload it and review the action again.'
    const refuse = async (): Promise<CreateOutcome> => ({ ok: false, reason: family409 })
    const { s, said } = store({ api: { createVariation: refuse, createAlias: refuse } })
    const rows = s.add('variation', 3)
    s.paste(rows[0].id, ['GALE-C1', 'GALE-C2', 'GALE-C3'])
    await vi.waitFor(() => expect(s.busy).toBe(false))
    expect(s.getSnapshot().map((r) => r.state)).toEqual(['refused', 'refused', 'refused'])
    expect(said.filter((m) => m.tone === 'danger')).toEqual([{ message: family409, tone: 'danger' }])
    // A new batch says it again.
    s.type(rows[0].id, 'GALE-C4')
    await vi.waitFor(() => expect(s.busy).toBe(false))
    expect(said.filter((m) => m.tone === 'danger')).toHaveLength(2)
  })

  it('F8: the client\'s own refusal is said too — two rows of one paste refused for one reason, one toast', () => {
    const { s, said, calls } = store()
    const rows = s.add('variation', 2)
    s.paste(rows[0].id, ['GALE-M', 'gale-m'])
    expect(calls).toHaveLength(0)
    expect(said.filter((m) => m.tone === 'danger')).toEqual([{ message: 'GALE-M is already in this family.', tone: 'danger' }])
  })

  it('F8: a lost answer keeps its own words on the row and is not toasted', async () => {
    const { s, calls, said } = store()
    const [row] = s.add('variation', 1)
    s.type(row.id, 'GALE-L')
    calls[0].settle({ ok: false, reason: 'Failed to fetch', unknown: true })
    await flush()
    expect(s.rowFor(row.id)?.state).toBe('unknown')
    expect(said).toEqual([])
  })

  it('refuses the second of two rows given the same SKU in one paste, without sending it', () => {
    const { s, calls } = store()
    const rows = s.add('variation', 2)
    s.paste(rows[0].id, ['GALE-L', 'gale-l'])
    expect(calls).toHaveLength(1)
    expect(s.rowFor(rows[1].id)?.reason).toBe('GALE-L is already typed into another new row.')
  })
})

describe('removing and clearing', () => {
  it('removes an empty row by its button or the Delete key, never a create on its way', () => {
    const { s } = store()
    const [a, b, c] = s.add('variation', 3)
    expect(s.remove(a.id)).toBe(true)
    expect(s.cellKey(b.id, 'Backspace')).toBe(false)
    expect(s.cellKey(b.id, 'Delete')).toBe(true)
    s.type(c.id, 'GALE-L')
    expect(s.remove(c.id)).toBe(false)
    expect(s.cellKey(c.id, 'Delete')).toBe(false)
    expect(s.getSnapshot().map((r) => r.id)).toEqual([c.id])
    expect(s.cellKey('primary:p1', 'Delete')).toBe(false)
  })
  it('a reload drops the untyped empty rows; a create on its way (its answer still lands) and a refused row (its SKU and sentence) stay', () => {
    const { s } = store()
    const [a, b, c] = s.add('variation', 3)
    s.type(b.id, 'GALE-L')
    s.type(c.id, 'gale-m')
    expect(s.rowFor(c.id)?.state).toBe('refused')
    s.clear()
    expect(s.getSnapshot().map((r) => r.id)).toEqual([b.id, c.id])
    expect(s.rowFor(a.id)).toBeUndefined()
  })
  it('tells its subscribers about every change, and only then', () => {
    const { s } = store()
    const seen = vi.fn()
    const off = s.subscribe(seen)
    const [row] = s.add('variation', 1)
    s.landed(new Set(['nothing']))
    s.remove(row.id)
    off()
    s.add('variation', 1)
    expect(seen).toHaveBeenCalledTimes(2)
  })
})

describe('the wire', () => {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  function stubFetch(...answers: Array<Response | Error>) {
    const sent: Array<{ url: string; key: string | null; body: any }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      sent.push({ url, key: new Headers(init.headers).get('Idempotency-Key'), body: JSON.parse(String(init.body)) })
      const answer = answers.shift()
      if (!answer) throw new Error('unexpected request')
      if (answer instanceof Error) throw answer
      return answer
    }))
    return sent
  }
  afterEach(() => vi.unstubAllGlobals())

  it('a variation: one key per row, kept after a lost answer and dropped after the answer', async () => {
    const sent = stubFetch(new TypeError('Failed to fetch'), json(201, { success: true, data: { id: 'child-1' } }), json(201, { success: true, data: { id: 'child-2' } }))
    const input = { parentId: 'parent', sku: 'GALE-L', name: 'Gale jacket', slot: 'new-row:wire-1' }
    expect(await sheetNewRowsApi.createVariation(input)).toEqual({ ok: false, reason: 'Failed to fetch', unknown: true })
    expect(await sheetNewRowsApi.createVariation(input)).toEqual({ ok: true, id: 'child-1' })
    await sheetNewRowsApi.createVariation({ ...input, slot: 'new-row:wire-2' })
    expect(sent[0].url).toBe('http://api.test/api/catalog/products/parent/children')
    expect(sent[0].body).toEqual({ sku: 'GALE-L', name: 'Gale jacket' })
    expect(sent[0].key).toBeTruthy()
    expect(sent[1].key).toBe(sent[0].key)
    expect(sent[2].key).not.toBe(sent[0].key)
  })

  it('a variation refusal: the server\'s words, and the key is released (not a lost answer)', async () => {
    stubFetch(json(409, { success: false, error: { code: 'DUPLICATE_SKU', message: 'SKU "GALE-L" already exists' } }))
    expect(await sheetNewRowsApi.createVariation({ parentId: 'parent', sku: 'GALE-L', name: 'Gale', slot: 'new-row:wire-3' }))
      .toEqual({ ok: false, reason: 'SKU "GALE-L" already exists', unknown: false })
  })

  it('a listing alias: sends the SKU (also its name) with the account, keyed by the row; a refusal keeps the server\'s sentence', async () => {
    const sent = stubFetch(json(201, { id: 'alias-9', sku: 'IT-GALE-2' }),
      json(409, { error: 'SKU_TAKEN', message: 'IT-GALE-3 is already the SKU of OTHER on this eBay account (eBay IT).' }))
    expect(await sheetNewRowsApi.createAlias({ productId: 'parent', channel: 'EBAY', marketplace: 'IT', accountId: 'acc-b', sku: 'IT-GALE-2', slot: 'new-row:wire-4' }))
      .toEqual({ ok: true, id: 'alias-9' })
    expect(sent[0].url).toBe('http://api.test/api/products/parent/aliases')
    expect(sent[0].body).toEqual({ channel: 'EBAY', marketplace: 'IT', accountId: 'acc-b', label: 'IT-GALE-2', sku: 'IT-GALE-2' })
    expect(sent[0].key).toBeTruthy()
    expect(await sheetNewRowsApi.createAlias({ productId: 'parent', channel: 'EBAY', marketplace: 'IT', accountId: 'acc-b', sku: 'IT-GALE-3', slot: 'new-row:wire-5' }))
      .toEqual({ ok: false, reason: 'IT-GALE-3 is already the SKU of OTHER on this eBay account (eBay IT).', unknown: false })
  })

  it('a listing alias whose answer is lost is not confirmed', async () => {
    stubFetch(new TypeError('Failed to fetch'))
    expect(await sheetNewRowsApi.createAlias({ productId: 'parent', channel: 'EBAY', marketplace: 'IT', sku: 'IT-GALE-4', slot: 'new-row:wire-6' }))
      .toEqual({ ok: false, reason: 'Failed to fetch', unknown: true })
  })

  it('the scope guard words', () => {
    expect(NEW_ROWS_WORDS.wait).toBe('New rows are being created. Wait for them, then change the view.')
  })
})

describe('the scope\'s answers and the grid\'s keys and paste', () => {
  it('a variation is created under the family\'s parent only, with edit rights', () => {
    expect(variationTarget({ id: 'p', name: 'Gale', isParent: true }, true)).toEqual({ kind: 'variation', parentId: 'p', parentName: 'Gale' })
    expect(variationTarget({ id: 'p', name: null, childCount: 2 }, true)).toEqual({ kind: 'variation', parentId: 'p', parentName: '' })
    expect(variationTarget({ id: 'solo', name: 'Solo', isParent: false, childCount: 0 }, true)).toEqual({ refused: NEW_ROWS_WORDS.noParent })
    expect(variationTarget(null, true)).toEqual({ refused: NEW_ROWS_WORDS.noParent })
    expect(variationTarget({ id: 'p', name: 'Gale', isParent: true }, false)).toEqual({ refused: NEW_ROWS_WORDS.noPermission })
  })

  it('a listing (alias) is created on this channel · market · account; with none connected, the server\'s words', () => {
    const base = { productId: 'p', channel: 'EBAY' as const, marketplace: 'IT', canEdit: true }
    expect(aliasTarget({ ...base, accountId: 'acc', noAccount: false })).toEqual({ kind: 'alias', productId: 'p', channel: 'EBAY', marketplace: 'IT', accountId: 'acc' })
    expect(aliasTarget({ ...base, noAccount: false })).toEqual({ kind: 'alias', productId: 'p', channel: 'EBAY', marketplace: 'IT' })
    expect(aliasTarget({ ...base, noAccount: true })).toEqual({ refused: 'Connect an eBay account before adding a listing on IT.' })
    expect(aliasTarget({ ...base, channel: 'AMAZON', marketplace: 'DE', noAccount: true })).toEqual({ refused: 'Connect an Amazon account before adding a listing on DE.' })
    expect(aliasTarget({ ...base, noAccount: false, canEdit: false })).toEqual({ refused: NEW_ROWS_WORDS.noPermission })
  })

  const gridApi = (editing = 0) => ({ getEditingCells: vi.fn(() => Array.from({ length: editing })), startEditingCell: vi.fn() })
  const keyEvent = (key: string) => ({ key, preventDefault: vi.fn() }) as unknown as KeyboardEvent

  it('Enter on an empty row\'s SKU cell starts typing it; Delete removes the row; nothing while a cell is being edited', () => {
    const { s } = store()
    const [a, b] = s.add('variation', 2)
    const sku = { getColId: () => 'ag-Grid-AutoColumn' }
    const name = { getColId: () => 'name' }
    const api = gridApi()
    expect(newRowsGridKey(s, { data: sharedNewRow(a, 'parent'), column: sku, rowIndex: 4, event: keyEvent('Enter'), api })).toBe(true)
    expect(api.startEditingCell).toHaveBeenCalledWith({ rowIndex: 4, colKey: 'ag-Grid-AutoColumn' })
    // Enter on a locked cell is the sheet's (it says why the cell is locked).
    expect(newRowsGridKey(s, { data: sharedNewRow(a, 'parent'), column: name, rowIndex: 4, event: keyEvent('Enter'), api })).toBe(false)
    expect(newRowsGridKey(s, { data: sharedNewRow(b, 'parent'), column: sku, rowIndex: 5, event: keyEvent('Delete'), api: gridApi(1) })).toBe(false)
    expect(newRowsGridKey(s, { data: sharedNewRow(b, 'parent'), column: name, rowIndex: 5, event: keyEvent('Delete'), api })).toBe(true)
    expect(s.getSnapshot().map((r) => r.id)).toEqual([a.id])
    // A real row is never this handler's.
    expect(newRowsGridKey(s, { data: { id: 'p1' }, column: sku, rowIndex: 0, event: keyEvent('Enter'), api })).toBe(false)
  })

  it('a paste on an empty row\'s SKU cell fills the empty rows and the grid pastes nothing; any other paste is the sheet\'s', () => {
    const { s, calls } = store()
    const rows = s.add('variation', 2)
    const next = vi.fn((p: { data: string[][] }) => p.data)
    const paste = newRowsPaste(s, next)
    const displayed = [{ data: { id: 'p1' } }, { data: sharedNewRow(rows[0], 'parent') }, { data: sharedNewRow(rows[1], 'parent') }]
    const api = (rowIndex: number, colId: string) => ({ getFocusedCell: () => ({ rowIndex, column: { getColId: () => colId } }), getDisplayedRowAtIndex: (i: number) => displayed[i] })
    expect(paste({ data: [['GALE-L'], ['GALE-XL']], api: api(1, 'ag-Grid-AutoColumn') })).toBeNull()
    // Both rows take their SKU at once; the creates go one after another (the second waits for the first's answer).
    expect(s.getSnapshot().map((r) => [r.sku, r.state])).toEqual([['GALE-L', 'saving'], ['GALE-XL', 'saving']])
    expect(calls.map((c) => c.input.sku)).toEqual(['GALE-L'])
    expect(next).not.toHaveBeenCalled()
    expect(paste({ data: [['x']], api: api(0, 'ag-Grid-AutoColumn') })).toEqual([['x']])
    expect(paste({ data: [['x']], api: api(1, 'name') })).toEqual([['x']])
    expect(next).toHaveBeenCalledTimes(2)
  })
})

describe('after "Add rows", and the cell menu of an empty row', () => {
  /** A grid whose rows arrive after `arriveAt` frames and whose SKU cell is drawn after `drawAt` frames. */
  function grid(opts: { arriveAt?: number; drawAt?: number; collapsed?: boolean } = {}) {
    const frames: Array<() => void> = []
    let frame = 0
    const parent = { level: 0, rowIndex: 0 as number | null, expanded: !opts.collapsed, setExpanded: vi.fn((e: boolean) => { parent.expanded = e }), parent: { level: -1, rowIndex: null } }
    const node: LandingRowNode = { id: 'new-row:x', rowIndex: 7, parent }
    const api = {
      getRowNode: vi.fn((id: string) => (frame >= (opts.arriveAt ?? 1) && id === node.id ? node : undefined)),
      ensureIndexVisible: vi.fn(), ensureColumnVisible: vi.fn(), setFocusedCell: vi.fn(), isDestroyed: () => false,
    }
    const root = { querySelector: vi.fn(() => (frame >= (opts.drawAt ?? 1) ? {} : null)) } as unknown as ParentNode
    const run = () => { while (frames.length) { frame++; frames.shift()!() } }
    return { api, root, run, schedule: (fn: () => void) => { frames.push(fn) }, parent }
  }

  it('focuses the first new row\'s SKU cell, scrolled into view, once the grid holds the row and has drawn the cell', () => {
    const g = grid({ arriveAt: 3, drawAt: 5, collapsed: true })
    focusNewRow(g.api, 'new-row:x', { schedule: g.schedule, root: g.root, active: () => null })
    g.run()
    expect(g.parent.setExpanded).toHaveBeenCalledWith(true)
    expect(g.api.ensureIndexVisible).toHaveBeenCalledWith(7)
    expect(g.api.ensureColumnVisible).toHaveBeenCalledWith('ag-Grid-AutoColumn', 'auto')
    // Set until the cell was drawn before it, so the browser's focus lands in the cell, not only the grid's cursor.
    expect(g.api.setFocusedCell).toHaveBeenLastCalledWith(7, 'ag-Grid-AutoColumn')
    expect(g.api.setFocusedCell.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('gives up quietly when the row never arrives, and never takes focus the person moved elsewhere', () => {
    const lost = grid({ arriveAt: 99 })
    focusNewRow(lost.api, 'new-row:x', { schedule: lost.schedule, root: lost.root, active: () => null })
    lost.run()
    expect(lost.api.getRowNode).toHaveBeenCalledTimes(NEW_ROW_FOCUS_FRAMES)
    expect(lost.api.setFocusedCell).not.toHaveBeenCalled()
    const busy = grid()
    const input = { closest: () => null } as unknown as Element
    focusNewRow(busy.api, 'new-row:x', { schedule: busy.schedule, root: busy.root, active: () => input })
    busy.run()
    expect(busy.api.setFocusedCell).not.toHaveBeenCalled()
  })

  it('may move focus from the page, the grid, or the Add rows control in the footer\'s start slot', () => {
    const at = (selector: string | null) => ({ closest: (s: string) => (selector && s.includes(selector) ? {} : null) }) as unknown as Element
    expect(focusMayMove(null)).toBe(true)
    expect(focusMayMove(at('.ag-root-wrapper'))).toBe(true)
    expect(focusMayMove(at('.nds-grid-sheet-status-start'))).toBe(true)
    expect(focusMayMove(at(null))).toBe(false)
  })

  it('"Add rows" adds the rows, then focuses the FIRST new one; a refused kind focuses nothing', () => {
    const { s } = store({ targets: { alias: { refused: 'No account.' } } })
    const focus = vi.fn()
    const api = grid().api
    const added = addRowsAndFocus(s, 'variation', 3, api, focus)
    expect(added).toHaveLength(3)
    expect(focus).toHaveBeenCalledOnce()
    expect(focus).toHaveBeenCalledWith(api, added[0].id)
    expect(addRowsAndFocus(s, 'alias', 2, api, focus)).toEqual([])
    expect(focus).toHaveBeenCalledOnce()
    // No grid yet (still loading): the rows are added, nothing to focus.
    expect(addRowsAndFocus(s, 'variation', 1, null, focus)).toHaveLength(1)
  })

  it('an empty row\'s cell menu holds only "Remove this row" (nothing while its create is on its way); a real row\'s is the sheet\'s', () => {
    const { s } = store()
    const [a, b] = s.add('variation', 2)
    const next = vi.fn(() => ['copy', 'Cell details…'])
    const menu = newRowsContextMenu(s, next)
    const items = menu({ node: { data: sharedNewRow(a, 'parent') } })
    expect(items).toEqual([{ name: 'Remove this row', action: expect.any(Function) }])
    ;(items[0] as { action: () => void }).action()
    expect(s.rowFor(a.id)).toBeUndefined()
    s.type(b.id, 'GALE-L')
    expect(menu({ node: { data: sharedNewRow(s.rowFor(b.id)!, 'parent') } })).toEqual([])
    expect(next).not.toHaveBeenCalled()
    expect(menu({ node: { data: { id: 'p1' } } })).toEqual(['copy', 'Cell details…'])
  })
})
