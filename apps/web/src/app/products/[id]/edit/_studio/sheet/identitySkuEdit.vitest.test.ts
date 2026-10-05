/**
 * S11 — the first column's SKU rules (`identitySkuEdit.ts`), both scopes: what the cell shows, whether it can be edited,
 * the mark and its sentence (per channel and market; none on Shared), the editor's line, what a typed value means, what
 * each writer sends, the undo value, a lost answer read back, the Add rows seam, and one edit's whole road through
 * `IdentitySkuEdits` with the sheet's real save tracker — a refused save puts the value back and keeps the sentence.
 */
import { describe, expect, it, vi } from 'vitest'
import { CellSaveTracker } from '@/design-system/grid/editors/roundTrip'
import {
  CHANNEL_SKU_FIELD, CREATE_NOT_READY, IDENTITY_SKU_COLUMN, IdentitySkuEdits, NO_FACTS_REASON, SHARED_SKU_FIELD, SHARED_SKU_NOTICE,
  SKU_MAX_LENGTH, applyIdentitySku, channelOnlySentence, identitySkuChannelChange, identitySkuEditability, identitySkuIntent,
  identitySkuHover, identitySkuMark, identitySkuNotice, identitySkuQueued, identitySkuRecovered, identitySkuRefusal, identitySkuShown, identitySkuSnapshot,
  identitySkuUndoValue, listingSkuLabel, renamedStudioRecord, restoreIdentitySku, sharedWriteField, skuRenameMessage, skuRenamesOf,
  type IdentitySkuFacts, type IdentitySkuRow, type IdentitySkuScope,
} from './identitySkuEdit'

const SHARED: IdentitySkuScope = { kind: 'shared' }
const AMAZON_DE: IdentitySkuScope = { kind: 'channel', channel: 'AMAZON', marketplace: 'DE' }
const EBAY_IT: IdentitySkuScope = { kind: 'channel', channel: 'EBAY', marketplace: 'IT' }
const facts = (over: Partial<IdentitySkuFacts> = {}): IdentitySkuFacts =>
  ({ wanted: 'GALE-M', source: 'product', live: null, liveConfirmed: false, differs: false, editable: true, reason: null, ...over })
const row = (over: Partial<IdentitySkuRow> = {}): IdentitySkuRow => ({ sku: 'GALE-M', aliasId: null, skuFacts: facts(), ...over })

describe('the first column — what it shows and whether it can be edited', () => {
  it('is the IDs AG gives the tree column, and the two wire fields', () => {
    expect(IDENTITY_SKU_COLUMN).toBe('ag-Grid-AutoColumn')
    expect(SHARED_SKU_FIELD).toBe('sku')
    expect(CHANNEL_SKU_FIELD).toBe('channel_sku')
    expect(SKU_MAX_LENGTH).toBe(100)
    expect(sharedWriteField(IDENTITY_SKU_COLUMN, undefined)).toBe('sku')
    expect(sharedWriteField('name', 'name')).toBe('name')
    expect(sharedWriteField('attr_colour', undefined)).toBe('attr_colour')
  })

  it('Shared: the product SKU, every saved row editable', () => {
    expect(identitySkuShown(SHARED, row({ skuFacts: facts({ wanted: 'OTHER' }) }))).toBe('GALE-M')
    expect(identitySkuEditability(SHARED, row({ skuFacts: undefined }))).toEqual({ editable: true, reason: null })
  })

  it('channel: the SKU Publish sends for the listing; the server says whether and why not', () => {
    expect(identitySkuShown(AMAZON_DE, row({ skuFacts: facts({ wanted: 'GALE-M-DE', differs: true, source: 'channel' }) }))).toBe('GALE-M-DE')
    // No single SKU on record: the Shared SKU is shown beside the attention mark.
    expect(identitySkuShown(AMAZON_DE, row({ skuFacts: facts({ wanted: null, source: null }) }))).toBe('GALE-M')
    expect(identitySkuEditability(AMAZON_DE, row({ skuFacts: facts({ editable: false, reason: 'No listing here.' }) }))).toEqual({ editable: false, reason: 'No listing here.' })
    expect(identitySkuEditability(AMAZON_DE, row({ skuFacts: undefined }))).toEqual({ editable: false, reason: NO_FACTS_REASON })
  })
})

describe('S11 follow-up — how a channel row\'s listing is named (its Status and Action labels)', () => {
  it('the SKU the channel holds; else the SKU Publish sends; the product SKU when the read said nothing', () => {
    expect(listingSkuLabel(row({ skuFacts: facts({ live: 'GALE-M-OLD', wanted: 'GALE-M-IT', source: 'channel', differs: true }) }))).toBe('GALE-M-OLD')
    expect(listingSkuLabel(row({ skuFacts: facts({ live: null, wanted: 'GALE-M-IT', source: 'channel', differs: true }) }))).toBe('GALE-M-IT')
    expect(listingSkuLabel(row({ skuFacts: facts({ live: null, wanted: null, source: null }) }))).toBe('GALE-M')
    expect(listingSkuLabel(row({ skuFacts: undefined }))).toBe('GALE-M')
  })
})

describe('the warning — the sheet\'s "differs from Shared" mark, per channel and market', () => {
  it('a channel SKU that is not the Shared SKU: pinned, with the Owner\'s sentence (Amazon per market)', () => {
    const own = row({ skuFacts: facts({ wanted: 'GALE-M-DE', source: 'channel', differs: true }) })
    const sentence = 'This SKU is for Amazon · DE only. Other channels and markets keep GALE-M. To change it everywhere, edit it in the Shared view.'
    expect(identitySkuMark(AMAZON_DE, own)).toEqual({ member: 'pinned', sentence })
    expect(channelOnlySentence({ kind: 'channel', channel: 'AMAZON', marketplace: 'FR' }, own)).toBe(sentence.replace('Amazon · DE', 'Amazon · FR'))
    expect(identitySkuMark(EBAY_IT, own).sentence).toBe('This SKU is for eBay · IT only. Other channels and markets keep GALE-M. To change it everywhere, edit it in the Shared view.')
    // An extra listing's row names it.
    expect(identitySkuMark(EBAY_IT, { ...own, aliasId: 'al_1' }).sentence).toContain('This SKU is for eBay · IT (extra listing) only.')
    // F4 (browser check 2026-10-05): a GLOBAL market is the channel's name alone — "Etsy", "Shopify", never "· GLOBAL".
    expect(identitySkuMark({ kind: 'channel', channel: 'ETSY', marketplace: 'GLOBAL' }, own).sentence).toBe('This SKU is for Etsy only. Other channels and markets keep GALE-M. To change it everywhere, edit it in the Shared view.')
    expect(identitySkuMark({ kind: 'channel', channel: 'SHOPIFY', marketplace: 'GLOBAL' }, own).sentence).not.toContain('GLOBAL')
  })

  it('F7 — an extra listing\'s own row (its band) wears the same mark and sentence as any listing row when its SKU differs', () => {
    const band = row({ aliasId: 'al_1', skuFacts: facts({ wanted: 'GALE-EB2', source: 'channel', differs: true }) })
    expect(identitySkuEditability(EBAY_IT, band)).toEqual({ editable: true, reason: null })
    expect(identitySkuMark(EBAY_IT, band)).toEqual({ member: 'pinned',
      sentence: 'This SKU is for eBay · IT (extra listing) only. Other channels and markets keep GALE-M. To change it everywhere, edit it in the Shared view.' })
  })

  it('no mark when the listing follows the Shared SKU, nor on the Shared scope', () => {
    expect(identitySkuMark(AMAZON_DE, row())).toEqual({ member: 'own', sentence: null })
    expect(identitySkuMark(SHARED, row({ skuFacts: facts({ wanted: 'X', differs: true }) }))).toEqual({ member: 'own', sentence: null })
    // An own SKU equal to the Shared SKU says nothing different.
    expect(identitySkuMark(AMAZON_DE, row({ skuFacts: facts({ source: 'channel', differs: false }) })).member).toBe('own')
  })

  it('no single SKU on record: attention, with the resolver\'s sentence', () => {
    expect(identitySkuMark(AMAZON_DE, row({ skuFacts: facts({ wanted: null, source: null, differs: true, conflict: 'GALE-M has multiple seller SKUs. Select its offer before publishing.' }) })))
      .toEqual({ member: 'attention', sentence: 'GALE-M has multiple seller SKUs. Select its offer before publishing.' })
  })

  it('the editor line: the same warning in a channel scope, the Shared sentence on Shared', () => {
    expect(identitySkuNotice(AMAZON_DE, row())).toEqual({ tone: 'warning', text: 'This SKU is for Amazon · DE only. Other channels and markets keep GALE-M. To change it everywhere, edit it in the Shared view.' })
    expect(identitySkuNotice(SHARED, row())).toEqual({ tone: 'info', text: SHARED_SKU_NOTICE })
    expect(SHARED_SKU_NOTICE).toBe('Changes the SKU on every channel and market that follows it. Listings a channel still holds keep their current SKU.')
  })
})

describe('what a typed value means', () => {
  it('Shared: a rename; the same SKU is no change; the product-SKU rule refuses with its own words', () => {
    expect(identitySkuIntent(SHARED, row(), '  GALE-M2 ')).toEqual({ kind: 'rename', sku: 'GALE-M2' })
    expect(identitySkuIntent(SHARED, row(), ' GALE-M ')).toEqual({ kind: 'unchanged' })
    expect(identitySkuIntent(SHARED, row(), '')).toEqual({ kind: 'refused', reason: 'Enter a SKU.' })
    expect(identitySkuIntent(SHARED, row(), 'GALE M')).toEqual({ kind: 'refused', reason: 'Use only letters, numbers, dots (.), hyphens (-) and underscores (_). No spaces.' })
    expect(identitySkuIntent(SHARED, row(), 'A'.repeat(101))).toEqual({ kind: 'refused', reason: 'A SKU can have up to 100 characters. This one has 101.' })
  })

  it('channel: this listing\'s own SKU; empty follows the Shared SKU; the SKU it already sends is no change', () => {
    expect(identitySkuIntent(AMAZON_DE, row(), 'GALE-M-DE')).toEqual({ kind: 'set', sku: 'GALE-M-DE' })
    // Typing the Shared SKU itself is a value of its own (the server stores it as typed).
    expect(identitySkuIntent(AMAZON_DE, row({ skuFacts: facts({ wanted: 'GALE-M-DE', source: 'channel', differs: true }) }), 'GALE-M')).toEqual({ kind: 'set', sku: 'GALE-M' })
    expect(identitySkuIntent(AMAZON_DE, row({ skuFacts: facts({ wanted: 'GALE-M-DE', source: 'channel', differs: true }) }), '')).toEqual({ kind: 'follow' })
    expect(identitySkuIntent(AMAZON_DE, row(), '')).toEqual({ kind: 'unchanged' })
    expect(identitySkuIntent(AMAZON_DE, row(), 'GALE-M')).toEqual({ kind: 'unchanged' })
    // No single SKU on record: naming one is a set, even the Shared SKU.
    expect(identitySkuIntent(AMAZON_DE, row({ skuFacts: facts({ wanted: null, source: null, differs: true }) }), 'GALE-M')).toEqual({ kind: 'set', sku: 'GALE-M' })
    expect(identitySkuIntent(AMAZON_DE, row(), 'GALE/M')).toMatchObject({ kind: 'refused' })
  })

  it('channel: a row that cannot be edited refuses with the server\'s reason', () => {
    expect(identitySkuIntent(AMAZON_DE, row({ skuFacts: facts({ editable: false, reason: 'This row is the extra listing itself.' }) }), 'X'))
      .toEqual({ kind: 'refused', reason: 'This row is the extra listing itself.' })
    expect(identitySkuIntent(AMAZON_DE, row({ skuFacts: null }), 'X')).toEqual({ kind: 'refused', reason: NO_FACTS_REASON })
  })

  it('🔴 the Add rows seam: an unsaved row\'s first SKU CREATES (both scopes); a real row\'s never does', () => {
    for (const scope of [SHARED, AMAZON_DE]) {
      expect(identitySkuIntent(scope, row({ unsaved: true, sku: '', skuFacts: null }), 'NEW-1')).toEqual({ kind: 'create', sku: 'NEW-1' })
      expect(identitySkuIntent(scope, row({ unsaved: true, sku: '', skuFacts: null }), '  ')).toEqual({ kind: 'unchanged' })
      expect(identitySkuIntent(scope, row({ unsaved: true, sku: '', skuFacts: null }), 'NEW 1')).toMatchObject({ kind: 'refused', sku: 'NEW 1' })
      expect(identitySkuEditability(scope, row({ unsaved: true, skuFacts: null }))).toEqual({ editable: true, reason: null })
      // A row whose create is on its way (or done) takes no SKU: its store says why.
      expect(identitySkuEditability(scope, row({ unsaved: true, unsavedReason: 'This row is being created. Wait for the answer.', skuFacts: null })))
        .toEqual({ editable: false, reason: 'This row is being created. Wait for the answer.' })
      expect(identitySkuIntent(scope, row(), 'NEW-1').kind).not.toBe('create')
    }
    expect(CREATE_NOT_READY).toBe('Adding a product from an empty row is not available yet.')
  })
})

describe('what the writers send', () => {
  it('the queued value: a rename or a set carries the SKU; follow is a reset with no value', () => {
    expect(identitySkuQueued({ kind: 'rename', sku: 'N' })).toEqual({ value: 'N', intent: 'set' })
    expect(identitySkuQueued({ kind: 'set', sku: 'N' })).toEqual({ value: 'N', intent: 'set' })
    expect(identitySkuQueued({ kind: 'follow' })).toEqual({ value: null, intent: 'reset' })
  })

  it('the channel change: channel_sku, a channel write; a reset or an empty value follows the Shared SKU', () => {
    expect(identitySkuChannelChange(' GALE-M-DE ', 'set')).toEqual({ field: 'channel_sku', value: 'GALE-M-DE', target: 'channel', intent: 'set' })
    expect(identitySkuChannelChange(null, 'reset')).toEqual({ field: 'channel_sku', value: null, target: 'channel', intent: 'reset' })
    expect(identitySkuChannelChange('', 'set')).toEqual({ field: 'channel_sku', value: null, target: 'channel', intent: 'reset' })
  })
})

describe('the row shows the edit at once, and goes back', () => {
  it('Shared: the product SKU; channel: the listing\'s SKU and whether it differs; restore puts both back', () => {
    const shared = row()
    const before = identitySkuSnapshot(shared)
    applyIdentitySku(SHARED, shared, { kind: 'rename', sku: 'GALE-M2' })
    expect(shared.sku).toBe('GALE-M2')
    restoreIdentitySku(shared, before)
    expect(shared.sku).toBe('GALE-M')

    const channel = row()
    const was = identitySkuSnapshot(channel)
    applyIdentitySku(AMAZON_DE, channel, { kind: 'set', sku: 'GALE-M-DE' })
    expect(channel.skuFacts).toMatchObject({ wanted: 'GALE-M-DE', source: 'channel', differs: true })
    expect(channel.sku).toBe('GALE-M')
    applyIdentitySku(AMAZON_DE, channel, { kind: 'follow' })
    expect(channel.skuFacts).toMatchObject({ wanted: 'GALE-M', source: 'product', differs: false })
    restoreIdentitySku(channel, was)
    expect(channel.skuFacts).toEqual(facts())
  })

  it('the undo value: the old SKU on Shared; empty (follow again) for a listing that followed, else what it sent', () => {
    expect(identitySkuUndoValue(SHARED, row())).toBe('GALE-M')
    expect(identitySkuUndoValue(AMAZON_DE, row())).toBe('')
    expect(identitySkuUndoValue(AMAZON_DE, row({ skuFacts: facts({ wanted: 'SF-FLAT', source: 'flatFile', differs: true }) }))).toBe('SF-FLAT')
    expect(identitySkuUndoValue(AMAZON_DE, row({ skuFacts: facts({ wanted: null, source: null }) }))).toBe('')
  })

  it('a lost answer read back: the stored SKU decides; no facts cannot tell', () => {
    expect(identitySkuRecovered({ sku: 'GALE-M2' }, false, 'GALE-M2', 'set')).toBe(true)
    expect(identitySkuRecovered({ sku: 'GALE-M' }, false, 'GALE-M2', 'set')).toBe(false)
    expect(identitySkuRecovered({ skuFacts: facts({ wanted: 'X', source: 'channel' }) }, true, 'X', 'set')).toBe(true)
    expect(identitySkuRecovered({ skuFacts: facts() }, true, null, 'reset')).toBe(true)
    expect(identitySkuRecovered({ skuFacts: null }, true, 'X', 'set')).toBeNull()
  })
})

describe('IdentitySkuEdits — one edit\'s road, with the sheet\'s save tracker', () => {
  function harness(scope: IdentitySkuScope) {
    const tracker = new CellSaveTracker()
    const host = {
      scope: () => scope, rowIdOf: (r: IdentitySkuRow & { id: string }) => r.id, tracker,
      write: vi.fn((rowId: string) => tracker.set(rowId, IDENTITY_SKU_COLUMN, 'saving')),
      recordUndo: vi.fn(), announce: vi.fn(), repaint: vi.fn(),
    }
    const edits = new IdentitySkuEdits(host)
    tracker.subscribe(() => edits.trackerChanged())
    /** What the column's setter does, then the grid's change event. */
    const type = (r: IdentitySkuRow & { id: string }, value: string, source = 'edit') => {
      const intent = identitySkuIntent(scope, r, value)
      if (intent.kind === 'unchanged') return
      edits.setterSaw(r, intent, identitySkuSnapshot(r))
      if (intent.kind === 'refused' || intent.kind === 'create') return
      applyIdentitySku(scope, r, intent)
      edits.changed({ data: r, colDef: { colId: IDENTITY_SKU_COLUMN }, source })
    }
    return { tracker, host, edits, type }
  }

  it('🔴 Add rows: an unsaved row\'s typed SKU goes to the host\'s create — no tracker mark, no write, no undo step', () => {
    for (const scope of [SHARED, AMAZON_DE]) {
      const { tracker, host, edits, type } = harness(scope)
      const created: Array<[string, string]> = []
      const withCreate = new IdentitySkuEdits({ ...host, create: (r: IdentitySkuRow & { id: string }, sku: string) => { created.push([r.id, sku]); return true } })
      const r = { ...row({ unsaved: true, sku: '', skuFacts: null }), id: 'new-row:1' }
      for (const typed of ['NEW-1', 'NEW 1']) withCreate.setterSaw(r, identitySkuIntent(scope, r, typed), identitySkuSnapshot(r))
      // The client check's refusal goes there too, with what was typed: the row shows it with the reason.
      expect(created).toEqual([['new-row:1', 'NEW-1'], ['new-row:1', 'NEW 1']])
      expect(tracker.get('new-row:1', IDENTITY_SKU_COLUMN)).toBeUndefined()
      expect(host.write).not.toHaveBeenCalled()
      expect(host.recordUndo).not.toHaveBeenCalled()
      // A host without Add rows (no `create`, or one that declines) refuses it as before.
      type(r, 'NEW-2')
      expect(tracker.get('new-row:1', IDENTITY_SKU_COLUMN)).toMatchObject({ state: 'refused', reason: CREATE_NOT_READY })
      void edits
    }
  })

  it('Shared: the rename leaves through the writer as `sku`, with ONE undo step from the old SKU', () => {
    const { host, type } = harness(SHARED)
    const r = { ...row(), id: 'p1' }
    type(r, 'GALE-M2')
    expect(host.write).toHaveBeenCalledWith('p1', 'GALE-M2', r, 'set')
    expect(host.recordUndo).toHaveBeenCalledWith({ rowId: 'p1', colId: IDENTITY_SKU_COLUMN, before: 'GALE-M', after: 'GALE-M2' }, 'edit')
    expect(r.sku).toBe('GALE-M2')
  })

  it('🔴 a refused save: the cell keeps the server\'s sentence and the value goes back', () => {
    const { tracker, host, type } = harness(AMAZON_DE)
    const r = { ...row(), id: 'primary:p1' }
    type(r, 'GALE-M-DE')
    expect(r.skuFacts?.wanted).toBe('GALE-M-DE')
    const sentence = 'Amazon · DE holds GALE-M. Moving a live listing to a new SKU comes with Publish\'s move step; Delete it there first, or wait for that step.'
    tracker.set('primary:p1', IDENTITY_SKU_COLUMN, 'refused', sentence)
    expect(r.skuFacts).toEqual(facts())
    expect(tracker.get('primary:p1', IDENTITY_SKU_COLUMN)).toMatchObject({ state: 'refused', reason: sentence })
    expect(host.repaint).toHaveBeenCalledWith(r)
  })

  it('a stored save keeps the new value; a later refusal of a NEW edit goes back to the stored one', () => {
    const { tracker, type } = harness(SHARED)
    const r = { ...row(), id: 'p1' }
    type(r, 'GALE-M2')
    tracker.set('p1', IDENTITY_SKU_COLUMN, 'saved')
    expect(r.sku).toBe('GALE-M2')
    type(r, 'GALE-M3')
    tracker.set('p1', IDENTITY_SKU_COLUMN, 'refused', 'SKU "GALE-M3" is already used by another product')
    expect(r.sku).toBe('GALE-M2')
  })

  it('two edits while the first is on its way: a refusal goes back to what the server last had', () => {
    const { tracker, type } = harness(SHARED)
    const r = { ...row(), id: 'p1' }
    type(r, 'GALE-M2')
    type(r, 'GALE-M3')
    tracker.set('p1', IDENTITY_SKU_COLUMN, 'refused', 'No.')
    expect(r.sku).toBe('GALE-M')
  })

  it('a value the client check refuses never leaves: refused mark, its sentence said at once, nothing written', () => {
    const { tracker, host, type } = harness(SHARED)
    const r = { ...row(), id: 'p1' }
    type(r, 'GALE M')
    expect(host.write).not.toHaveBeenCalled()
    expect(r.sku).toBe('GALE-M')
    const reason = 'Use only letters, numbers, dots (.), hyphens (-) and underscores (_). No spaces.'
    expect(tracker.get('p1', IDENTITY_SKU_COLUMN)).toMatchObject({ state: 'refused', reason })
    expect(host.announce).toHaveBeenCalledWith([{ colId: IDENTITY_SKU_COLUMN, reason }])
  })

  it('channel follow, and its undo: the reset leaves with no value; undo writes the old own SKU back', () => {
    const { host, type } = harness(AMAZON_DE)
    const r = { ...row({ skuFacts: facts({ wanted: 'GALE-M-DE', source: 'channel', differs: true }) }), id: 'primary:p1' }
    type(r, '')
    expect(host.write).toHaveBeenLastCalledWith('primary:p1', null, r, 'reset')
    expect(host.recordUndo).toHaveBeenLastCalledWith({ rowId: 'primary:p1', colId: IDENTITY_SKU_COLUMN, before: 'GALE-M-DE', after: '' }, 'edit')
    // The undo replays the before value through the grid (source `undo`): the same road, the same writer.
    type(r, 'GALE-M-DE', 'undo')
    expect(host.write).toHaveBeenLastCalledWith('primary:p1', 'GALE-M-DE', r, 'set')
    expect(host.recordUndo).toHaveBeenLastCalledWith(expect.anything(), 'undo')
  })

  it('other columns and grid data are not its business', () => {
    const { host, edits } = harness(SHARED)
    expect(edits.changed({ data: { ...row(), id: 'p1' }, colDef: { colId: 'name' }, source: 'edit' })).toBe(false)
    expect(edits.changed({ data: { ...row(), id: 'p1' }, colDef: { colId: IDENTITY_SKU_COLUMN }, source: 'data' })).toBe(true)
    expect(host.write).not.toHaveBeenCalled()
  })
})

describe('after a Shared rename', () => {
  const body = { skuRenames: [
    { productId: 'p1', from: 'GALE-M', to: 'GALE-M2', summary: 'Amazon · DE and eBay · IT keep GALE-M; drafts follow GALE-M2.', listings: [] },
    { productId: 'p2', from: 'X', to: 'Y' },
    { productId: 3, from: 'bad' },
  ] }

  it('reads the answer\'s renames and says each with the server\'s sentence', () => {
    const renames = skuRenamesOf(body)
    expect(renames).toEqual([
      { productId: 'p1', from: 'GALE-M', to: 'GALE-M2', summary: 'Amazon · DE and eBay · IT keep GALE-M; drafts follow GALE-M2.' },
      { productId: 'p2', from: 'X', to: 'Y', summary: '' },
    ])
    expect(skuRenameMessage(renames)).toBe('GALE-M is now GALE-M2. Amazon · DE and eBay · IT keep GALE-M; drafts follow GALE-M2. X is now Y.')
    expect(skuRenameMessage([])).toBeNull()
    expect(skuRenamesOf({})).toEqual([])
    const many = Array.from({ length: 5 }, (_, i) => ({ productId: `p${i}`, from: `A${i}`, to: `B${i}`, summary: '' }))
    expect(skuRenameMessage(many)).toBe('A0 is now B0. A1 is now B1. A2 is now B2. 2 more SKUs were renamed the same way.')
  })

  it('the studio\'s record shows the new SKU (product and family parent), the same objects when nothing changed', () => {
    const product = { id: 'p1', sku: 'GALE-M', name: 'Jacket M' }
    const family = { parentId: 'root', parentSku: 'GALE', parentName: 'Jacket' }
    expect(renamedStudioRecord(product, family, { p1: 'GALE-M2', root: 'GALE2' })).toEqual({
      product: { id: 'p1', sku: 'GALE-M2', name: 'Jacket M' }, family: { parentId: 'root', parentSku: 'GALE2', parentName: 'Jacket' } })
    const same = renamedStudioRecord(product, family, { other: 'Z' })
    expect(same.product).toBe(product)
    expect(same.family).toBe(family)
    expect(renamedStudioRecord(product, null, { p1: 'GALE-M2' }).family).toBeNull()
  })
})

describe('F3 / F8 — the first column\'s last refusal, and the band\'s hover', () => {
  it('a real row: the tracker\'s refused entry; an empty row: its refused create; nothing else', () => {
    expect(identitySkuRefusal(row(), { state: 'refused', reason: ' Taken. ' })).toBe('Taken.')
    expect(identitySkuRefusal(row(), { state: 'saving' })).toBeNull()
    expect(identitySkuRefusal(row(), undefined)).toBeNull()
    const empty = (state: string, reason: string | null) => row({ unsaved: true, newRow: { kind: 'variation', state, reason } })
    expect(identitySkuRefusal(empty('refused', 'DEMO-JACKET-M is already in this family.'))).toBe('DEMO-JACKET-M is already in this family.')
    expect(identitySkuRefusal(empty('unknown', 'Connection lost.'))).toBeNull()
    // An empty row's refusal is its own, never a tracker entry.
    expect(identitySkuRefusal(empty('empty', null), { state: 'refused', reason: 'X' })).toBeNull()
  })
  it('the hover leads with the refusal, then the band\'s own sentence; unchanged without one', () => {
    expect(identitySkuHover('Taken.', 'Primary · Listing active · 3 variants')).toBe('Not saved: Taken.\n\nPrimary · Listing active · 3 variants')
    expect(identitySkuHover(null, 'Primary · Listing active · 3 variants')).toBe('Primary · Listing active · 3 variants')
    expect(identitySkuHover('Taken.')).toBe('Not saved: Taken.')
    expect(identitySkuHover(null)).toBeUndefined()
  })
})
