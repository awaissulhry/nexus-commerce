'use client'

/**
 * Read live (Owner, 2026-09-26: "the ability to read whatever is currently live on the channel").
 *
 * Reads ONE destination (channel × market × account × listing alias) from the channel now — read only, nothing is stored and
 * nothing is sent — and shows it beside what this sheet holds. The route and the shape are the publish review's own
 * (`GET /api/products/:id/live-read`, `@nexus/shared/live-read`), so the sheet and the review can never disagree.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { LiveRead } from '@nexus/shared/live-read'
import { Banner, DataGrid, Drawer, type Column } from '@/design-system/components'
import { Button, Pill, Spinner } from '@/design-system/primitives'
import { getBackendUrl } from '@/lib/backend-url'
import { contentRows, variationRows, type AxisLink, type LiveContentRow, type LiveVariantRow, type NexusVariant } from './liveReadModel'
import styles from './live-read.module.css'

export interface LiveReadTarget { productId: string; channel: string; channelLabel: string; marketplace: string; accountId: string; aliasKey: string }

type Load = { status: 'loading' } | { status: 'ready'; read: LiveRead } | { status: 'error'; message: string }

const VARIANT_STATE = { live: { tone: 'success', label: 'Live' }, missing: { tone: 'warning', label: 'Not on the channel' }, extra: { tone: 'warning', label: 'Only on the channel' } } as const
const CONTENT_STATE = {
  same: { tone: 'success', label: 'Same' }, differs: { tone: 'warning', label: 'Differs' }, 'not-compared': { tone: 'neutral', label: 'Not compared' },
  absent: { tone: 'neutral', label: 'Not on the channel' }, unread: { tone: 'danger', label: 'Could not read' },
} as const

export function liveReadUrl(target: LiveReadTarget): string {
  const params = new URLSearchParams({ channel: target.channel, marketplace: target.marketplace, accountId: target.accountId })
  if (target.aliasKey) params.set('aliasKey', target.aliasKey)
  return `${getBackendUrl()}/api/products/${encodeURIComponent(target.productId)}/live-read?${params}`
}

export function LiveReadDrawer({ open, onClose, target, links, nexusVariants, nexusContent }: {
  open: boolean
  onClose: () => void
  target: LiveReadTarget
  links: AxisLink[]
  nexusVariants: NexusVariant[]
  nexusContent: Record<string, unknown>
}) {
  const [load, setLoad] = useState<Load>({ status: 'loading' })
  const read = useCallback(async () => {
    setLoad({ status: 'loading' })
    try {
      const response = await fetch(liveReadUrl(target), { credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(60_000) })
      const body = await response.json().catch(() => null)
      if (!response.ok) throw new Error(typeof body?.error === 'string' ? body.error : `The channel could not be read (HTTP ${response.status}).`)
      setLoad({ status: 'ready', read: body as LiveRead })
    } catch (error) {
      setLoad({ status: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }, [target])
  useEffect(() => { if (open) void read() }, [open, read])

  const ready = load.status === 'ready' ? load.read : null
  const variants = useMemo(() => ready ? variationRows(ready, links, nexusVariants) : [], [ready, links, nexusVariants])
  const content = useMemo(() => ready ? contentRows(ready, nexusContent) : [], [ready, nexusContent])
  const axes = ready?.variations?.axes ?? []

  const variantColumns: Array<Column<LiveVariantRow>> = [
    { key: 'sku', label: 'SKU', render: row => row.sku },
    { key: 'state', label: 'On the channel', render: row => <Pill tone={VARIANT_STATE[row.state].tone}>{VARIANT_STATE[row.state].label}</Pill> },
    ...axes.map((axis, i): Column<LiveVariantRow> => ({ key: `axis:${axis}`, label: axis, render: row => {
      const cell = row.cells[i]
      return <span className={styles.cell}>
        <span>{cell.live ?? '—'}</span>
        {cell.differs && <span className={styles.was}>Nexus: {cell.nexus}</span>}
        {cell.live == null && cell.nexus != null && <span className={styles.was}>Nexus: {cell.nexus}</span>}
      </span>
    } })),
    { key: 'price', label: 'Price', render: row => row.price, numeric: true },
    { key: 'stock', label: 'Available', render: row => row.stock, numeric: true },
  ]
  const contentColumns: Array<Column<LiveContentRow>> = [
    { key: 'field', label: 'Field', render: row => row.label },
    { key: 'live', label: 'Live', render: row => row.live },
    { key: 'nexus', label: 'Nexus', render: row => row.nexus ?? '—' },
    { key: 'state', label: 'Compared', render: row => <Pill tone={CONTENT_STATE[row.state].tone}>{CONTENT_STATE[row.state].label}</Pill> },
  ]
  const differing = variants.filter(v => v.differs).length + content.filter(c => c.state === 'differs').length

  return (
    <Drawer open={open} onClose={onClose} side="right" width={760} resizable
      title={`Live on ${target.channelLabel}`}
      subtitle={ready ? `Read ${new Date(ready.readAt).toLocaleString()} · read only, nothing was changed` : 'Read only, nothing is changed'}
      footer={<Button variant="secondary" size="sm" onClick={() => void read()} disabled={load.status === 'loading'}>Read again</Button>}>
      <div className={styles.body}>
        {load.status === 'loading' && <div className={styles.loading}><Spinner /> Reading the listing from the channel…</div>}
        {load.status === 'error' && <Banner tone="danger" title="The channel could not be read">{load.message} Nothing was changed.</Banner>}
        {ready && <>
          {ready.errors.length > 0 && <Banner tone="warning" title={`${ready.errors.length} ${ready.errors.length === 1 ? 'part' : 'parts'} could not be read`}>
            <ul className={styles.errors}>{ready.errors.map((e, i) => <li key={i}>{e.sku ?? e.field ?? 'Listing'}: {e.reason}</li>)}</ul>
          </Banner>}
          <p className={styles.meta}>{differing ? `${differing} ${differing === 1 ? 'difference' : 'differences'} from Nexus.` : 'No differences from Nexus in what could be compared.'}</p>
          {ready.variations && <section className={styles.section} aria-labelledby="live-read-variations">
            <h3 id="live-read-variations" className={styles.heading}>Variations</h3>
            <DataGrid ariaLabel="Live variations" columns={variantColumns} rows={variants} rowKey={row => row.sku} />
          </section>}
          <section className={styles.section} aria-labelledby="live-read-content">
            <h3 id="live-read-content" className={styles.heading}>Content</h3>
            <DataGrid ariaLabel="Live content" columns={contentColumns} rows={content} rowKey={row => row.field} />
          </section>
        </>}
      </div>
    </Drawer>
  )
}
