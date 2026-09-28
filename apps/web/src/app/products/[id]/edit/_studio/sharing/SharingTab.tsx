'use client'

/**
 * Sharing studio step 2 — the product studio's "Other businesses" page (plan docs/2026-09-28-sharing-review-and-plan.md
 * §5, step 2; Owner R-SH-1: Settings keeps the deal between businesses, this page shows ONE product).
 *
 *   Comes from another business   the link this product follows, each followed field's source, "Follow again"
 *   Shared with other businesses  the assortments that hold it (add / take out) and what each business does with it
 *   Stock                         where its stock comes from, and who sells from this business's stock of it
 *
 * Every badge is a reading from the API (links, shares, grants), never a guess on the page. An action this person may
 * not take is not shown disabled: the page says why instead.
 */
import { useCallback, useEffect, useId, useState } from 'react'

import { ActionConfirm, Banner, Card, EmptyState, KeyValue, ProgressBar, SourceIndicator } from '@/design-system/components'
import type { ActionImpact } from '@/design-system/grid'
import { DataGrid, type Column } from '@/design-system/grid/datagrid'
import { Button, Pill, TooltipPortalProvider } from '@/design-system/primitives'
import Link from '@/lib/workspaces/Link'
import { usePermission } from '@/lib/auth/AuthProvider'
import { PoolSourceNote } from '@/app/_shared/stock-pool/PoolSourceTag'

import { useStudioProduct } from '../contracts'
import { LayoutCard } from './LayoutCard'
import { followAgain, readSharing, setInAssortment, type AssortmentPlace, type LentUsage, type ProductSharing, type ShareCopy, type SharedField } from './sharingApi'
import {
  businessName, copyWords, count, detachedWords, fieldListWords, fieldName, fieldSource, followingFacts, holdsWords, placeActionLabel, shareStateWords, stockWords, takeOutImpact,
} from './sharingWords'
import styles from './sharing.module.css'

type Notice = { tone: 'success' | 'danger'; text: string } | null

export function SharingTab() {
  const product = useStudioProduct()
  const canEdit = usePermission('products.edit')
  const [view, setView] = useState<{ data?: ProductSharing; error?: string }>({})
  const [reload, setReload] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice>(null)
  const [confirm, setConfirm] = useState<{ impact: ActionImpact; run: () => void } | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    void readSharing(product.id, controller.signal).then((result) => {
      if (controller.signal.aborted) return
      setView(result.ok ? { data: result.data } : { error: result.message })
    })
    return () => controller.abort()
  }, [product.id, reload])

  const act = useCallback(async (key: string, work: () => Promise<{ ok: boolean; message?: string }>, done: string) => {
    setBusy(key)
    setNotice(null)
    const result = await work()
    setBusy(null)
    setNotice(result.ok ? { tone: 'success', text: done } : { tone: 'danger', text: result.message ?? 'The change was not saved.' })
    if (result.ok) setReload((n) => n + 1)
  }, [])

  const data = view.data
  return (
    <TooltipPortalProvider>
      <div className={styles.page}>
        <header className={styles.head}>
          <h2 className={styles.title}>Other businesses</h2>
          <p className={styles.lead}>How this product is shared between your business profiles. The deals themselves — what is offered to whom, and shared stock — are in Settings › Shared products.</p>
        </header>
        {!data && !view.error && <ProgressBar indeterminate ariaLabel="Reading how this product is shared" />}
        {view.error && <Banner tone="danger" title="This page could not be read" action={<Button onClick={() => setReload((n) => n + 1)}>Try again</Button>}>{view.error}</Banner>}
        {notice && <div role="status"><Banner tone={notice.tone}>{notice.text}</Banner></div>}
        {data && <>
          <Following data={data} canEdit={canEdit} busy={busy}
            onFollowAgain={(fields, label) => act(`follow:${label}`, async () => {
              const result = await followAgain(data.following!.link.id, fields)
              return result.ok ? { ok: true } : { ok: false, message: result.message }
            }, `${label} follows ${businessName(data.following!.link.sourceBusiness)} again. The next update brings its value here.`)} />
          {data.following?.link.status === 'active' && <LayoutCard productId={data.product.id} canEdit={canEdit} />}
          <SharedOut data={data} canEdit={canEdit} busy={busy}
            onChange={(place, holds) => {
              const run = () => act(`place:${place.id}`, async () => {
                const result = await setInAssortment(place.id, data.product.id, holds, place.version)
                return result.ok ? { ok: true } : { ok: false, message: result.message }
              }, holds ? `${place.name} holds this product now.` : `${place.name} no longer holds this product.`)
              const impact = holds ? null : takeOutImpact(place, data.product, data.sharedOut.businesses)
              if (impact) setConfirm({ impact, run: () => { setConfirm(null); void run() } })
              else void run()
            }} />
          <Stock data={data} />
        </>}
        {confirm && <ActionConfirm impact={confirm.impact} onConfirm={confirm.run} onCancel={() => setConfirm(null)} />}
      </div>
    </TooltipPortalProvider>
  )
}

/** Each table fits its rows, up to this height; a longer list scrolls inside its own box. */
const GRID_MAX = 480

const EDIT_REASON = 'You can see this. Changing it needs the “Edit products” permission.'

function Following({ data, canEdit, busy, onFollowAgain }: {
  data: ProductSharing; canEdit: boolean; busy: string | null
  onFollowAgain: (fields: string[] | 'all', label: string) => void
}) {
  const [showFollowed, setShowFollowed] = useState(false)
  const followedId = useId()
  const following = data.following
  if (!following) {
    return <Card header="Comes from another business" headingLevel={3}>
      <p className={styles.text}>This product is this business’s own. It does not follow a product of another business.</p>
    </Card>
  }
  const { link, fields } = following
  if (link.status !== 'active') {
    const words = detachedWords(link)
    return <Card header="Comes from another business" headingLevel={3}>
      <Banner tone="neutral" title={words.title}>{words.body}</Banner>
    </Card>
  }
  const kept = fields.filter((f) => f.state === 'override')
  const followed = fields.filter((f) => f.state === 'follow')
  const list = fieldListWords(kept.length, followed.length, link.sourceBusiness, showFollowed)
  const base: Array<Column<SharedField>> = [
    { key: 'field', label: 'Field', render: (f) => fieldName(f) },
    { key: 'group', label: 'Group', render: (f) => f.group },
    { key: 'source', label: 'Value', render: (f) => <SourceIndicator {...fieldSource(f, link.sourceBusiness)} showLabel /> },
  ]
  const keptColumns: Array<Column<SharedField>> = canEdit ? [...base, {
    key: 'action', label: <span className={styles.srOnly}>Action</span>,
    render: (f: SharedField) => <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => onFollowAgain([f.key], fieldName(f))}>Follow again</Button>,
  }] : base
  return <Card header="Comes from another business" headingLevel={3}
    description={`This product follows a product of ${businessName(link.sourceBusiness)}. A field this business changes keeps its own value.`}
    headerAction={canEdit && kept.length > 1 ? <Button variant="secondary" disabled={busy !== null} onClick={() => onFollowAgain('all', `Every kept field (${kept.length})`)}>Follow again: all {kept.length}</Button> : undefined}>
    <div className={styles.stack}>
      <KeyValue columns={2} items={followingFacts(link, fields)} />
      {link.heldSku && <Banner tone="warning" title={`SKU change waiting: ${data.product.sku} → ${link.heldSku}`}>{link.heldReason}</Banner>}
      {link.lastSyncError && <Banner tone="warning" title="Some changes from there could not be applied">
        {link.lastSyncError.split('\n').filter(Boolean).map((line) => <p key={line} className={styles.line}>{line}</p>)}
      </Banner>}
      {!canEdit && kept.length > 0 && <p className={styles.note}>{EDIT_REASON}</p>}
      {list.keptTitle && <>
        <h4 className={styles.subhead}>{list.keptTitle}</h4>
        <DataGrid maxHeight={GRID_MAX} ariaLabel="Fields this business keeps" columns={keptColumns} rows={kept} rowKey={(f) => f.key} />
      </>}
      {list.none && <p className={styles.text}>{list.none}</p>}
      {list.toggle && <div><Button variant="secondary" aria-expanded={showFollowed} aria-controls={followedId} onClick={() => setShowFollowed((open) => !open)}>{list.toggle}</Button></div>}
      {showFollowed && <div id={followedId}><DataGrid maxHeight={GRID_MAX} ariaLabel="Fields that follow the other business" columns={base} rows={followed} rowKey={(f) => f.key} /></div>}
    </div>
  </Card>
}

function SharedOut({ data, canEdit, busy, onChange }: {
  data: ProductSharing; canEdit: boolean; busy: string | null
  onChange: (place: AssortmentPlace, holds: boolean) => void
}) {
  const { assortments, businesses } = data.sharedOut
  const settings = <Button asChild variant="secondary"><Link href="/settings/sharing">Open Settings › Shared products</Link></Button>
  if (!assortments.length) {
    return <Card header="Shared with other businesses" headingLevel={3}>
      <EmptyState title="No assortments yet" description="An assortment is a set of products this business offers to another business profile. Create one in Settings › Shared products." action={settings} />
    </Card>
  }
  const places: Array<Column<AssortmentPlace>> = [
    { key: 'name', label: 'Assortment', render: (p) => p.name },
    { key: 'holds', label: 'Holds this product', render: (p) => holdsWords(p, data.product) },
    { key: 'offered', label: 'Offered to', render: (p) => p.openShares ? count(p.openShares, 'business', 'businesses') : 'Nobody yet' },
    ...(canEdit ? [{
      key: 'action', label: <span className={styles.srOnly}>Action</span>,
      render: (p: AssortmentPlace) => <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => onChange(p, !p.holds)}>{placeActionLabel(p)}</Button>,
    }] : []),
  ]
  const copies: Array<Column<ShareCopy>> = [
    { key: 'business', label: 'Business', render: (c) => c.businessName },
    { key: 'assortment', label: 'Through', render: (c) => c.assortmentName },
    { key: 'share', label: 'Share', render: (c) => { const s = shareStateWords(c.shareStatus); return <Pill tone={s.tone}>{s.label}</Pill> } },
    { key: 'copy', label: 'Their copy', render: (c) => { const w = copyWords(c); return <span className={styles.cell}><Pill tone={w.tone}>{w.label}</Pill>{w.hint && <span className={styles.hint}>{w.hint}</span>}</span> } },
  ]
  return <Card header="Shared with other businesses" headingLevel={3}
    description={data.product.isVariation ? `A variation is shared with its main product, ${data.product.rootSku}.` : 'The assortments of this business that hold this product, and what each other business does with it.'}
    headerAction={settings}>
    <div className={styles.stack}>
      {!canEdit && <p className={styles.note}>{EDIT_REASON}</p>}
      <DataGrid maxHeight={GRID_MAX} ariaLabel="Assortments of this business" columns={places} rows={assortments} rowKey={(p) => p.id} />
      <h4 className={styles.subhead}>Other businesses</h4>
      {businesses.length
        ? <DataGrid maxHeight={GRID_MAX} ariaLabel="Businesses this product is offered to" columns={copies} rows={businesses} rowKey={(c) => c.shareId} />
        : <p className={styles.text}>No other business is offered this product. Add it to an assortment that is offered to one.</p>}
    </div>
  </Card>
}

function Stock({ data }: { data: ProductSharing }) {
  const { source, lentTo } = data.stock
  const columns: Array<Column<LentUsage>> = [
    { key: 'business', label: 'Business', render: (u) => u.businessName },
    { key: 'held', label: 'Held for its orders now', numeric: true, render: (u) => u.heldNow.toLocaleString() },
    { key: 'sold', label: 'Sold, last 30 days', numeric: true, render: (u) => u.sold30d.toLocaleString() },
    { key: 'back', label: 'Put back, last 30 days', numeric: true, render: (u) => u.putBack30d.toLocaleString() },
  ]
  return <Card header="Stock" headingLevel={3} headerAction={<Button asChild variant="secondary"><Link href="/settings/sharing">Manage shared stock</Link></Button>}>
    <div className={styles.stack}>
      {source.kind === 'pool'
        ? <PoolSourceNote source={{ lenderName: source.lenderName, available: source.available, products: source.products }} />
        : <p className={styles.text}>{stockWords(source)}</p>}
      {lentTo.length > 0 && <>
        <h4 className={styles.subhead}>Sold from this business’s stock by</h4>
        <DataGrid maxHeight={GRID_MAX} ariaLabel="Businesses that sell from this business's stock of this product" columns={columns} rows={lentTo} rowKey={(u) => u.workspaceId} />
      </>}
    </div>
  </Card>
}
