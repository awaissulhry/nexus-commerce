'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { statusOptionsFor, type CapabilityFacts, type ListingModel, type SellingState, type StatusTarget } from '@nexus/shared/listing-actions'
import { sendModeOptions, type SendMode } from '@nexus/shared/publish-actions'
import { ConfirmPhraseField, phraseMatches } from '../components/ConfirmPhraseField'
import { ListboxPanel } from '../components/ListboxPanel'
import { Button } from '../primitives/Button'
import { NexusGrid, SelectPanelEditor, type ColDef, type ValueSetterParams } from '../grid'
import { PublishActionCell, PublishActionView } from '../grid/renderers/PublishActionCell'
import { SellingStatusCell, SellingStatusView } from '../grid/renderers/SellingStatusCell'
import { publishActionModel, sendModeEditorOptions, type PublishActionValue } from '../grid/renderers/publishAction'
import {
  SELLING_ROW_MARK_CLASS, STATUS_TARGET_SELLING_STATE, rowCarriesInactiveMark, sellingStatusModel, statusEditorOptions,
  type SellingStatusValue,
} from '../grid/renderers/sellingStatus'

/**
 * Status and Action columns (sheet publish parity, build shape v2, 2026-10-04) — WEB ONLY: Factory has no NexusGrid.
 * Verify in light and dark, at 1280 and 390 px: every Status state; a waiting Inactive (warning), Ended (danger) and
 * Active (info), each with a clock glyph and the live state beside it; the read-only Not listed with its lock; the quiet
 * Partial update and the waiting Full update / Delete pills; in the grid, the row-start mark on inactive rows (never a
 * row tint), Enter on a Status or Action cell opens the editor with the refused values reachable and their reasons
 * under them, Escape returns to the cell; the typed confirmation announces its state and arms the button only on an
 * exact match. Each sample's caption gives what a screen reader hears.
 */
const MIN = 60_000
const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * MIN).toISOString()

const STATUS_SAMPLES: Array<{ label: string; value: (() => SellingStatusValue) | undefined }> = [
  { label: 'Active', value: () => ({ state: 'active' }) },
  { label: 'Inactive', value: () => ({ state: 'paused', reason: 'Inactive: this market\'s Amazon offer is removed. Other markets keep selling.' }) },
  { label: 'Mixed', value: () => ({ state: 'mixed', reason: '2 of 6 variations are inactive.' }) },
  { label: 'Ended', value: () => ({ state: 'ended' }) },
  { label: 'Unknown', value: () => ({ state: 'unknown', reason: 'The last change to this listing failed. Check it on the channel.' }) },
  { label: 'Waiting: Inactive', value: () => ({ state: 'active', waiting: { target: 'inactive', setAt: at(20), setByName: 'Dev Owner' } }) },
  { label: 'Waiting: Ended', value: () => ({ state: 'active', waiting: { target: 'ended', setAt: at(5), setByName: 'Dev Owner' } }) },
  { label: 'Waiting: Active', value: () => ({ state: 'paused', waiting: { target: 'active', setAt: at(60 * 30), setByName: 'Awais' } }) },
  { label: 'No longer applies', value: () => ({ state: 'paused', waiting: { target: 'inactive', setAt: at(90), setByName: 'Awais' } }) },
  { label: 'Not listed, a draft (read-only)', value: () => ({ state: 'draft', reason: 'In Nexus only. Publish creates it on the channel.' }) },
  { label: 'Not listed (read-only)', value: () => ({ state: 'not_listed' }) },
  // Simplify (2026-10-04): a listing Nexus deleted is a row not on the channel — Not listed by default; Active lists it again.
  { label: 'Not listed (deleted on Amazon · IT)', value: () => ({ state: 'not_listed', reason: 'Deleted on Amazon · IT on 4 Oct. To list it again, set Status to Active and Publish.',
    create: { target: 'not_listed', source: 'default', sentence: 'Deleted on Amazon · IT on 4 Oct. To list it again, set Status to Active and Publish.', deleted: { on: '4 Oct' } } }) },
  // New listings (2026-10-04): a row not on the channel yet chooses what Publish creates — never locked.
  { label: 'New: Active (default)', value: () => ({ state: 'not_listed', create: { target: 'active', source: 'default', sentence: 'Publish creates it and it sells.' } }) },
  { label: 'New: Inactive (chosen)', value: () => ({ state: 'draft', waiting: { target: 'inactive', setAt: at(8), setByName: 'Awais' },
    create: { target: 'inactive', source: 'own', sentence: 'Publish creates it, but buyers cannot buy it yet. Set Active and Publish when you are ready.' } }) },
  { label: 'New: follows the main', value: () => ({ state: 'draft', create: { target: 'inactive', source: 'main', sentence: 'Publish creates it, but buyers cannot buy it yet. Set Active and Publish when you are ready. (It follows the main product\'s choice; set this row to choose for it.)' } }) },
  { label: 'New: Not listed', value: () => ({ state: 'not_listed', waiting: { target: 'not_listed', setAt: at(3), setByName: 'Awais' }, create: { target: 'not_listed', source: 'own', sentence: 'Publish leaves it out. It stays in Nexus only.' } }) },
  { label: 'Loading', value: undefined },
]

const ACTION_SAMPLES: Array<{ label: string; value: () => PublishActionValue }> = [
  { label: 'Partial update (default)', value: () => ({ mode: 'partial' }) },
  { label: 'Waiting: Full update', value: () => ({ mode: 'full', setAt: at(12), setByName: 'Dev Owner' }) },
  { label: 'Waiting: Delete', value: () => ({ mode: 'delete', setAt: at(3), setByName: 'Dev Owner' }) },
  { label: 'Locked (Etsy)', value: () => ({ mode: 'partial', lockedReason: 'Publishing to Etsy from the product sheet is not available yet.' }) },
  // Simplify (2026-10-04): no Create, Deleted or Keep deleted Action words — a row not on the channel (new, or deleted
  // by Nexus) reads Full update: a create always sends the whole listing; its Status says whether Publish creates it.
  { label: 'Not on the channel: Full update (sent whole)', value: () => ({ mode: 'full', newRow: true }) },
  { label: 'Not on the channel, Not listed (deleted)', value: () => ({ mode: 'full', newRow: true, leftOut: true, deleted: true }) },
]

// ── the mini sheet ──────────────────────────────────────────────────────────────────────────────────────────────────

interface Waiting<T> { value: T; setAt: string; setByName: string }
interface SheetRow {
  id: string
  sku: string
  market: string
  model: ListingModel
  facts: CapabilityFacts & { isParent: boolean; isVariation: boolean }
  state: SellingState
  reason?: string
  status: Waiting<StatusTarget> | null
  send: Waiting<SendMode> | null
}

const seedRows = (): SheetRow[] => [
  { id: 'r1', sku: 'GALE-JACKET-M', market: 'Amazon · DE', model: 'amazon', facts: { isParent: false, isVariation: true }, state: 'active', status: null, send: null },
  { id: 'r2', sku: 'GALE-JACKET-L', market: 'Amazon · DE', model: 'amazon', facts: { isFba: true, isParent: false, isVariation: true }, state: 'paused', reason: 'Inactive: this market\'s Amazon offer is removed. Other markets keep selling.', status: { value: 'active', setAt: at(45), setByName: 'Awais' }, send: { value: 'full', setAt: at(44), setByName: 'Awais' } },
  { id: 'r3', sku: 'XAVIA-SLIDER', market: 'eBay · IT', model: 'ebay-trading', facts: { isParent: true, isVariation: false }, state: 'active', status: { value: 'ended', setAt: at(4), setByName: 'Dev Owner' }, send: null },
  { id: 'r4', sku: 'XAVIA-SLIDER-BLK', market: 'eBay · IT', model: 'ebay-trading', facts: { isParent: false, isVariation: true }, state: 'mixed', reason: 'Its variations are in different states.', status: null, send: null },
  { id: 'r5', sku: 'HELMET-2027', market: 'eBay · IT', model: 'ebay-trading', facts: { isParent: true, isVariation: false }, state: 'draft', reason: 'In Nexus only. Publish creates it on the channel.', status: null, send: null },
  { id: 'r6', sku: 'GLOVES-OLD', market: 'Amazon · DE', model: 'amazon', facts: { isParent: false, isVariation: false }, state: 'active', status: null, send: { value: 'delete', setAt: at(2), setByName: 'Dev Owner' } },
]

const statusValueOf = (row: SheetRow): SellingStatusValue => ({
  state: row.state, reason: row.reason ?? null,
  waiting: row.status ? { target: row.status.value, setAt: row.status.setAt, setByName: row.status.setByName } : null,
})
const actionValueOf = (row: SheetRow): PublishActionValue => row.send
  ? { mode: row.send.value, setAt: row.send.setAt, setByName: row.send.setByName }
  : { mode: 'partial' }
/** The Status the editor opens on: the waiting target, else the live state's own target. */
const currentTarget = (row: SheetRow): StatusTarget | null => row.status?.value
  ?? (row.state === 'active' ? 'active' : row.state === 'paused' ? 'inactive' : row.state === 'ended' ? 'ended' : null)

const SHEET_ROW_ID = (p: { data: SheetRow }) => p.data.id
const SHEET_ROW_CLASS_RULES = { [SELLING_ROW_MARK_CLASS]: (p: { data?: SheetRow }) => rowCarriesInactiveMark([p.data?.state]) }

function useSheetColumns(setRows: (update: (rows: SheetRow[]) => SheetRow[]) => void): ColDef<SheetRow>[] {
  return useMemo<ColDef<SheetRow>[]>(() => {
    const patch = (id: string, change: Partial<SheetRow>) => setRows(rows => rows.map(r => (r.id === id ? { ...r, ...change } : r)))
    return [
      { colId: 'sku', headerName: 'SKU', field: 'sku', width: 150, editable: false },
      { colId: 'market', headerName: 'Market', field: 'market', width: 110, editable: false },
      {
        colId: 'status', headerName: 'Status', width: 200,
        valueGetter: p => (p.data ? statusValueOf(p.data) : undefined),
        cellRenderer: SellingStatusCell,
        tooltipValueGetter: p => sellingStatusModel(p.value as SellingStatusValue | undefined).tooltip,
        editable: p => Boolean(p.data && sellingStatusModel(statusValueOf(p.data)).editable),
        cellEditor: SelectPanelEditor, cellEditorPopup: true, cellEditorPopupPosition: 'under',
        cellEditorParams: (p: { data?: SheetRow }) => ({
          value: p.data ? currentTarget(p.data) : null,
          options: p.data ? statusEditorOptions(statusOptionsFor(p.data.state, p.data.model, p.data.facts), p.data.state, p.data.status ? { target: p.data.status.value, ...p.data.status } : null) : [],
        }),
        valueSetter: (p: ValueSetterParams<SheetRow>) => {
          const target = p.newValue as StatusTarget | null
          // Choosing the live state clears the waiting change; anything else waits for Publish.
          patch(p.data.id, { status: !target || STATUS_TARGET_SELLING_STATE[target] === p.data.state ? null : { value: target, setAt: new Date().toISOString(), setByName: 'You' } })
          return false
        },
      },
      {
        colId: 'action', headerName: 'Action', width: 150,
        valueGetter: p => (p.data ? actionValueOf(p.data) : undefined),
        cellRenderer: PublishActionCell,
        tooltipValueGetter: p => publishActionModel(p.value as PublishActionValue | undefined).tooltip,
        editable: true,
        cellEditor: SelectPanelEditor, cellEditorPopup: true, cellEditorPopupPosition: 'under',
        cellEditorParams: (p: { data?: SheetRow }) => ({
          value: p.data?.send?.value ?? 'partial',
          options: p.data ? sendModeEditorOptions(sendModeOptions(p.data.model, p.data.state, p.data.facts), p.data.send ? { mode: p.data.send.value, ...p.data.send } : null) : [],
        }),
        valueSetter: (p: ValueSetterParams<SheetRow>) => {
          const mode = (p.newValue as SendMode | null) ?? 'partial'
          patch(p.data.id, { send: mode === 'partial' ? null : { value: mode, setAt: new Date().toISOString(), setByName: 'You' } })
          return false
        },
      },
    ]
  }, [setRows])
}

// A caption and its cell side by side; at phone width the cell wraps under its caption instead of running off screen.
const row = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--nds-space-2) var(--nds-space-8)', minHeight: 32 } as const
const caption = { fontSize: 'var(--nds-font-size-sm)', color: 'var(--nds-text)' } as const
const spoken = { flex: '1 1 100%', fontSize: 'var(--nds-font-size-xs-plus)', color: 'var(--nds-text-muted)', margin: '0 0 var(--nds-space-6)' } as const
const heading = { fontSize: 'var(--nds-font-size-sm)', fontWeight: 700, color: 'var(--nds-text-strong)', margin: 'var(--nds-space-16) 0 var(--nds-space-8)' } as const

export function SellingStatusExample() {
  // Times are relative to the viewer's clock: draw the samples after mount, so the server and first client render agree.
  const [now, setNow] = useState<number | null>(null)
  useEffect(() => setNow(Date.now()), [])
  const [rows, setRowsState] = useState<SheetRow[] | null>(null)
  useEffect(() => setRowsState(seedRows()), [])
  const setRows = useCallback((update: (rows: SheetRow[]) => SheetRow[]) => setRowsState(rows => (rows ? update(rows) : rows)), [])
  const columns = useSheetColumns(setRows)
  const [typed, setTyped] = useState('')
  const [deleted, setDeleted] = useState(false)
  const phrase = 'GLOVES-OLD'
  const armed = phraseMatches(typed, phrase)
  const mounted = now != null

  return (
    <div id="selling-status-example" style={{ display: 'flex', flexDirection: 'column', maxWidth: 640, color: 'var(--nds-text)', fontSize: 'var(--nds-font-size-base)' }}>
      <h4 style={{ ...heading, marginTop: 0 }}>Status cell · every state</h4>
      {STATUS_SAMPLES.map(sample => {
        const value = mounted && sample.value ? sample.value() : undefined
        return (
          <div key={sample.label} style={row}>
            <span style={{ ...caption, flex: '0 0 170px' }}>{sample.label}</span>
            <span style={{ minWidth: 0, maxWidth: '100%' }}><SellingStatusView value={value} now={now ?? undefined} /></span>
            <p style={spoken}>{sellingStatusModel(value, now ?? undefined).ariaLabel}</p>
          </div>
        )
      })}

      <h4 style={heading}>Action cell · quiet default, waiting values</h4>
      {ACTION_SAMPLES.map(sample => {
        const value = mounted ? sample.value() : undefined
        return (
          <div key={sample.label} style={row}>
            <span style={{ ...caption, flex: '0 0 170px' }}>{sample.label}</span>
            <span style={{ minWidth: 0, maxWidth: '100%' }}><PublishActionView value={value} now={now ?? undefined} /></span>
            <p style={spoken}>{publishActionModel(value, now ?? undefined).ariaLabel}</p>
          </div>
        )
      })}

      <h4 style={heading}>In the sheet · row-start mark on inactive rows, editors with refused values</h4>
      <p style={{ ...caption, margin: '0 0 var(--nds-space-8)' }}>
        Enter on a Status or Action cell opens its list. A refused value stays in the list with its reason under it and cannot be chosen.
        Nothing here is sent: Publish sends waiting values after the review.
      </p>
      {rows && (
        <NexusGrid<SheetRow> density="cozy" domLayout="autoHeight" rowData={rows} getRowId={SHEET_ROW_ID} columnDefs={columns}
          rowClassRules={SHEET_ROW_CLASS_RULES} tooltipShowDelay={300} suppressCellFocus={false} />
      )}

      <h4 style={heading}>Status editor · as it opens on an Amazon FBA row</h4>
      <div style={{ maxWidth: 320 }}>
        <ListboxPanel autoFocus={false} ariaLabel="Status, GALE-JACKET-L on Amazon · DE" style={{ position: 'static', minWidth: 0, maxWidth: '100%' }} value="active" onCommit={() => {}} onCancel={() => {}}
          options={statusEditorOptions(statusOptionsFor('paused', 'amazon', { isFba: true }), 'paused', { target: 'active', setAt: mounted ? at(45) : null, setByName: 'Awais' }, now ?? undefined)} />
      </div>

      <h4 style={heading}>Typed confirmation · ConfirmPhraseField</h4>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--nds-space-8)', maxWidth: 360 }}>
        <ConfirmPhraseField phrase={phrase} value={typed} onChange={value => { setTyped(value); setDeleted(false) }} />
        <div>
          <Button variant="danger" disabled={!armed} onClick={() => { if (armed) setDeleted(true) }}>Publish · delete 1 listing</Button>
        </div>
        <p style={{ ...caption, margin: 0 }} aria-live="polite">{deleted ? 'Confirmed (sample: nothing was sent).' : armed ? 'Ready to confirm.' : 'Type the SKU to arm the button.'}</p>
      </div>
    </div>
  )
}
