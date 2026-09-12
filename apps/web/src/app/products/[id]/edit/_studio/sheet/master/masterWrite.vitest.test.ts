import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { commitMasterRow, type MasterCommitContext } from './masterWrite'
import type { SheetColumn, StudioSheet, StudioRow } from './types'
import type { SheetWriteRequest } from '@/design-system/grid'

/*
 * The master sheet's write path. It had NO tests at all — it was declared inside the hook and was
 * therefore unreachable, while its twin `commitChannelRow` was module-level with
 * `channelWrite.vitest.test.ts` beside it (FE.1's finding, hub #348). Same operation, two lanes.
 *
 * These probe the SEAMS a reading of the source does not settle: which endpoint a cell routes to,
 * what a 409 does to the version, what a 200 carrying per-cell `errors[]` reports, and the two
 * places where this function INFERS rather than reads.
 */

const col = (key: string, over: Partial<SheetColumn> = {}): SheetColumn =>
  ({ key, label: key, group: 'g', requiredBy: [], storage: 'categoryAttributes', ...over } as SheetColumn)

const sheet = {
  // The coordinate the sheet was on — the write is validated against the schema that declared the
  // columns, so the caller hands the same scope back.
  scope: { kind: 'master', label: 'Master · DE', marketplace: 'DE', locale: 'it' },
  columns: [
    col('name', { storage: 'column', writeField: 'name' }),
    col('attr_colour'),
    col('description', { storage: 'localizedContent' }),
  ],
} as unknown as StudioSheet

const ctx = (over: Partial<MasterCommitContext> = {}): MasterCommitContext =>
  ({ sheet, opts: {}, locale: 'it', market: 'DE', ...over })

const req = (cells: SheetWriteRequest<StudioRow>['cells'], over: Partial<SheetWriteRequest<StudioRow>> = {}) =>
  ({ rowId: 'p1', row: {} as StudioRow, cells, ...over }) as SheetWriteRequest<StudioRow>

const json = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body })

/**
 * `SheetWriteResult.cells` is optional on the contract, and a commit that returned NO per-cell
 * outcomes would be a real defect — the writer would have nothing to paint. So this asserts rather
 * than using `!`: every test below is entitled to per-cell outcomes, and if one goes missing the
 * failure should say that, not read as an undefined-property crash somewhere downstream.
 */
const cellsOf = (r: { cells?: Record<string, { ok: boolean; reason?: string }> }) => {
  if (!r.cells) throw new Error('commitMasterRow returned no per-cell outcomes')
  return r.cells
}

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

describe('commitMasterRow — routing', () => {
  it('reports the actual per-field validation error from a refused bulk request', async () => {
    fetchMock.mockResolvedValue(json(400, { errors: [{ id: 'p1', field: 'attr_colour', error: 'Composition percentages must total 100' }] }))
    const result = await commitMasterRow(req([{ colId: 'attr_colour', value: [] }] as never), ctx())
    expect(cellsOf(result).attr_colour).toEqual({ ok: false, reason: 'Composition percentages must total 100' })
  })
  it('sends Product columns and attr_* to the bulk endpoint, and a locale slot to the global patch', async () => {
    fetchMock.mockResolvedValue(json(200, { errors: [] }))
    await commitMasterRow(req([
      { colId: 'name', value: 'Jacket' },
      { colId: 'description', value: 'Ciao' },
    ] as never), ctx())

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [bulkUrl, bulkInit] = fetchMock.mock.calls[0]
    const [globalUrl, globalInit] = fetchMock.mock.calls[1]
    expect(String(bulkUrl)).toContain('/api/products/bulk')
    expect(String(globalUrl)).toContain('/api/products/p1/global')
    // 🔴 The locale slot is keyed by the CONTEXT's locale, not by the column key.
    expect(JSON.parse(globalInit.body).patch).toEqual({ it: { description: 'Ciao' } })
    expect(JSON.parse(bulkInit.body).changes).toEqual([{ id: 'p1', field: 'name', value: 'Jacket' }])
  })

  it('🔴 sends the SHEET\'s marketplace context — without it every attr_* write is refused', async () => {
    /*
     * The Owner's "I'm unable to write a lot of attributes still, such as color". The server
     * validates each `attr_*` with `getFieldDefinition(field, { marketplace })`, and this body
     * carried no contexts — so every master attribute arrived with `marketplace: null` and came
     * back 400 "Unknown or read-only category attribute". SC.1 measured 60 of 60 refused on master
     * DE/de against 57 accepted on Amazon·DE; the channel writer sent its contexts, this one did not.
     *
     * 🔴 All 21 tests in this file passed while that was true. They asserted the shape of `changes`
     * and never the ENVELOPE around it, so the one field whose absence refused every write was the
     * one field nothing looked at.
     */
    fetchMock.mockResolvedValue(json(200, { errors: [] }))
    await commitMasterRow(req([{ colId: 'attr_colour', value: 'Black' }] as never), ctx())
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).marketplaceContexts)
      .toEqual([{ marketplace: 'DE', locale: 'it' }])
  })

  it('omits the context rather than inventing one when there is no marketplace', async () => {
    // A guessed marketplace would validate the write against a schema the server never used.
    fetchMock.mockResolvedValue(json(200, { errors: [] }))
    await commitMasterRow(req([{ colId: 'attr_colour', value: 'Black' }] as never), ctx({ market: '' }))
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty('marketplaceContexts')
  })

  it('writes the server-supplied writeField, never the column key', async () => {
    fetchMock.mockResolvedValue(json(200, { errors: [] }))
    const s = { columns: [col('brandName', { storage: 'column', writeField: 'brand' })] } as unknown as StudioSheet
    await commitMasterRow(req([{ colId: 'brandName', value: 'Gale' }] as never), ctx({ sheet: s }))
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).changes[0].field).toBe('brand')
  })

  it('makes no request at all when the batch has no cells', async () => {
    await commitMasterRow(req([] as never), ctx())
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('commitMasterRow — a reset and an empty string both mean "store nothing"', () => {
  it('sends null for both', async () => {
    fetchMock.mockResolvedValue(json(200, { errors: [] }))
    await commitMasterRow(req([
      { colId: 'name', intent: 'reset', value: 'ignored' },
      { colId: 'attr_colour', value: '' },
    ] as never), ctx())
    const changes = JSON.parse(fetchMock.mock.calls[0][1].body).changes
    expect(changes.map((c: { value: unknown }) => c.value)).toEqual([null, null])
  })
})

describe('commitMasterRow — a reset and an empty string mean "store nothing" on BOTH routes', () => {
  it('the localized reset removes its own slot so inheritance can resume', () => {
    // The bulk route was covered and this one was not, so deleting the whole ternary here kept the
    // suite green. A reset that silently wrote the string "" into a locale slot would look like a
    // successful save and read back as an empty translation rather than an absent one.
    fetchMock.mockResolvedValue(json(200, {}))
    return commitMasterRow(req([
      { colId: 'description', intent: 'reset', value: 'ignored' },
    ] as never), ctx()).then(() => {
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ patch: { it: {} }, reset: { it: ['description'] } })
    })
  })

  it('and an empty string on the localized route is null, not ""', async () => {
    fetchMock.mockResolvedValue(json(200, {}))
    await commitMasterRow(req([{ colId: 'description', value: '' }] as never), ctx())
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).patch).toEqual({ it: { description: null } })
  })
})

describe('commitMasterRow — the concurrency guard', () => {
  it('omits expectedVersion when unknown rather than guessing one', async () => {
    // A guessed version refuses a write the operator is entitled to make; absent means "no guard".
    fetchMock.mockResolvedValue(json(200, { errors: [] }))
    await commitMasterRow(req([{ colId: 'name', value: 'x' }] as never), ctx())
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty('expectedVersion')
  })

  it('reports a 409 as a CONFLICT, carries the server version, and refuses every cell', async () => {
    fetchMock.mockResolvedValue(json(409, { currentVersion: 12 }))
    const r = await commitMasterRow(req([{ colId: 'name', value: 'x' }] as never, { expectedVersion: 7 }), ctx())
    expect(r.conflict).toBe(true)
    expect(r.version).toBe(12)
    expect(r.ok).toBe(false)
    expect(cellsOf(r).name.ok).toBe(false)
    expect(cellsOf(r).name.reason).toMatch(/Someone else changed this row/)
  })

  it('🔴 does NOT infer a version the server did not answer — read back or keep what you read', () => {
    /*
     * This test previously asserted the OPPOSITE — that `expectedVersion + 1` was correct — and it
     * passed for hours. The route was doing the same arithmetic on its own side, so two independent
     * guesses agreed and looked like corroboration. **Two guesses agreeing is not a measurement.**
     *
     * A computed version is the banked `Product.version` ≠ row version trap: it can lose a race it
     * should have won, or win one it should have lost.
     */
    fetchMock.mockResolvedValue(json(200, { errors: [] }))
    return commitMasterRow(req([{ colId: 'name', value: 'x' }] as never, { expectedVersion: 7 }), ctx())
      .then((r) => expect(r.version).toBeUndefined())
  })

  it('prefers the server’s currentVersion over the inference when both are available', async () => {
    fetchMock.mockResolvedValue(json(200, { errors: [], currentVersion: 41 }))
    const r = await commitMasterRow(req([{ colId: 'name', value: 'x' }] as never, { expectedVersion: 7 }), ctx())
    expect(r.version).toBe(41)
  })

  it('infers NOTHING when no version was sent — there was no guard to advance', async () => {
    fetchMock.mockResolvedValue(json(200, { errors: [] }))
    const r = await commitMasterRow(req([{ colId: 'name', value: 'x' }] as never), ctx())
    expect(r.version).toBeUndefined()
  })
})

describe('commitMasterRow — a 200 can still refuse individual cells', () => {
  it('matches a per-cell error by writeField OR colId and leaves its neighbours ok', async () => {
    fetchMock.mockResolvedValue(json(200, {
      errors: [{ id: 'p1', field: 'name', error: 'Too long' }],
    }))
    const r = await commitMasterRow(req([
      { colId: 'name', value: 'x' },
      { colId: 'attr_colour', value: 'red' },
    ] as never), ctx())
    expect(cellsOf(r).name).toEqual({ ok: false, reason: 'Too long' })
    expect(cellsOf(r).attr_colour).toEqual({ ok: true })
  })

  it('ignores an error belonging to a DIFFERENT row', async () => {
    fetchMock.mockResolvedValue(json(200, { errors: [{ id: 'p2', field: 'name', error: 'not mine' }] }))
    const r = await commitMasterRow(req([{ colId: 'name', value: 'x' }] as never), ctx())
    expect(cellsOf(r).name).toEqual({ ok: true })
  })

  it('🔴 never reports a failure without a message (ruling #27)', async () => {
    // The header renders the reporter's message verbatim. A 200 carrying per-cell refusals has no
    // batch-level reason at all, so reporting `undefined` would say a write failed without saying
    // why. The per-cell reason is the fallback.
    const onWriteEnd = vi.fn()
    fetchMock.mockResolvedValue(json(200, { errors: [{ id: 'p1', field: 'name', error: 'Too long' }] }))
    await commitMasterRow(req([{ colId: 'name', value: 'x' }] as never), ctx({ opts: { onWriteEnd } }))
    const [, ok, message] = onWriteEnd.mock.calls[0]
    expect(ok).toBe(false)
    expect(message).toBe('Too long')
  })
})

describe('commitMasterRow — failures and reporting', () => {
  it('reports an HTTP refusal with the server’s own error text', async () => {
    fetchMock.mockResolvedValue(json(422, { error: 'Brand is not on the allow list' }))
    const r = await commitMasterRow(req([{ colId: 'name', value: 'x' }] as never), ctx())
    expect(r.reason).toBe('Brand is not on the allow list')
    expect(cellsOf(r).name.ok).toBe(false)
  })

  it('keeps an unavailable server acknowledgement unconfirmed until a recovery read', async () => {
    fetchMock.mockResolvedValue(json(500, null))
    const r = await commitMasterRow(req([{ colId: 'name', value: 'x' }] as never), ctx())
    expect(r.reason).toMatch(/confirmation was unavailable/i)
    expect(r.unreachable).toBe(true)
  })

  it('does not treat malformed success JSON as proof that a write saved', async () => {
    fetchMock.mockResolvedValue(json(200, {}))
    expect(await commitMasterRow(req([{ colId: 'name', value: 'x' }] as never), ctx())).toMatchObject({ ok: false, unreachable: true })
  })

  it('a thrown fetch refuses EVERY cell in the batch and still closes the write', async () => {
    const onWriteEnd = vi.fn()
    fetchMock.mockRejectedValue(new Error('Failed to fetch'))
    const r = await commitMasterRow(req([
      { colId: 'name', value: 'x' },
      { colId: 'description', value: 'y' },
    ] as never), ctx({ opts: { onWriteEnd } }))
    expect(r.ok).toBe(false)
    expect(cellsOf(r).name.reason).toBe('Failed to fetch')
    expect(cellsOf(r).description.reason).toBe('Failed to fetch')
    // A write that never closes leaves the row latched — the P2-1 failure, one level up.
    // The 4th argument is the ROW the write was about (#693): the header counts rows with unsaved
    // work, and a refusal that did not name its row could never be cleared by that row succeeding.
    expect(onWriteEnd).toHaveBeenCalledWith(expect.any(String), false, 'Failed to fetch', 'p1')
  })

  /* ── `versionOf` (#701) ────────────────────────────────────────────────────────────────────
   * `currentVersion` is only the PRODUCT's when the route says so. A channel-only response carries
   * the LISTING's version, and storing that as the product's poisons the row: every later write
   * sends a version the product never had and comes back 409 "someone else changed this row".
   * Not reachable on the master sheet today — every response measured on 2026-09-02 said
   * `versionOf: "product"`, including an `attr_*` write with `marketplaceContexts`. These pin the
   * guard so it stays true when it becomes reachable. */
  it('🔴 a channelListing version is NOT taken as the product version (200)', async () => {
    fetchMock.mockResolvedValue(json(200, { errors: [], currentVersion: 99, versionOf: 'channelListing' }))
    const r = await commitMasterRow(req([{ colId: 'name', value: 'x' }] as never), ctx())
    expect(r.ok).toBe(true)
    expect(r.version).toBeUndefined() // the caller keeps the version it already held
  })

  it('🔴 a channelListing version is NOT taken as the product version (409)', async () => {
    fetchMock.mockResolvedValue(json(409, { currentVersion: 99, versionOf: 'channelListing' }))
    const r = await commitMasterRow(req([{ colId: 'name', value: 'x' }] as never), ctx())
    expect(r.conflict).toBe(true)
    expect(r.version).toBeUndefined()
  })

  it('a product version IS taken, on both branches', async () => {
    fetchMock.mockResolvedValue(json(200, { errors: [], currentVersion: 42, versionOf: 'product' }))
    expect((await commitMasterRow(req([{ colId: 'name', value: 'x' }] as never), ctx())).version).toBe(42)
    fetchMock.mockResolvedValue(json(409, { currentVersion: 43, versionOf: 'product' }))
    expect((await commitMasterRow(req([{ colId: 'name', value: 'x' }] as never), ctx())).version).toBe(43)
  })

  it('an ABSENT versionOf is treated as the product — what the route omits it for', async () => {
    fetchMock.mockResolvedValue(json(200, { errors: [], currentVersion: 7 }))
    expect((await commitMasterRow(req([{ colId: 'name', value: 'x' }] as never), ctx())).version).toBe(7)
    fetchMock.mockResolvedValue(json(409, { currentVersion: 8 }))
    expect((await commitMasterRow(req([{ colId: 'name', value: 'x' }] as never), ctx())).version).toBe(8)
  })

  it('a no-op 200 still teaches the fresh version — the measured #689 shape', async () => {
    // {updated:0, unchanged:1, expectedVersion:34, currentVersion:35, versionOf:'product'} — the
    // real body captured off the sheet at 15:07:12.
    fetchMock.mockResolvedValue(json(200, { success: true, updated: 0, unchanged: 1, expectedVersion: 34, currentVersion: 35, versionOf: 'product' }))
    const r = await commitMasterRow(req([{ colId: 'name', value: 'x' }] as never), ctx())
    expect(r.ok).toBe(true)
    expect(r.version).toBe(35)
  })

  it('opens and closes the write with the SAME id, and names the SAME row (#693)', async () => {
    const onWriteStart = vi.fn()
    const onWriteEnd = vi.fn()
    fetchMock.mockResolvedValue(json(200, { errors: [] }))
    await commitMasterRow(req([{ colId: 'name', value: 'x' }] as never), ctx({ opts: { onWriteStart, onWriteEnd } }))
    expect(onWriteStart.mock.calls[0][0]).toBe(onWriteEnd.mock.calls[0][0])
    // 🔴 The row id is passed, never parsed back out of the write id: `masterWrite` builds
    // `${rowId}:${Date.now()}`, but the channel sheet and the image workspace build theirs
    // differently, so a frame that split on ':' would be guessing at two of its three callers.
    expect(onWriteStart.mock.calls[0][1]).toBe('p1')
    expect(onWriteEnd.mock.calls[0][3]).toBe('p1')
  })

  it('surfaces a localized-route refusal with the first detail', async () => {
    fetchMock
      .mockResolvedValueOnce(json(200, { errors: [] }))
      .mockResolvedValueOnce(json(400, { details: ['description must be under 2000 characters'] }))
    const r = await commitMasterRow(req([
      { colId: 'name', value: 'x' },
      { colId: 'description', value: 'y' },
    ] as never), ctx())
    expect(cellsOf(r).name).toEqual({ ok: true })
    expect(cellsOf(r).description.reason).toBe('description must be under 2000 characters')
  })

  it('uses the returned bulk version for a subsequent localized edit', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { errors: [], currentVersion: 8, versionOf: 'product' }))
      .mockResolvedValueOnce(json(200, { currentVersion: 9, versionOf: 'product' }))
    const result = await commitMasterRow(req([{ colId: 'name', value: 'x' }, { colId: 'description', value: 'y' }] as never, { expectedVersion: 7 }), ctx())
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).expectedVersion).toBe(8)
    expect(result.version).toBe(9)
  })
})

describe('commitMasterRow — a PARTIAL success is reported as progress, not as a failure', () => {
  it('🔴 returns ok:true when some cells landed, while each refused cell stays refused', async () => {
    // Deliberate: `ok || anyOk`. The row DID move, so the writer must advance rather than replay —
    // but the operator must still see which cells did not land. Reporting the batch as a flat
    // failure would re-send writes the server already accepted.
    fetchMock.mockResolvedValue(json(200, { errors: [{ id: 'p1', field: 'name', error: 'Too long' }] }))
    const r = await commitMasterRow(req([
      { colId: 'name', value: 'x' },
      { colId: 'attr_colour', value: 'red' },
    ] as never), ctx())
    expect(r.ok).toBe(true)
    expect(cellsOf(r).name.ok).toBe(false)
    expect(cellsOf(r).attr_colour.ok).toBe(true)
  })

  it('returns ok:false when EVERY cell was refused', async () => {
    fetchMock.mockResolvedValue(json(200, {
      errors: [{ id: 'p1', field: 'name', error: 'Too long' }, { id: 'p1', field: 'attr_colour', error: 'Bad' }],
    }))
    const r = await commitMasterRow(req([
      { colId: 'name', value: 'x' },
      { colId: 'attr_colour', value: 'red' },
    ] as never), ctx())
    expect(r.ok).toBe(false)
  })
})
