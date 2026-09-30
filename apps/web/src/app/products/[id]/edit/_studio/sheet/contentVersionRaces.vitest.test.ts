import { expect, it, vi } from 'vitest'
import { CellSaveTracker, SheetWriter } from '@/design-system/grid'
import { commitChannelRow } from '@/app/products/[id]/edit/_studio/sheet/channel/useChannelSheet'
import { commitMasterRow } from '@/app/products/[id]/edit/_studio/sheet/master/masterWrite'
import { preserveContentVersions } from '@/app/products/[id]/edit/_studio/sheet/contentVersions'
import type { StudioRow, StudioSheet } from '@/app/products/[id]/edit/_studio/sheet/master/types'
import type { SheetWriteRequest } from '@/design-system/grid'
import type { ChannelSheetRow } from '@/app/products/[id]/edit/_studio/sheet/channel/types'

const response = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
const make = (tier: 'language' | 'pin', productVersion = 7, contentVersion = 4) => ({
  id: 'synthetic-review-product', rowId: 'primary:synthetic-review-product', aliasId: null, version: productVersion,
  listing: { id: 'synthetic-review-listing', version: 82 },
  values: Object.fromEntries(['name', 'description'].map(field => [field, {
    value: 'initial', writeField: field, writable: true, editable: true,
    writeTarget: tier === 'pin' ? 'channelListing' : 'master', writeVerb: tier === 'pin' ? 'channel' : 'master',
    contentAcknowledged: true, contentAddress: { tier, language: 'de', ...(tier === 'pin' ? { coordinate: { channel: 'EBAY', market: 'DE', accountId: 'synthetic-review-account' } } : {}) }, contentVersion,
  }])),
}) as unknown as ChannelSheetRow
const coord = { channel: 'EBAY' as const, marketplace: 'DE', locale: 'de', accountId: 'synthetic-review-account' }

it.each([false, true])('fresh translation recreation after a conflict=%s remains writable', async conflictFirst => {
  let visible = make('language', 5)
  visible.values.brand = { ...visible.values.name, writeField: 'brand', contentAddress: null, contentVersion: undefined }
  const tracker = new CellSaveTracker(), sent: unknown[] = []
  const owner = 7, translation = 1
  const writer = new SheetWriter<ChannelSheetRow>({ tracker, mergeRow: preserveContentVersions, getApi: () => null,
    commit: req => commitChannelRow(req, { ...coord, familyRows: () => [visible],
      onProductVersionsChanged: rows => writer.seed(rows.map(row => ({ id: row.rowId, version: row.version }))),
      bulkSend: async body => {
        const content = (body.changes as Array<{ contentVersion?: number }>)[0].contentVersion
        sent.push([body.expectedVersion, content])
        return body.expectedVersion === owner && content === translation
          ? response(200, { updated: 1, currentVersion: 10, versionOf: 'product', contentVersions: [{ id: visible.id, tier: 'language', language: 'de', version: 2 }] })
          : response(409, { currentVersion: owner, versionOf: 'product', error: 'Changed' })
      } }) })
  writer.seed([{ id: visible.rowId, version: visible.version, row: visible }])
  try {
    if (conflictFirst) {
      writer.set(visible.rowId, 'brand', 'stale local change'); await writer.flush()
      expect(writer.versionOf(visible.rowId)).toBe(7)
      expect(tracker.get(visible.rowId, 'brand')?.state).toBe('refused')
    }
    writer.discard() // The adapter's Reload action drops failed edits before the fresh read.
    visible = make('language', 7, 1)
    writer.seed([{ id: visible.rowId, version: visible.version, row: visible }])
    writer.set(visible.rowId, 'name', 'fresh local change', { row: visible }); await writer.flush()
    expect.soft(sent.at(-1)).toEqual([7, 1])
    expect(tracker.get(visible.rowId, 'name')?.state).toBe('saved')
  } finally { writer.destroy() }
})

it.each([[false, false], [true, false], [false, true], [true, true]])('pin reply survives replacement=%s (batch=%s)', async (replace, batch) => {
  const initial = make('pin'); let visible = initial
  let owner = 82, content = 4, finish!: () => void
  const sent: unknown[] = [], tracker = new CellSaveTracker()
  const commit = (req: SheetWriteRequest<ChannelSheetRow>) => commitChannelRow(req, { ...coord, familyRows: () => [visible],
      bulkSend: async body => {
        const token = (body.changes as Array<{ contentVersion?: number }>)[0].contentVersion
        sent.push([body.expectedVersion, token])
        if (body.expectedVersion !== owner || token !== content) return response(409, { error: 'Changed' })
        owner++; content++
        const answer = response(200, { updated: 1, currentVersion: owner, versionOf: 'channelListing', contentVersions: [{ id: initial.id, tier: 'pin', language: 'de', version: content }] })
        if (sent.length === 1) await new Promise<void>(resolve => { finish = resolve })
        return answer
      } })
  const writer = new SheetWriter<ChannelSheetRow>({ tracker, mergeRow: preserveContentVersions, getApi: () => null, commit,
    ...(batch ? { commitBatch: async (requests: SheetWriteRequest<ChannelSheetRow>[]) => new Map(await Promise.all(requests.map(async req => [req.rowId, await commit(req)] as const))) } : {}) })
  writer.seed([{ id: initial.rowId, version: initial.version, row: initial }])
  try {
    writer.set(initial.rowId, 'name', 'first'); const first = writer.flush()
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    if (replace) { visible = make('pin'); writer.seed([{ id: visible.rowId, version: visible.version, row: visible }]) }
    finish(); await first
    writer.set(visible.rowId, 'description', 'second', { row: visible }); await writer.flush()
    expect.soft(sent).toEqual([[82, 4], [83, 5]])
    expect(tracker.get(visible.rowId, 'description')?.state).toBe('saved')
  } finally { writer.destroy() }
})

it.each([[false, false], [true, false], [false, true], [true, true]])('master reply survives replacement=%s (batch=%s)', async (replace, batch) => {
  const initial = make('language'); initial.rowId = initial.id
  let visible = initial, owner = 7, content = 4, finish!: () => void
  const sent: unknown[] = [], tracker = new CellSaveTracker()
  const commit = (req: SheetWriteRequest<ChannelSheetRow>) => commitMasterRow(req as unknown as SheetWriteRequest<StudioRow>, { sheet: { columns: ['name', 'description'].map(key => ({ key, writeField: key, storage: 'localizedContent' })) } as unknown as StudioSheet,
      opts: {}, locale: 'de', market: 'DE', bulkSend: async body => {
        const token = (body.changes as Array<{ contentVersion?: number }>)[0].contentVersion
        sent.push([body.expectedVersion, token])
        if (body.expectedVersion !== owner || token !== content) return response(409, { currentVersion: owner, versionOf: 'product', error: 'Changed' })
        owner++; content++
        const answer = response(200, { updated: 1, currentVersion: owner, versionOf: 'product', contentVersions: [{ id: initial.id, tier: 'language', language: 'de', version: content }] })
        if (sent.length === 1) await new Promise<void>(resolve => { finish = resolve })
        return answer
      } })
  const writer = new SheetWriter<ChannelSheetRow>({ tracker, mergeRow: preserveContentVersions, getApi: () => null, commit,
    ...(batch ? { commitBatch: async (requests: SheetWriteRequest<ChannelSheetRow>[]) => new Map(await Promise.all(requests.map(async req => [req.rowId, await commit(req)] as const))) } : {}) })
  writer.seed([{ id: initial.id, version: initial.version, row: initial }])
  try {
    writer.set(initial.id, 'name', 'first'); const first = writer.flush()
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    if (replace) {
      visible = make('language'); visible.rowId = visible.id
      // Same adoption as useMasterSheet.ts quiet read: preserve just the cell with saving state.
      for (const key of Object.keys(visible.values)) {
        if (['refused', 'unknown', 'saving', 'pending'].includes(tracker.get(visible.id, key)?.state ?? '')) visible.values[key] = initial.values[key]
      }
      writer.seed([{ id: visible.id, version: visible.version, row: visible }])
    }
    finish(); await first
    writer.set(visible.id, 'description', 'second', { row: visible }); await writer.flush()
    expect.soft(sent).toEqual([[7, 4], [8, 5]])
    expect(tracker.get(visible.id, 'description')?.state).toBe('saved')
  } finally { writer.destroy() }
})
