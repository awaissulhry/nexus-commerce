'use client'

import { useMemo, useState } from 'react'
import { mediaLayerKey, type MediaOp, type MediaSetRef } from '@nexus/shared/media-plan'

import { Banner, MediaPreview, Modal } from '@/design-system/components'
import { Button, SegmentedControl, Spinner, TooltipPortalProvider } from '@/design-system/primitives'

import { useStudioScope } from '../contracts'
import { LibraryPanel, type AddTarget } from '../images/plan-page/LibraryPanel'
import { PlanBoard } from '../images/plan-page/PlanBoard'
import { assetMap, destinationLabel, libraryUsage, setRows, viewAxis, viewStack, type LayerView, type MediaChannel } from '../images/plan-page/model'
import { useMediaPlan } from '../images/plan-page/useMediaPlan'
import type { PlanAddress } from './planCellTransfer'
import styles from './media.module.css'

/**
 * Images rebuild P3c — the "Product media" cell's editor for a family on the photo plan (PLAN.md §5.7). It is the Media
 * page's own set editor (`PlanBoard` + `LibraryPanel` on the same read and the same saving), limited to the row's set:
 * Common on the parent; on a variant its value's set (every SKU of the value) or, with "This SKU only", its own set.
 * Edits save at once, like the Media page; nothing is sent to a channel.
 */
export function PlanSetDialog({ productId, rowProductId, title, address, language, anchor, onClose }: {
  /** Any product of the family (the plan belongs to the family root). */
  productId: string
  rowProductId: string
  title: string
  /** `null`: a channel sheet row with no account — it has no photo layer of its own. */
  address: PlanAddress | null
  /** The sheet's language: each photo shows that language's version; `null` = the placed versions. */
  language: string | null
  anchor: HTMLElement | null
  /** `edited`: the sheet refreshes the family's rows. */
  onClose(edited: boolean): void
}) {
  const plan = useMediaPlan(productId)
  const { setTab } = useStudioScope()
  const [edited, setEdited] = useState(false)
  const [pending, setPending] = useState<AddTarget | null>(null)
  const [viewing, setViewing] = useState<string | null>(null)
  const close = () => onClose(edited)

  const read = plan.state.status === 'ready' ? plan.state.read : null
  const view: LayerView | null = useMemo(() => {
    if (!address) return null
    if (address.layer === 'SHARED') return { layer: 'SHARED' }
    const channel = address.channel as MediaChannel
    const key = mediaLayerKey({ layer: 'LISTING', channel, marketplace: channel === 'EBAY' ? address.marketplace : 'GLOBAL', accountId: address.accountId, aliasKey: channel === 'AMAZON' ? '' : address.aliasKey })
    return read?.destinations.some(d => d.key === key) ? { layer: 'LISTING', destination: key } : null
  }, [address, read])
  const assets = useMemo(() => read ? assetMap(read) : new Map(), [read])
  const usage = useMemo(() => read ? libraryUsage(read) : new Map<string, string[]>(), [read])

  const body = (() => {
    if (plan.state.status === 'loading') return <p role="status"><Spinner size={14} /> Loading the photo plan…</p>
    if (plan.state.status === 'error') return <Banner tone="danger" title="The photo plan could not be loaded" action={<Button size="sm" onClick={() => void plan.reload()}>Try again</Button>}>{plan.state.message}</Banner>
    if (!read || !view) return <Banner tone="warning" title="This listing has no photos of its own here">It is not one of the product's photo destinations yet (no account, or not listed). Open the Media page to see every destination.</Banner>
    const edit = (ops: MediaOp[], label: string) => { setEdited(true); void plan.edit(view, ops, label) }
    const rows = setRows(read, view, { skus: true })
    const variant = read.family.variants.find(v => v.productId === rowProductId)
    const skuRef: MediaSetRef = `sku:${rowProductId}`
    const sku = rows.find(r => r.ref === skuRef)
    const { axis } = viewAxis(read, viewStack(read, view))
    const valueRef = variant && axis && variant.values[axis] ? `value:${variant.values[axis]}` as MediaSetRef : null
    const value = rows.find(r => r.ref === valueRef)
    const skuOnly = !!variant && !!sku && sku.source !== null
    const mainRef: MediaSetRef = !variant ? 'common' : skuOnly ? skuRef : valueRef ?? 'common'
    const refs: MediaSetRef[] = mainRef === 'common' ? ['common'] : [mainRef, 'common']
    // A SKU's own set made on a layer above this sheet's (e.g. on Shared, seen from a channel sheet) is changed there.
    const skuElsewhere = skuOnly && sku!.source !== view.layer
    const targets: AddTarget[] = refs.map(ref => ({ id: ref, label: rows.find(r => r.ref === ref)?.label ?? ref, group: 'Sets' as const }))
    return <div className={styles.planDialog}>
      <p className={styles.note}>
        {view.layer === 'SHARED' ? 'Shared photos — every channel follows them unless a listing has its own.' : `Only ${destinationLabel(read.destinations.find(d => d.key === view.destination)!)} — its own layer.`}
        {' '}Changes save at once. Nothing is sent to a channel until you publish.
      </p>
      {variant && value && <SegmentedControl ariaLabel="Whose photos" size="sm" value={skuOnly ? 'sku' : 'value'} disabled={skuElsewhere}
        onChange={next => next === 'sku'
          ? edit([{ op: 'replace', set: skuRef, assetIds: value.items }], `Give ${variant.sku} its own photos`)
          : edit([{ op: 'follow', set: skuRef }], `${variant.sku} shows the ${value.label} photos again`)}
        options={[{ value: 'value', label: `${value.label} · all ${value.skus.length} SKU${value.skus.length === 1 ? '' : 's'}` }, { value: 'sku', label: `This SKU only (${variant.sku})` }]} />}
      {skuElsewhere && <p className={styles.note}>This SKU has its own photos on a layer above this sheet. Change them on the Media page.</p>}
      {plan.writeError && <Banner tone="danger" title="Not saved" onDismiss={plan.clearWriteError}
        action={plan.writeError.retry ? <Button size="sm" onClick={plan.writeError.retry}>Retry</Button> : undefined}>{plan.writeError.message}</Banner>}
      <PlanBoard read={read} view={view} channel={view.layer === 'SHARED' ? null : read.destinations.find(d => d.key === view.destination)?.channel ?? null}
        assets={assets} languages={language ? [language] : null} showSkus={false} refs={refs}
        edit={edit} onAddRequest={(ref, label) => setPending({ id: ref, label, group: 'Sets' })} onOpen={setViewing} />
      <LibraryPanel read={read} usage={usage} targets={targets} pendingTarget={pending} onClearPending={() => setPending(null)}
        onAdd={(target, ids) => edit([{ op: 'insert', set: target.id as MediaSetRef, assetIds: ids }], `Add ${ids.length} photo${ids.length > 1 ? 's' : ''} to ${target.label}`)}
        onOpen={asset => setViewing(asset.id)} onManage={() => { close(); setTab('images') }} onDragging={plan.hold} draggable />
    </div>
  })()

  const viewingAsset = viewing && read ? read.library.find(a => a.id === viewing) ?? null : null
  return <TooltipPortalProvider>
    <Modal open readable anchor={anchor} size="xl" title={`Product media · ${title}`} subtitle="Photo plan" onClose={close} footer={<>
      <Button size="sm" disabled={!plan.canUndo} onClick={() => plan.undo()}>{plan.undoLabel ? `Undo: ${plan.undoLabel}` : 'Undo'}</Button>
      <Button size="sm" onClick={() => { close(); setTab('images') }}>Open the Media page</Button>
      <Button size="sm" variant="primary" onClick={close}>Done</Button>
    </>}>
      {body}
    </Modal>
    {viewingAsset && <Modal open readable size="lg" title={viewingAsset.label} onClose={() => setViewing(null)}>
      <MediaPreview type={viewingAsset.mediaType} url={viewingAsset.url} label={viewingAsset.label} />
    </Modal>}
  </TooltipPortalProvider>
}
