'use client'

/**
 * Sharing studio step 3 — "Listings in this business": where the other business lists this product (channel, market,
 * the main listing and each alias by name; never its accounts or item ids), and the same listings made here as
 * drafts, on accounts of THIS business. A draft sends nothing until this business publishes it.
 */
import { useEffect, useMemo, useState } from 'react'

import { Banner, Card, Listbox, ProgressBar } from '@/design-system/components'
import { DataGrid, type Column } from '@/design-system/grid/datagrid'
import { Button } from '@/design-system/primitives'
import {
  accountOptions, hereWords, madeWords, makeWords, slotsWords, sourcePlaceWords, toMake, type LayoutGroup, type ListingLayout,
} from '@/app/settings/sharing/layoutWords'

import { applyLayout, readLayout } from './sharingApi'
import styles from './sharing.module.css'

const GRID_MAX = 480

export function LayoutCard({ productId, canEdit }: { productId: string; canEdit: boolean }) {
  const [view, setView] = useState<{ data?: ListingLayout; error?: string }>({})
  const [reload, setReload] = useState(0)
  const [choice, setChoice] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<{ tone: 'success' | 'danger'; text: string; refused: string[] } | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    void readLayout(productId, controller.signal).then((result) => {
      if (controller.signal.aborted) return
      setView(result.ok ? { data: result.data } : { error: result.message })
      if (result.ok) setChoice(Object.fromEntries(result.data.groups.map((g) => [g.key, g.here.suggestedAccountId ?? ''])))
    })
    return () => controller.abort()
  }, [productId, reload])

  const layout = view.data
  const place = (key: string) => {
    const g = layout?.groups.find((group) => group.key === key)
    return g ? sourcePlaceWords(g, layout!.sourceBusiness) : key
  }
  const total = useMemo(() => {
    const sum = { main: 0, aliases: 0 }
    for (const g of layout?.groups ?? []) {
      const accountId = choice[g.key]
      if (!accountId || g.here.blocked) continue
      const make = toMake(g.slots, g.here.present[accountId])
      sum.main += make.main ? 1 : 0
      sum.aliases += make.aliases.length
    }
    return sum
  }, [layout, choice])

  async function make() {
    if (!layout || busy) return
    setBusy(true)
    setOutcome(null)
    const result = await applyLayout(productId, layout.groups.filter((g) => !g.here.blocked).map((g) => ({ key: g.key, accountId: choice[g.key] || null })))
    setBusy(false)
    if (!result.ok) { setOutcome({ tone: 'danger', text: result.message, refused: [] }); return }
    const words = madeWords(result.data.results, place)
    setOutcome({ tone: words.refused.length ? 'danger' : 'success', ...words })
    setReload((n) => n + 1)
  }

  const columns: Array<Column<LayoutGroup>> = layout ? [
    { key: 'place', label: `In ${layout.sourceBusiness}`, render: (g) => sourcePlaceWords(g, layout.sourceBusiness) },
    { key: 'slots', label: 'Listings', render: (g) => slotsWords(g.slots) },
    { key: 'account', label: 'Make it on', render: (g) => g.here.blocked
      ? <span className={styles.note}>{g.here.blocked}</span>
      : canEdit
        ? <Listbox size="sm" ariaLabel={`Account for ${sourcePlaceWords(g, layout.sourceBusiness)}`} value={choice[g.key] ?? ''} disabled={busy}
            options={accountOptions(layout.accounts[g.channel] ?? [], g.marketplace)} onChange={(value) => setChoice((prev) => ({ ...prev, [g.key]: value }))} width="100%" />
        : (layout.accounts[g.channel] ?? []).find((a) => a.id === choice[g.key])?.label ?? '—' },
    { key: 'here', label: 'Here now', render: (g) => g.here.blocked || !choice[g.key] ? '—' : hereWords(g.slots, g.here.present[choice[g.key]]) },
  ] : []
  const button = makeWords(total)

  return <Card header="Listings in this business" headingLevel={3}
    description={layout ? `Where ${layout.sourceBusiness} lists this product. Make the same listings here as drafts, on this business’s own accounts. A draft sends nothing until you publish it.` : undefined}>
    <div className={styles.stack}>
      {!layout && !view.error && <ProgressBar indeterminate ariaLabel="Reading where the other business lists this product" />}
      {view.error && <Banner tone="danger" title="The listing layout could not be read" action={<Button onClick={() => setReload((n) => n + 1)}>Try again</Button>}>{view.error}</Banner>}
      {outcome && <div role="status"><Banner tone={outcome.tone}>
        <p className={styles.line}>{outcome.text}</p>
        {outcome.refused.map((line) => <p key={line} className={styles.line}>{line}</p>)}
      </Banner></div>}
      {layout && (layout.groups.length === 0
        ? <p className={styles.text}>{layout.sourceBusiness} does not list this product on any channel yet.</p>
        : <>
          <DataGrid maxHeight={GRID_MAX} ariaLabel="Where the other business lists this product" columns={columns} rows={layout.groups} rowKey={(g) => g.key} />
          {!canEdit
            ? <p className={styles.note}>You can see this. Making listings needs the “Edit products” permission.</p>
            : button
              ? <div><Button variant="primary" disabled={busy} onClick={() => { void make() }}>{busy ? 'Making drafts…' : button}</Button></div>
              : <p className={styles.note}>Nothing to make: what you chose is already here, or no account is chosen.</p>}
        </>)}
    </div>
  </Card>
}
