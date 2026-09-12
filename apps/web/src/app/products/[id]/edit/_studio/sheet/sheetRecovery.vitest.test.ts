import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('./referenceOptions', () => ({ isReferenceField: (key: string) => key === 'descriptionThemeId', loadReferenceChoices: vi.fn() }))
import { loadReferenceChoices } from './referenceOptions'
import { recoverSheetRow } from './sheetRecovery'

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
