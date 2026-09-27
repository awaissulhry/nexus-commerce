'use client'

import { useMemo } from 'react'
import type { MediaOp, MediaSetRef } from '@nexus/shared/media-plan'
import type { MediaAsset } from '@nexus/shared/media-plan-channels'

import { Disclosure, MediaBoard, SourceIndicator, type MediaBoardItem, type MediaBoardMove, type MediaBoardRow } from '@/design-system/components'
import { Button, Tag } from '@/design-system/primitives'

import { CHANNEL_LABEL, assetProblems, setRows, shownVersion, swatchRows, type LayerView, type MediaRead, type SetRow } from './model'
import styles from './planPage.module.css'

export interface PlanBoardProps {
  read: MediaRead
  view: LayerView
  /** The channel of the edited layer (limits and words shown per row), or null on Shared. */
  channel: keyof typeof CHANNEL_LABEL | null
  assets: Map<string, MediaAsset>
  /** "Show as": the languages whose versions the tiles show; null = the placed versions. */
  languages: string[] | null
  showSkus: boolean
  /** Only these sets, in this order (the Information sheet's set editor); swatches are left out. */
  refs?: MediaSetRef[]
  edit(ops: MediaOp[], label: string): void
  onAddRequest(ref: MediaSetRef, label: string): void
  onOpen(assetId: string): void
  disabled?: boolean
}

const LIMIT: Partial<Record<string, { common: number; value: number }>> = { EBAY: { common: 24, value: 12 } }

/** The photo plan of one layer: Common, one row per value, safety, per-SKU sets — and the swatches (PLAN.md §5.1, §5.4). */
export function PlanBoard({ read, view, channel, assets, languages, showSkus, refs, edit, onAddRequest, onOpen, disabled = false }: PlanBoardProps) {
  const rows = useMemo(() => {
    const all = setRows(read, view, { skus: showSkus || !!refs })
    if (refs) return refs.flatMap(ref => all.filter(r => r.ref === ref))
    return all.filter(r => r.kind !== 'safety' || channel === null || channel === 'AMAZON')
  }, [read, view, showSkus, refs, channel])
  const common = rows.find(r => r.ref === 'common')
  const label = (id: string) => read.library.find(a => a.id === id)?.label ?? 'Photo'

  const item = (row: SetRow, id: string): MediaBoardItem => {
    const shown = shownVersion(read, assets, id, languages)
    const asset = read.library.find(a => a.id === shown.id)
    const problems = asset ? assetProblems(asset) : ['Deleted from the library']
    const alsoInCommon = row.ref !== 'common' && !!common?.items.includes(id)
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

  const from = (row: SetRow) => row.source === 'CHANNEL' ? `all ${channel ? CHANNEL_LABEL[channel] : ''} listings` : 'Shared'
  const source = (row: SetRow) => {
    if (view.layer === 'SHARED') return row.source === null && row.kind !== 'common' ? <span className={styles.muted}>No photos yet</span> : null
    return row.source === view.layer
      ? <SourceIndicator kind="override" showLabel label="Own photos" description={`Only ${view.layer === 'CHANNEL' ? (channel ? CHANNEL_LABEL[channel] : 'this channel') : 'this listing'} uses these photos for ${row.label}.`} />
      : <SourceIndicator kind={row.source === 'CHANNEL' ? 'channel' : 'master'} showLabel label={`Follows ${from(row)}`}
          description={`${row.label} shows the photos set on ${from(row)}. Editing it here gives this ${view.layer === 'CHANNEL' ? 'channel' : 'listing'} its own copy.`} />
  }
  /** The row's buttons: add photos, and — below Shared — take an own copy or follow again. */
  const actions = (row: SetRow) => <>
    <Button size="xs" variant="secondary" disabled={disabled} onClick={() => onAddRequest(row.ref, row.label)} aria-label={`Add photos to ${row.label}`}>＋ Add</Button>
    {view.layer !== 'SHARED' && (row.source === view.layer
      ? <Button size="xs" variant="ghost" disabled={disabled} onClick={() => edit([{ op: 'follow', set: row.ref }], `Follow again: ${row.label}`)} aria-label={`${row.label}: follow again`}>Follow again</Button>
      : <Button size="xs" variant="ghost" disabled={disabled} onClick={() => edit([{ op: 'own', set: row.ref }], `Use own photos: ${row.label}`)} aria-label={`${row.label}: use own photos`}>Use own photos</Button>)}
  </>

  const limitText = (row: SetRow) => {
    const limit = channel ? LIMIT[channel] : undefined
    const count = `${row.items.length} photo${row.items.length === 1 ? '' : 's'}`
    const skus = row.kind === 'value' ? ` · ${row.skus.length} SKU${row.skus.length === 1 ? '' : 's'}` : ''
    if (!limit || (row.kind !== 'common' && row.kind !== 'value')) return `${count}${skus}`
    return `${row.items.length} / ${row.kind === 'common' ? limit.common : limit.value}${skus}`
  }

  const boardRows: MediaBoardRow[] = rows.map(row => ({
    id: row.ref, label: row.label, detail: limitText(row), source: source(row),
    actions: actions(row),
    items: row.items.map(id => item(row, id)), editable: !disabled,
    emptyLabel: row.kind === 'common' ? 'No common photos — every channel needs at least one' : row.kind === 'value' ? `No ${row.label} photos — drop photos here` : 'No photos — drop photos here',
  }))
  const rowLabel = (ref: string) => rows.find(r => r.ref === ref)?.label ?? 'the set'

  const onMove = (move: MediaBoardMove) => {
    const from = move.from as MediaSetRef, to = move.to as MediaSetRef
    if (move.copy) edit([{ op: 'insert', set: to, assetIds: [move.itemId], index: move.index }], `Also use ${label(move.itemId)} in ${rowLabel(to)}`)
    else edit([{ op: 'move', from, to, assetId: move.itemId, index: move.index }],
      from === to ? (move.index === 0 ? `Make ${label(move.itemId)} the main photo` : `Reorder ${rowLabel(from)}`) : `Move ${label(move.itemId)} to ${rowLabel(to)}`)
  }

  const swatches = swatchRows(read, view)
  const swatchBoard: MediaBoardRow[] = swatches.map(s => {
    const id = s.assetId
    return { id: `swatch:${s.value}`, label: `${s.label} swatch`, detail: s.source && view.layer !== 'SHARED' && s.source !== view.layer ? 'Follows the layer above' : undefined,
      items: id ? [item({ ref: 'common', label: '', kind: 'common', items: [], source: null, skus: [] }, id)] : [], editable: !disabled, emptyLabel: 'No swatch' }
  })
  const valueOf = (rowId: string) => rowId.slice('swatch:'.length)

  return <div className={styles.planBoard}>
    <MediaBoard label={`Photo sets${view.layer === 'SHARED' ? '' : ` for ${view.layer === 'CHANNEL' ? 'this channel' : 'this listing'}`}`}
      rows={boardRows} onMove={onMove} disabled={disabled}
      onDropExternal={drop => edit([{ op: 'insert', set: drop.to as MediaSetRef, assetIds: drop.itemIds, index: drop.index }], `Add ${drop.itemIds.length} photo${drop.itemIds.length > 1 ? 's' : ''} to ${rowLabel(drop.to)}`)}
      onRemove={(ref, id) => edit([{ op: 'remove', set: ref as MediaSetRef, assetId: id }], `Remove ${label(id)} from ${rowLabel(ref)}`)}
      onOpen={(_, id) => onOpen(id)} />
    {!refs && swatchBoard.length > 0 && (channel === null || channel === 'AMAZON') && <Disclosure summary={`Swatches (Amazon SWCH) · ${swatches.filter(s => s.assetId).length} of ${swatches.length}`}>
      <MediaBoard label="Swatches" rows={swatchBoard} allowCopy={false} disabled={disabled} firstLabel="Swatch"
        onMove={move => move.from !== move.to && edit([{ op: 'swatch', value: valueOf(move.to), assetId: move.itemId }, { op: 'swatch', value: valueOf(move.from), assetId: view.layer === 'SHARED' ? undefined : null }], `Move swatch to ${valueOf(move.to)}`)}
        onDropExternal={drop => edit([{ op: 'swatch', value: valueOf(drop.to), assetId: drop.itemIds[0] }], `Set the swatch of ${swatches.find(s => `swatch:${s.value}` === drop.to)?.label ?? 'a value'}`)}
        onRemove={rowId => edit([{ op: 'swatch', value: valueOf(rowId), assetId: view.layer === 'SHARED' ? undefined : null }], 'Remove a swatch')}
        onOpen={(_, id) => onOpen(id)} />
    </Disclosure>}
  </div>
}
