import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('./referenceOptions', () => ({ isReferenceField: (key: string) => key === 'descriptionThemeId', loadReferenceChoices: vi.fn() }))
import { loadReferenceChoices } from './referenceOptions'
import { CellSaveTracker } from '@/design-system/grid/editors/roundTrip'
import { recoverSheetRow, unconfirmedIn } from './sheetRecovery'

const scope = { channel: 'EBAY', market: 'IT', locale: 'it', accountId: 'account' }
const cell = (value: unknown, pinned = true) => ({ value, pinned, follows: !pinned, writeTarget: 'channelListing', writeField: 'title' })
const request = () => ({ rowId: 'alias:child', row: { id: 'child', version: 3, aliasId: 'alias', listing: { id: 'listing', version: 7 }, values: { title: cell('Typed') } }, cells: [{ colId: 'title', value: 'Typed', intent: 'set' as const }] })
const body = () => ({ scope: { kind: 'channel', channel: 'EBAY', marketplace: 'IT', locale: 'it', connectionId: 'account' }, rows: [{ id: 'child', version: 4, aliasId: 'alias', listing: { id: 'listing', version: 8 }, values: { title: cell('Typed') } }] })
beforeEach(() => vi.resetAllMocks())

describe('scoped save recovery', () => {
  it('reads the exact alias and advances the listing token while preserving local typing', async () => {
    const req = request(), page = body()
    page.rows.unshift({ ...page.rows[0], aliasId: 'another', listing: { id: 'other-listing', version: 99 }, values: { title: cell('Wrong alias') } })
    const result = await recoverSheetRow(page, req, scope)
    expect(result).toMatchObject({ version: 4, matches: { title: true } })
    expect(req.row.listing.version).toBe(8)
    expect(req.row.values.title.value).toBe('Typed')
  })
  it.each([{ accountId: 'another' }, { market: 'DE' }, { channel: 'AMAZON' }, { locale: 'en' }])('rejects a response from a different coordinate %j', async mismatch => {
    expect(await recoverSheetRow(body(), request(), { ...scope, ...mismatch })).toBeNull()
  })
  it('does not treat a missing field as an empty saved value', async () => {
    const page = body(); page.rows[0].values = {} as never
    expect(await recoverSheetRow(page, request(), scope)).toMatchObject({ matches: { title: null } })
  })
  it('keeps a listing save unconfirmed without a usable concurrency token', async () => {
    const page = body()
    delete (page.rows[0].listing as { version?: number }).version
    expect(await recoverSheetRow(page, request(), scope)).toBeNull()
  })
  it('recognizes a reset from inheritance even when its effective value is nonempty', async () => {
    const page = body(); page.rows[0].values.title = cell('Inherited title', false)
    const req = request()
    const result = await recoverSheetRow(page, { ...req, cells: [{ colId: 'title', value: null, intent: 'reset' }] }, scope)
    expect(result?.matches.title).toBe(true)
    page.rows[0].values.title = cell('Inherited title', true)
    expect((await recoverSheetRow(page, { ...req, cells: [{ colId: 'title', value: null, intent: 'reset' }] }, scope))?.matches.title).toBe(false)
  })
  it('does not confirm a lost "Follow Master" while the old listing text is still what the listing shows (P1)', async () => {
    const page = body(); page.rows[0].values.title = { ...cell('Old eBay title', false), follows: true, source: 'channelSnapshot' } as never
    const req = request()
    expect((await recoverSheetRow(page, { ...req, cells: [{ colId: 'title', value: null, intent: 'reset' }] }, scope))?.matches.title).toBe(false)
  })
  it('does not mistake an inherited matching value for a successful pin', async () => {
    const page = body(); page.rows[0].values.title = cell('Typed', false)
    const req = request()
    expect((await recoverSheetRow(page, { ...req, cells: [{ ...req.cells[0], intent: 'pin' }] }, scope))?.matches.title).toBe(false)
  })
  it('resolves a pasted reference name to its current canonical ID during recovery', async () => {
    vi.mocked(loadReferenceChoices).mockResolvedValue({ labels: { 'theme-id': 'Modern' }, options: [] })
    const req = request(), page = body()
    page.rows[0].values = { descriptionThemeId: cell('theme-id') } as never
    const result = await recoverSheetRow(page, { ...req, cells: [{ colId: 'descriptionThemeId', value: 'Modern', intent: 'set' }] }, scope)
    expect(result?.matches.descriptionThemeId).toBe(true)
  })
  it('keeps a reference unconfirmed while its names are unavailable', async () => {
    vi.mocked(loadReferenceChoices).mockRejectedValue(new Error('Unavailable'))
    const req = request(), page = body()
    page.rows[0].values = { descriptionThemeId: cell('theme-id') } as never
    expect((await recoverSheetRow(page, { ...req, cells: [{ colId: 'descriptionThemeId', value: 'Modern', intent: 'set' }] }, scope))?.matches.descriptionThemeId).toBeNull()
  })
})

describe('audit A09 — a recovery read hands on the content token of a text it found stored', () => {
  const text = (value: unknown, contentVersion: number) => ({ ...cell(value), writeTarget: 'master', writeField: 'name', contentAddress: { tier: 'language', language: 'it' }, contentVersion })
  const lost = () => ({ rowId: 'alias:child', cells: [{ colId: 'title', value: 'Typed', intent: 'set' as const }, { colId: 'stock', value: 5, intent: 'set' as const }],
    row: { id: 'child', version: 3, aliasId: 'alias', listing: { id: 'listing', version: 7 }, values: { title: text('Typed', 4), bullet: text('Old bullet', 4), stock: cell(5) } as Record<string, any> } })
  const read = (title: string) => ({ ...body(), rows: [{ id: 'child', version: 4, aliasId: 'alias', listing: { id: 'listing', version: 8 },
    values: { title: text(title, 5), bullet: text('Old bullet', 5), stock: cell(2) } }] })

  it('the title was stored (its text moved 4 → 5): every cell writing that text carries 5, so the next edit is not refused', async () => {
    const req = lost()
    const result = await recoverSheetRow(read('Typed'), req, scope)
    expect(result?.matches).toEqual({ title: true, stock: false })
    expect([req.row.values.title.contentVersion, req.row.values.bullet.contentVersion]).toEqual([5, 5])
    expect(req.row.values.title.value).toBe('Typed')
  })
  it('a text the read shows DIFFERENT keeps the token the operator saw: a later edit there is still checked', async () => {
    const req = lost()
    await recoverSheetRow(read('Someone else'), req, scope)
    expect([req.row.values.title.contentVersion, req.row.values.bullet.contentVersion]).toEqual([4, 4])
  })

  /**
   * Review WP2 #2 — the title was stored (4 → 5), then a colleague (a translation job, another tab) changed the bullet
   * of the same text (5 → 6). Before: every cell took 6 while the bullet still showed "Old bullet", and the next bullet
   * edit passed the content check and overwrote the colleague's bullet without a word. Now the token stays 4 (the edit is
   * refused "… changed. Reload", as before A09) and the quiet read that follows a reconcile brings the new bullet.
   */
  it('someone else changed another field of that text in between: nobody\'s token moves', async () => {
    const req = lost(), page = read('Typed')
    for (const value of Object.values(page.rows[0].values) as Array<{ contentVersion?: number }>) if (value.contentVersion) value.contentVersion = 6
    page.rows[0].values.bullet.value = 'Colleague bullet'
    const result = await recoverSheetRow(page, req, scope)
    expect(result?.matches.title).toBe(true)
    expect([req.row.values.title.contentVersion, req.row.values.bullet.contentVersion]).toEqual([4, 4])
    expect(req.row.values.bullet.value).toBe('Old bullet')
  })
  it('the text moved further than the operator\'s save, and another field of it has an edit queued: the token stays', async () => {
    const req = lost(), page = read('Typed')
    for (const value of Object.values(page.rows[0].values) as Array<{ contentVersion?: number }>) if (value.contentVersion) value.contentVersion = 6
    req.row.values.bullet.value = 'Old bullet' // what the read holds too, but an edit is queued behind the outage
    await recoverSheetRow(page, req, { ...scope, busy: (colId: string) => colId === 'bullet' })
    expect([req.row.values.title.contentVersion, req.row.values.bullet.contentVersion]).toEqual([4, 4])
  })
  it('the text moved further, but every other field of it still shows what the read holds: the token moves', async () => {
    const req = lost(), page = read('Typed')
    for (const value of Object.values(page.rows[0].values) as Array<{ contentVersion?: number }>) if (value.contentVersion) value.contentVersion = 6
    await recoverSheetRow(page, req, { ...scope, busy: () => false })
    expect([req.row.values.title.contentVersion, req.row.values.bullet.contentVersion]).toEqual([6, 6])
  })
  it('a cell the sheet marks saving, waiting, unknown or refused is busy; a saved or unmarked one is not', () => {
    const tracker = new CellSaveTracker()
    const busy = unconfirmedIn(tracker, 'alias:child')
    tracker.set('alias:child', 'bullet', 'saving'); tracker.set('alias:child', 'title', 'saved'); tracker.set('other:child', 'stock', 'saving')
    expect([busy('bullet'), busy('title'), busy('stock')]).toEqual([true, false, false])
    tracker.set('alias:child', 'bullet', 'refused', 'No')
    expect(busy('bullet')).toBe(true)
  })
  it('the same product under another alias band takes the token too: an edit there is not refused as changed', async () => {
    const req = lost()
    const band = { id: 'child', version: 3, aliasId: 'other', listing: { id: 'other-listing', version: 2 }, values: { title: text('Typed', 4), bullet: text('Old bullet', 4) } as Record<string, any> }
    const stranger = { ...band, id: 'sibling', values: { title: text('Other product', 4) } as Record<string, any> }
    await recoverSheetRow(read('Typed'), req, { ...scope, family: () => [req.row, band, stranger] })
    expect([band.values.title.contentVersion, band.values.bullet.contentVersion]).toEqual([5, 5])
    expect(stranger.values.title.contentVersion).toBe(4)
  })
})
