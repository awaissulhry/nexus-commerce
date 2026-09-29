'use client'

import { useMemo } from 'react'
import type { MediaOp, MediaSetRef } from '@nexus/shared/media-plan'
import type { MediaAsset } from '@nexus/shared/media-plan-channels'

import { MediaBoard, type MediaBoardItem, type MediaBoardMove, type MediaBoardRow } from '@/design-system/components'
import { Button, Tag } from '@/design-system/primitives'

import { assetProblems, gridShape, ownerLabel, setRows, shownVersion, swatchRows, type LayerView, type MediaDestinationRow, type MediaRead, type SetRow } from './model'
import styles from './planPage.module.css'

/** Where "Add" puts photos: a set of the edited layer, or one value's swatch (one photo). */
export interface AddTarget { id: string; label: string; group: 'Sets' | 'Swatches'; one?: boolean }

export interface PhotoGridProps {
  read: MediaRead
  /** Shared, or the destination the scope selector points at (its own layer). */
  view: LayerView
  destination: MediaDestinationRow | null
  assets: Map<string, MediaAsset>
  /** The languages whose versions the tiles show; null = the placed versions (Shared). */
  languages: string[] | null
  showSkus: boolean
  edit(view: LayerView, ops: MediaOp[], label: string): void
  onAddRequest(target: AddTarget): void
  onOpen(assetId: string): void
}

/**
 * The Media page's one photo grid (redesign 2026-09-29): rows = sets (Common, each value, Safety, per-SKU sets), columns
 * = slots (MAIN, PT01…), the swatches below. On a destination it shows what that destination gets: Shared unless a row
 * is its own, marked on the row with "Reset to shared". A change on a destination makes the row its own.
 */
export function PhotoGrid({ read, view, destination: d, assets, languages, showSkus, edit, onAddRequest, onOpen }: PhotoGridProps) {
  const channel = d?.channel ?? null
  const shape = gridShape(channel)
  const rows = useMemo(() => setRows(read, view, { skus: showSkus }).filter(r => r.kind !== 'safety' || channel === null || channel === 'AMAZON'), [read, view, showSkus, channel])
  const common = rows.find(r => r.ref === 'common')
  const label = (id: string) => read.library.find(a => a.id === id)?.label ?? 'Photo'
  const rowLabel = (ref: string) => rows.find(r => r.ref === ref)?.label ?? 'the set'
  const run = (ops: MediaOp[], text: string) => edit(view, ops, text)

  const item = (row: SetRow | null, id: string): MediaBoardItem => {
    const shown = shownVersion(read, assets, id, languages)
    const asset = read.library.find(a => a.id === shown.id)
    const problems = asset ? assetProblems(asset) : ['Deleted from the library']
    const alsoInCommon = !!row && row.ref !== 'common' && !!common?.items.includes(id)
    return {
      id, src: asset?.mediaType === 'VIDEO' ? null : asset?.url ?? null, label: asset?.label ?? 'Deleted photo', mediaType: asset?.mediaType,
      tone: !asset ? 'danger' : !shown.exact ? 'warning' : undefined,
      badges: <>
        {shown.language !== 'zxx' && <Tag tone={shown.exact ? 'info' : 'warning'}>{shown.exact ? shown.language.toUpperCase() : `shows ${shown.language.toUpperCase()}`}</Tag>}
        {alsoInCommon && <Tag tone="neutral">also in Common</Tag>}
        {problems.slice(0, 1).map(p => <Tag key={p} tone={asset ? 'warning' : 'danger'}>{p}</Tag>)}
      </>,
    }
  }

  /** A row that is not Shared: its owner, and the way back. Nothing on a row that shows Shared. */
  const mark = (row: SetRow) => {
    if (!d) return row.source === null && row.kind !== 'common' ? <span className={styles.muted}>No photos yet</span> : null
    const owner = ownerLabel(read, row, d)
    if (!owner) return null
    const reset = () => row.source === 'CHANNEL'
      ? edit({ layer: 'CHANNEL', channel: d.channel }, [{ op: 'follow', set: row.ref }], `Reset to shared: ${row.label}`)
      : run([{ op: 'follow', set: row.ref }], `Reset to shared: ${row.label}`)
    return <>
      <Tag tone="info">{owner}</Tag>
      <Button size="xs" variant="ghost" onClick={reset} aria-label={`${row.label}: reset to shared`}>Reset to shared</Button>
    </>
  }

  const detail = (row: SetRow) => {
    const skus = row.kind === 'value' ? ` · ${row.skus.length} SKU${row.skus.length === 1 ? '' : 's'}` : ''
    const size = shape.capacity(row.kind)
    return channel === 'EBAY' && (row.kind === 'common' || row.kind === 'value') ? `${row.items.length} / ${size}${skus}` : `${row.items.length} photo${row.items.length === 1 ? '' : 's'}${skus}`
  }

  const boardRows: MediaBoardRow[] = rows.map(row => ({
    id: row.ref, label: row.kind === 'safety' ? 'Safety' : row.label, detail: detail(row), source: mark(row),
    items: row.items.map(id => item(row, id)), capacity: shape.capacity(row.kind), slots: shape.slots(row.kind),
  }))

  const onMove = (move: MediaBoardMove) => {
    const from = move.from as MediaSetRef, to = move.to as MediaSetRef
    if (move.copy) run([{ op: 'insert', set: to, assetIds: [move.itemId], index: move.index }], `Also use ${label(move.itemId)} in ${rowLabel(to)}`)
    else run([{ op: 'move', from, to, assetId: move.itemId, index: move.index }],
      from === to ? (move.index === 0 ? `Make ${label(move.itemId)} the main photo` : `Reorder ${rowLabel(from)}`) : `Move ${label(move.itemId)} to ${rowLabel(to)}`)
  }

  // Swatches (Amazon SWCH): one slot per value, on Shared and Amazon only.
  const swatches = channel === null || channel === 'AMAZON' ? swatchRows(read, view) : []
  const valueOf = (rowId: string) => rowId.slice('swatch:'.length)
  const swatchBoard: MediaBoardRow[] = swatches.map(s => ({
    id: `swatch:${s.value}`, label: `${s.label} swatch`, capacity: 1,
    detail: d && s.source === 'LISTING' ? ownerLabel(read, { source: 'LISTING' }, d) ?? undefined : undefined,
    items: s.assetId ? [item(null, s.assetId)] : [],
  }))

  return <div className={styles.grid}>
    <MediaBoard label={d ? 'Photo sets for this destination' : 'Photo sets'} rows={boardRows} slots={shape.columns}
      onMove={onMove} onAddRequest={ref => onAddRequest({ id: ref, label: rowLabel(ref), group: 'Sets' })}
      onDropExternal={drop => run([{ op: 'insert', set: drop.to as MediaSetRef, assetIds: drop.itemIds, index: drop.index }], `Add ${drop.itemIds.length} photo${drop.itemIds.length > 1 ? 's' : ''} to ${rowLabel(drop.to)}`)}
      onRemove={(ref, id) => run([{ op: 'remove', set: ref as MediaSetRef, assetId: id }], `Remove ${label(id)} from ${rowLabel(ref)}`)}
      onOpen={(_, id) => onOpen(id)} />
    {swatchBoard.length > 0 && <MediaBoard label="Swatches" rows={swatchBoard} slots={['SWCH']} allowCopy={false} firstLabel="Swatch"
      onAddRequest={rowId => onAddRequest({ id: rowId, label: `${swatches.find(s => `swatch:${s.value}` === rowId)?.label ?? 'a value'} swatch`, group: 'Swatches', one: true })}
      onMove={move => move.from !== move.to && run([{ op: 'swatch', value: valueOf(move.to), assetId: move.itemId }, { op: 'swatch', value: valueOf(move.from), assetId: view.layer === 'SHARED' ? undefined : null }], `Move swatch to ${valueOf(move.to)}`)}
      onDropExternal={drop => run([{ op: 'swatch', value: valueOf(drop.to), assetId: drop.itemIds[0] }], `Set the swatch of ${swatches.find(s => `swatch:${s.value}` === drop.to)?.label ?? 'a value'}`)}
      onRemove={rowId => run([{ op: 'swatch', value: valueOf(rowId), assetId: view.layer === 'SHARED' ? undefined : null }], 'Remove a swatch')}
      onOpen={(_, id) => onOpen(id)} />}
  </div>
}
