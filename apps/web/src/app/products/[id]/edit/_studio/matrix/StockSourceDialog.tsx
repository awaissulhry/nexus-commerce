'use client'

/**
 * Shared stock by SKU (Owner 2026-10-01; plan docs/shared-stock-by-sku/PLAN-2026-10-01.md §3.3) — the Matrix's
 * "Stock source…": where the ticked SKUs take their stock from. This business's own warehouses, or the stock another
 * business profile lends to this one (any profile, now or later: the list is the lent stock this business accepted).
 * A SKU can use another business's stock only when that business has a product with exactly the same SKU.
 *
 * The pattern the Owner liked (2026-09-26): a default for every choice, one summary, one table, a counted main button,
 * Done with Undo (the toast, MatrixSurface). The numbers are the API's preview (the derivation core on the ledger each
 * SKU would follow), never computed here. A SKU that cannot switch is named with its reason and left out; the others
 * still switch. Calls: the stock-pool routes the Settings page uses (`sharingApi`).
 */
import { useCallback, useEffect, useMemo, useState } from 'react'

import { Banner, Modal } from '@/design-system/components'
import { DataGrid, type Column } from '@/design-system/grid/datagrid'
import { Button, Pill, RadioCard } from '@/design-system/primitives'
import Link from '@/lib/workspaces/Link'
import { sharingApi } from '@/app/settings/sharing/sharingApi'
import type { Grant, ListingPreview, SwitchPreview } from '@/app/settings/sharing/stockPoolApi'
import { listingName, previewRuleWords, warehousesWords } from '@/app/settings/sharing/stockWords'

import type { MatrixRowRead } from './contract'
import styles from './StockSourceDialog.module.css'

export type StockSource = NonNullable<MatrixRowRead['stock']['source']>

export interface StockSourceTarget {
  id: string
  sku: string
  /** Where its listings take their number now (the Matrix read); null = own stock. */
  source: StockSource | null
}

export interface StockSourceSwitched {
  to: 'pool' | 'own'
  grantId: string | null
  lenderName: string | null
  /** The SKUs that switched, each with the stock it used before (for Undo). */
  switched: Array<{ id: string; sku: string; previous: StockSource | null }>
}

const OWN = 'own'
const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`

/** Pure: which SKUs switch, which already use the chosen stock, which cannot (and why). Exported for tests. */
export function stockSourcePlan(targets: readonly StockSourceTarget[], choice: string, preview: readonly SwitchPreview[] | null) {
  const byId = new Map((preview ?? []).map((p) => [p.productId, p]))
  const will: StockSourceTarget[] = []
  const already: StockSourceTarget[] = []
  const refused: Array<StockSourceTarget & { reason: string }> = []
  for (const t of targets) {
    const isThere = choice === OWN ? t.source === null : t.source?.grantId === choice
    if (isThere) { already.push(t); continue }
    const p = byId.get(t.id)
    if (p?.refusal) { refused.push({ ...t, reason: p.refusal }); continue }
    will.push(t)
  }
  return { will, already, refused }
}

/**
 * Pure: the default choice — back to own stock when every SKU already borrows; otherwise the lent stock this family
 * already uses (`suggested`, when it is still on), else the first lent stock.
 */
/** How many of the chosen SKUs take their stock from each source now (OWN, or a grant id). */
export function stockInUse(targets: readonly StockSourceTarget[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const t of targets) { const key = t.source?.grantId ?? OWN; counts.set(key, (counts.get(key) ?? 0) + 1) }
  return counts
}

/**
 * The pop-up opens on where the chosen SKUs take their stock NOW (Owner 2026-10-01: it opened on "Own stock" for SKUs
 * on Xavia's stock, and read as if the connect had not held). Mixed: the source most of them use; a tie goes to the
 * lent stock this family uses, then to a lent stock. A source that is no longer on is not offered.
 */
export function defaultStockChoice(targets: readonly StockSourceTarget[], grants: readonly Pick<Grant, 'id'>[], suggested?: string | null): string {
  const offered = (key: string) => key === OWN || grants.some((g) => g.id === key)
  const rank = (key: string) => (key === suggested ? 0 : key === OWN ? 2 : 1)
  const inUse = [...stockInUse(targets)].filter(([key]) => offered(key)).sort(([a, n], [b, m]) => m - n || rank(a) - rank(b))
  if (inUse.length > 0) return inUse[0]![0]
  if (suggested && offered(suggested)) return suggested
  return grants[0]?.id ?? OWN
}

/** The tag on a source's card: which source the chosen SKUs use now, and how many when they differ. */
export function inUseWords(inUse: number, total: number): string | null {
  if (inUse === 0) return null
  return inUse === total ? 'In use now' : `In use now · ${inUse} of ${total}`
}

interface PreviewRow { key: string; sku: string; listing: string; showsNow: number | null; after: string }

export function StockSourceDialog({ open, targets, suggestedGrantId, canSwitch, onClose, onSwitched }: {
  open: boolean
  targets: readonly StockSourceTarget[]
  /** The lent stock most of this family's SKUs use now: it breaks a tie between the sources the chosen SKUs use. */
  suggestedGrantId?: string | null
  /** The person may change where stock comes from (inventory.adjust; the API also asks for an owner). */
  canSwitch: boolean
  onClose: () => void
  onSwitched: (result: StockSourceSwitched) => Promise<void> | void
}) {
  const [grants, setGrants] = useState<Grant[] | null>(null)
  const [choice, setChoice] = useState<string | null>(null)
  const [preview, setPreview] = useState<SwitchPreview[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // The stock this business may use: lent to it, accepted, on. (A paused one cannot take new products.)
  useEffect(() => {
    if (!open) return
    let live = true
    setGrants(null); setChoice(null); setPreview(null); setError(null); setBusy(false)
    sharingApi<{ borrowing: Grant[] }>('stock-pool/grants')
      .then((r) => {
        if (!live) return
        const usable = r.borrowing.filter((g) => g.status === 'active')
        setGrants(usable)
        setChoice(defaultStockChoice(targets, usable, suggestedGrantId))
      })
      .catch((err) => { if (live) setError(err instanceof Error ? err.message : 'The lent stock could not be read.') })
    return () => { live = false }
  }, [open, targets, suggestedGrantId])

  const to: 'pool' | 'own' = choice === OWN ? 'own' : 'pool'
  const grant = grants?.find((g) => g.id === choice) ?? null
  const lender = grant?.ownerWorkspaceName ?? null

  const loadPreview = useCallback(async (signal: { live: boolean }) => {
    if (!choice || targets.length === 0) return
    setPreview(null); setError(null)
    try {
      const r = await sharingApi<{ products: SwitchPreview[] }>('stock-pool/products/preview', {
        productIds: targets.map((t) => t.id), to, grantId: to === 'pool' ? choice : null, withVariations: false,
      })
      if (signal.live) setPreview(r.products)
    } catch (err) {
      if (signal.live) setError(err instanceof Error ? err.message : 'The preview could not be worked out.')
    }
  }, [choice, targets, to])
  useEffect(() => {
    if (!open || !choice) return
    const signal = { live: true }
    void loadPreview(signal)
    return () => { signal.live = false }
  }, [open, choice, loadPreview])

  const plan = useMemo(() => stockSourcePlan(targets, choice ?? OWN, preview), [targets, choice, preview])
  const inUse = useMemo(() => stockInUse(targets), [targets])
  // Listings whose fixed number ends when they join the lent stock (a shared SKU has no fixed number; the API does it).
  const endsFixed = useMemo(() => {
    if (!preview || to !== 'pool') return 0
    const willIds = new Set(plan.will.map((t) => t.id))
    return preview.filter((p) => willIds.has(p.productId)).reduce((n, p) => n + p.listings.filter((l) => l.wasFixed).length, 0)
  }, [preview, plan.will, to])
  const rows = useMemo<PreviewRow[]>(() => {
    if (!preview) return []
    const willIds = new Set(plan.will.map((t) => t.id))
    // One SKU after another; inside a SKU, channel by channel, each market's main listing before its copies.
    const ordered = (ls: readonly ListingPreview[]) => [...ls].sort((a, b) =>
      a.channel.localeCompare(b.channel) || a.marketplace.localeCompare(b.marketplace) || (a.listingMark ?? 0) - (b.listingMark ?? 0))
    return preview.filter((p) => willIds.has(p.productId)).flatMap((p) => ordered(p.listings).map((l) => ({
      key: `${p.productId}:${l.listingId ?? l.itemId}:${l.channel}:${l.marketplace}`,
      sku: p.sku, listing: listingName(l), showsNow: l.showsNow, after: previewRuleWords(l),
    })))
  }, [preview, plan.will])

  async function run() {
    if (busy || !choice || plan.will.length === 0) return
    setBusy(true); setError(null)
    try {
      await sharingApi('stock-pool/products/switch', {
        productIds: plan.will.map((t) => t.id), to, grantId: to === 'pool' ? choice : null, withVariations: false,
      })
      await onSwitched({
        to, grantId: to === 'pool' ? choice : null, lenderName: lender,
        switched: plan.will.map((t) => ({ id: t.id, sku: t.sku, previous: t.source })),
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The stock source could not be changed.')
      setBusy(false)
    }
  }

  // One SKU: its name is in the summary, and the table keeps its width for the numbers (a phone sees them).
  const oneSku = plan.will.length === 1
  const columns: Array<Column<PreviewRow>> = [
    ...(oneSku ? [] : [{ key: 'sku', label: 'SKU', width: 220, render: (r: PreviewRow) => r.sku }]),
    { key: 'listing', label: 'Listing', width: 320, render: (r) => r.listing },
    { key: 'now', label: 'Shows now', width: 120, numeric: true, render: (r) => (r.showsNow === null ? '—' : r.showsNow.toLocaleString()) },
    { key: 'after', label: 'After', width: 160, render: (r) => r.after },
  ]
  const action = to === 'pool' ? 'Connect' : 'Disconnect'
  const chosenStock = to === 'pool' ? `${lender}’s stock` : 'this business’s own stock'
  const nothingToChange = !!preview && plan.will.length === 0 && plan.refused.length === 0 && plan.already.length > 0
  const summary = !preview ? null : nothingToChange
    ? `${plan.already.length === 1 ? `${plan.already[0]!.sku} already uses` : `All ${plan.already.length} SKUs already use`} ${chosenStock}. To change it, choose another stock above.`
    : [
    plan.will.length > 0 && (to === 'pool'
      ? `${oneSku ? plan.will[0]!.sku : count(plan.will.length, 'SKU')} will use ${lender}’s stock.`
      : `${oneSku ? plan.will[0]!.sku : count(plan.will.length, 'SKU')} will use this business’s own stock again.`),
    plan.already.length > 0 && `${count(plan.already.length, 'SKU')} ${plan.already.length === 1 ? 'already does' : 'already do'}.`,
    plan.refused.length > 0 && `${count(plan.refused.length, 'SKU')} cannot.`,
    endsFixed > 0 && `${count(endsFixed, 'listing')} with a fixed number will follow the shared stock instead: a shared SKU's quantity is changed only in the business that lends it.`,
  ].filter(Boolean).join(' ')

  return (
    <Modal open={open} onClose={() => { if (!busy) onClose() }} size="xl" title="Stock source"
      subtitle={`${count(targets.length, 'SKU')} chosen. A SKU can use another business’s stock only when that business has a product with exactly the same SKU.`}
      footer={<>
        <Button disabled={busy} onClick={onClose}>Cancel</Button>
        {canSwitch && (
          <Button variant="primary" disabled={busy || !preview || plan.will.length === 0} onClick={() => { void run() }}>
            {busy ? `${action === 'Connect' ? 'Connecting' : 'Disconnecting'}…` : nothingToChange ? 'Nothing to change' : `${action} ${count(plan.will.length, 'SKU')}`}
          </Button>
        )}
      </>}>
      <div className={styles.body}>
        {!canSwitch && <Banner tone="info">Only an owner of this business can change where stock comes from.</Banner>}
        {error && <Banner tone="danger" action={<Button onClick={() => { void loadPreview({ live: true }) }}>Retry</Button>}>{error}</Banner>}

        <fieldset className={styles.choices} disabled={busy || grants === null}>
          <legend className={styles.legend}>Stock from</legend>
          <RadioCard name="stock-source" value={OWN} checked={choice === OWN} selected={choice === OWN} onChange={() => setChoice(OWN)}
            title={<SourceTitle name="Own stock" inUse={inUseWords(inUse.get(OWN) ?? 0, targets.length)} />} description="This business’s own warehouses." />
          {(grants ?? []).map((g) => (
            <RadioCard key={g.id} name="stock-source" value={g.id} checked={choice === g.id} selected={choice === g.id} onChange={() => setChoice(g.id)}
              title={<SourceTitle name={`${g.ownerWorkspaceName}’s stock`} inUse={inUseWords(inUse.get(g.id) ?? 0, targets.length)} />} description={warehousesWords(g)} />
          ))}
        </fieldset>
        {grants === null && !error && <p role="status" className={styles.note}>Reading the stock lent to this business…</p>}
        {grants !== null && grants.length === 0 && (
          <Banner tone="info" title="No business lends stock to this one yet">
            An owner of your other business lends it in <Link href="/settings/sharing">Settings › Shared products</Link> › Stock you lend, and an owner here accepts it.
          </Banner>
        )}

        {choice && !preview && !error && <p role="status" className={styles.note}>Working out the number each listing will show…</p>}
        {summary && <Banner tone={plan.will.length > 0 ? 'info' : 'neutral'}>{summary}</Banner>}
        {plan.refused.length > 0 && (
          <Banner tone="warning" title={`${count(plan.refused.length, 'SKU')} cannot switch`}>
            <ul className={styles.reasons}>{plan.refused.map((t) => <li key={t.id}><strong>{t.sku}</strong> — {t.reason}</li>)}</ul>
          </Banner>
        )}
        {preview && plan.will.length > 0 && (rows.length === 0
          ? <p className={styles.note}>No live listing: nothing changes on any channel.</p>
          : <DataGrid maxHeight={360} ariaLabel="What each listing shows now and after" columns={columns} rows={rows} rowKey={(r) => r.key} />)}
      </div>
    </Modal>
  )
}

/** A source card's title, with the "In use now" tag (words, not colour alone) on the source the SKUs use now. */
function SourceTitle({ name, inUse }: { name: string; inUse: string | null }) {
  return <span className={styles.sourceTitle}>{name}{inUse && <Pill tone="info">{inUse}</Pill>}</span>
}
