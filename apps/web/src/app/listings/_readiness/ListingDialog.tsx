'use client'

/**
 * The Listing window (step 5 of docs/listings/LISTINGS-LIVE-LAYER-PLAN-2026-10-25.md; it replaced the readiness
 * rebuild's Fix window): one product or family on one destination, in the DS `DetailModal` — centred, never a drawer.
 *
 *   header  "GALE-JACKET · Amazon DE"; the readiness pill and the channel's selling state; "Checked 2 min ago · Synced
 *           with Amazon 1 h ago"; the row's other destinations as buttons (the market switcher); ▲ 3 of 50 ▼ over the
 *           grid's rows in view (J / K).
 *   tabs    Readiness (the Fix window's problems, Open field links and languages) · On <channel> · Price & stock ·
 *           History — the last three only when the read carries what the channel says (`ReadinessDetail.channel`:
 *           absent from an older API, null on Shared and for a person without `listings.view`); then the window is the
 *           Fix window it replaced.
 *   footer  Open on <channel> ↗ · Sync activity · Sales  …  Close · Publish… · Open in studio.
 *
 * It reads `GET /api/catalog-transfer/readiness/detail`; the only writes are the Price & stock tab's two price edits
 * and the suppression's two buttons (`ListingDialogTabs.tsx`). "Refresh from Amazon" is not offered: its route
 * (`POST /api/listings/:id/resync`) does reach Amazon through the channel gateway, but it sends the listing's ASIN where
 * Amazon's getListingsItem wants the seller SKU, and on Amazon's "not found" it marks the listing's sync failed. The
 * host owns what is shown (product, destination, tab): Prev / Next, the switcher and a tab click
 * ask it. Escape closes; the focus goes back to the chip or button that opened it (`returnFocusTo` names the row's chip
 * after Prev / Next moved on).
 */
import { Fragment, useCallback, useEffect, useId, useMemo, useState } from 'react'
import { CheckCircle2, ExternalLink } from 'lucide-react'
import type { ReadinessDestination, ReadinessDetail, ReadinessProblem } from '@nexus/shared/listing-readiness'
import Link from '@/lib/workspaces/Link'
import { Button, Pill, Tag } from '@/design-system/primitives'
import { AsOf, Banner, Disclosure, EmptyState } from '@/design-system/components'
import { DetailModal, type DetailNav } from '@/design-system/patterns'
import type { ModalProps } from '@/design-system/components/Modal'
import { SELLING_STATE_TONE, SELLING_STATE_WORD, SellingStatePill, SkuTag, readinessMeta } from '@/design-system/grid'
import { languageLabel } from '@/app/products/[id]/edit/_studio/scopes'
import { transferApi } from '@/app/products/catalog-transfer/transferApi'
import { ProductsPublishDialog } from '@/app/products/_publication/dialog/ProductsPublishDialog'
import {
  detailPath, emptyWords, inBusiness, initialFocus, listingTotal, listingWords, moreWords, problemKindLabel, productTitle, publishStartKey,
  requiredByWords, salesHref, shownTab, stateLine, syncActivityHref, syncedWords, tabCount, tabLabel, windowTabs, windowTitle, type ListingTab,
} from './listingDialogModel'
import { ChannelTab, HistoryTab, PriceTab } from './ListingDialogTabs'
import { channelLabel, destinationLines } from './marketChips'
import { absoluteTime } from './relativeTime'
import styles from './ListingDialog.module.css'

export interface ListingDialogProps {
  open: boolean
  onClose: () => void
  /** The family root, or the single product. */
  productId: string
  /** The whole family (1) or only this product (0). */
  family: boolean
  /** The destination on show. */
  destinationKey: string
  /** The row's destinations, in chip order: the switcher. */
  destinations: ReadinessDestination[]
  /** The switcher asked for another destination of the same row. */
  onDestination: (key: string) => void
  /** The tab asked for (the host keeps it across Prev / Next). */
  tab: ListingTab
  onTab: (tab: ListingTab) => void
  /** The page's filters (search, channel, market, …), passed on to the read. */
  query: Record<string, string>
  /** The row's name (or SKU) for the title. The read does not carry it. */
  productName?: string | null
  /** The listing the per-listing tabs open on (a `?listing=` link). */
  listingId?: string | null
  /** Prev / Next over the grid's rows in view. */
  nav?: DetailNav
  returnFocusTo?: ModalProps['returnFocusTo']
}

type Read = { path: string; detail?: ReadinessDetail; error?: string }

export function ListingDialog({
  open, onClose, productId, family, destinationKey, destinations, onDestination, tab, onTab, query, productName, listingId, nav, returnFocusTo,
}: ListingDialogProps) {
  const [read, setRead] = useState<Read | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [publishing, setPublishing] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { if (!open) setRead(null) }, [open])

  const path = open ? detailPath(query, { productId, family, destinationKey }) : null
  useEffect(() => {
    if (!path) return
    const controller = new AbortController()
    void transferApi<ReadinessDetail>(path, undefined, controller.signal)
      .then((detail) => { if (!controller.signal.aborted) { setRead({ path, detail }); setNow(Date.now()) } })
      .catch((error: unknown) => { if (!controller.signal.aborted) setRead({ path, error: error instanceof Error ? error.message : String(error) }) })
    return () => controller.abort()
  }, [path, attempt])
  // A write in a tab, or the Publish window closing: read the window again in place (the old answer stays meanwhile).
  const reread = useCallback(() => setAttempt((n) => n + 1), [])

  // Only the answer to THIS read is shown: a previous product's or market's never stands in for it. A re-read of the
  // same path keeps the answer on screen until the new one lands.
  const current = read && read.path === path ? read : null
  const detail = current?.detail ?? null
  const channel = detail?.channel ?? null
  // The page's own record of the destination: its words, and (live layer step 3) why Nexus does not check readiness there.
  const listed = destinations.find((d) => d.key === destinationKey) ?? null
  const destination = detail?.destination ?? listed
  const destinationLabel = destination?.label || listed?.label || 'Unknown destination'
  const title = windowTitle(productTitle(productName, detail, family), destinationLabel)
  const tabs = windowTabs(detail)
  const active = shownTab(tab, tabs)

  // The listing the per-listing tabs show: the link's, else the first with a problem, else the first; kept while the
  // same listings are on show.
  const listingIds = channel ? channel.listings.map((l) => l.live.listingId).join('\n') : ''
  const [focus, setFocus] = useState<string | null>(null)
  useEffect(() => {
    if (!channel) { setFocus(null); return }
    setFocus((f) => (f && channel.listings.some((l) => l.live.listingId === f) ? f : initialFocus(channel.listings, listingId)))
    // The listings, not the object: a re-read with the same listings keeps the choice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listingIds, listingId])
  const focused = channel?.listings.find((l) => l.live.listingId === focus) ?? null

  const tabItems = useMemo(() => (detail && destination ? tabs.map((id) => ({ id, label: tabLabel(id, destination.channel), count: tabCount(id, detail) })) : undefined),
    [tabs, detail, destination])

  // The footer's ways out. Open on the channel: the destination's own page (the parent's), else the listing's.
  const openUrl = channel ? channel.summary.url ?? focused?.live.url ?? null : null
  const syncHref = focused ? syncActivityHref(focused.live.listingId) : null
  const sales = channel && destination ? salesHref(destination) : null
  const startKey = destination ? publishStartKey(destination) : null
  const word = destination ? channelLabel(destination.channel) : ''

  const footer = (
    <>
      {openUrl && (
        <Button asChild size="sm">
          <a href={openUrl} target="_blank" rel="noopener noreferrer">Open on {word} <ExternalLink size={13} aria-hidden /></a>
        </Button>
      )}
      {syncHref && (
        <Button asChild size="sm">
          <Link href={inBusiness(syncHref)} title={focused ? `Nexus’s calls to ${word} for ${focused.sku}, last 30 days` : undefined}>Sync activity</Link>
        </Button>
      )}
      {sales && (
        <Button asChild size="sm">
          <Link href={inBusiness(sales)} title={`Sales per product on ${destinationLabel} (every product there)`}>Sales</Link>
        </Button>
      )}
      <span className="grow" />
      <Button onClick={onClose}>Close</Button>
      {detail && startKey && <Button onClick={() => setPublishing(true)}>Publish…</Button>}
      {detail && <Button asChild variant="primary"><Link href={inBusiness(detail.editorHref)}>Open in studio</Link></Button>}
    </>
  )

  const switcher = destinations.length > 1 ? (
    // The grid's own lines: a store's markets under its short name; Shared and the market-less stores first.
    <div className={styles.switcher} role="group" aria-label="Markets">
      {destinationLines(destinations).map((line) => {
        const buttons = line.items.map(({ destination: d, text }) => {
          const here = d.key === destinationKey
          return (
            <Button key={d.key} size="xs" active={here} aria-current={here ? 'true' : undefined} aria-label={d.label} onClick={() => onDestination(d.key)}>
              {text}
            </Button>
          )
        })
        return line.label === null ? (
          <div key={line.key} className={styles.switchLine}>{buttons}</div>
        ) : (
          <Fragment key={line.key}>
            <span className={styles.switchStore} aria-hidden>{line.label}</span>
            <div className={styles.switchMarkets}>{buttons}</div>
          </Fragment>
        )
      })}
    </div>
  ) : undefined

  return (
    <>
      <DetailModal
        open={open}
        onClose={onClose}
        title={title}
        subtitle={detail ? <Summary detail={detail} now={now} /> : undefined}
        meta={switcher}
        tabs={tabItems}
        activeTab={active}
        onTabChange={(id) => onTab(id as ListingTab)}
        tabsLabel="Listing sections"
        nav={nav}
        loading={!current}
        error={current?.error}
        onRetry={() => { setRead(null); setAttempt((n) => n + 1) }}
        footer={footer}
        returnFocusTo={returnFocusTo}
      >
        {detail && destination ? (
          active === 'channel' && channel ? (
            <ChannelTab channel={channel} destination={destination} family={detail.family} onChanged={reread} now={now} />
          ) : active === 'price' && channel ? (
            <PriceTab channel={channel} destination={destination} focus={focus} onFocus={setFocus} onChanged={reread} />
          ) : active === 'history' && channel ? (
            <HistoryTab channel={channel} destination={destination} focus={focus} onFocus={setFocus} now={now} />
          ) : (
            <ReadinessBody detail={detail} destinationLabel={destinationLabel} note={listed?.note ?? null} />
          )
        ) : null}
      </DetailModal>
      {publishing && (
        <ProductsPublishDialog
          productIds={[productId]}
          familyCount={1}
          initialKeys={startKey ? [startKey] : undefined}
          onClose={() => { setPublishing(false); reread() }}
        />
      )}
    </>
  )
}

/** Readiness, the channel's selling state, and when each was last known. */
function Summary({ detail, now }: { detail: ReadinessDetail; now: number }) {
  const meta = readinessMeta(detail.state, 'scope')
  const parts = listingTotal(detail.counts) > 1 ? stateLine(detail.counts) : null
  const live = detail.channel?.summary ?? null
  return (
    <span className={styles.summary}>
      <Pill tone={meta.tone}>{meta.label}</Pill>
      {live && (
        <span title={`On ${channelLabel(detail.destination.channel)}`}>
          <SellingStatePill pill={{ label: SELLING_STATE_WORD[live.state] ?? live.state, tone: SELLING_STATE_TONE[live.state] ?? 'neutral', glyph: 'dot' }} />
        </span>
      )}
      {parts && <span>{parts}</span>}
      <span>
        {detail.pending
          ? 'Checking… the list is from the last check'
          : detail.computedAt ? <>Checked <AsOf at={detail.computedAt} /></> : 'Not computed yet'}
        {live && <> · <span title={absoluteTime(live.lastSyncedAt)}>{syncedWords(live.lastSyncedAt, detail.destination.channel, now)}</span></>}
      </span>
    </span>
  )
}

/** The Readiness tab: the Fix window's content. */
function ReadinessBody({ detail, destinationLabel, note }: { detail: ReadinessDetail; destinationLabel: string; note: string | null }) {
  const headingId = useId()
  const notSetUp = readinessMeta('absent', 'scope').label
  const empty = !note && detail.problems.length === 0 && detail.notes.length === 0 ? emptyWords(detail.state, destinationLabel) : null
  return (
    <div className={styles.body}>
      {/* A listing on a destination Nexus does not check (no account, a market outside the footprint, …): why. */}
      {note && <Banner tone="info">{note}</Banner>}
      {detail.languages.length > 1 && (
        <div className={styles.languages} role="group" aria-label="Languages">
          {detail.languages.map((language) => {
            const meta = readinessMeta(language.state, 'scope')
            return (
              <span key={language.locale} className={styles.language}>
                {languageLabel(language.locale)} <Pill tone={meta.tone}>{meta.label}</Pill>
              </span>
            )
          })}
        </div>
      )}

      {detail.problems.length > 0 && (
        <section aria-labelledby={headingId}>
          <h2 id={headingId} className={styles.heading}>
            {detail.problems.length.toLocaleString('en')} {detail.problems.length === 1 ? 'problem' : 'problems'}
          </h2>
          <ul className={styles.problems}>
            {detail.problems.map((problem, i) => <ProblemItem key={`${problem.field ?? ''}:${i}`} problem={problem} />)}
          </ul>
        </section>
      )}

      {detail.notes.length > 0 && (
        <Banner tone="neutral" title={notSetUp}>
          {detail.notes.length === 1
            ? detail.notes[0]
            : <ul className={styles.notes}>{detail.notes.map((note) => <li key={note}>{note}</li>)}</ul>}
        </Banner>
      )}

      {empty && (
        <EmptyState
          icon={detail.state === 'ready' ? <CheckCircle2 size={22} aria-hidden /> : undefined}
          title={empty.title}
          description={empty.description ?? undefined}
        />
      )}
    </div>
  )
}

function ProblemItem({ problem }: { problem: ReadinessProblem }) {
  const requiredBy = requiredByWords(problem.requiredBy)
  const languages = problem.languages.map(languageLabel).join(', ')
  const more = moreWords(problem.products.length, problem.productCount)
  const only = problem.productCount === 1 && problem.products.length === 1 ? problem.products[0] : null
  return (
    <li className={styles.problem}>
      <div className={styles.problemHead}>
        <span className={styles.problemLabel}>{problem.label}</span>
        <Tag>{problemKindLabel(problem.kind)}</Tag>
        {problem.href && (
          <span className={styles.actionsEnd}>
            <Button asChild size="sm" aria-label={`Open field: ${problem.label}`}>
              <Link href={inBusiness(problem.href)}>Open field</Link>
            </Button>
          </span>
        )}
      </div>
      {problem.message && <p className={styles.message}>{problem.message}</p>}
      {(requiredBy || languages) && (
        <div className={styles.meta}>
          {requiredBy && <span>{requiredBy}</span>}
          {languages && <span>{languages}</span>}
        </div>
      )}
      {only ? (
        <div className={styles.meta}><span>{listingWords(1)} · <SkuTag>{only.sku}</SkuTag></span></div>
      ) : problem.productCount > 0 && (
        <Disclosure summary={listingWords(problem.productCount)}>
          <ul className={styles.skus}>
            {problem.products.map((product) => (
              <li key={product.id}>
                <SkuTag>{product.sku}</SkuTag>
                {product.name && <span className={styles.skuName}> {product.name}</span>}
              </li>
            ))}
            {more && <li className={styles.skuName}>{more}</li>}
          </ul>
        </Disclosure>
      )}
    </li>
  )
}
