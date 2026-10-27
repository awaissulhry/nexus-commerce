'use client'

/**
 * Reviews › Insights › Products — one product's pop-up (build spec §3.4, the product-detail board): a centred DS
 * `DetailModal` (1160 px; a full-screen sheet on a phone) over the Products page. K / J (or ▲ / ▼) move to the previous /
 * next product on the page, held at either end with the reason; Esc or Close returns to the list with its place kept.
 * The address carries the product (`?product=<id>`), so a link opens it again.
 *
 * Tabs Summary · Reviews · Themes · Returns · Sizes; the body keeps its height so the tabs do not jump. Rating per channel
 * and market says where each comes from (ruling 5: Amazon stars only from imported reviews, else "No rating data from
 * Amazon — import reviews"; eBay as % positive). Size fit (Summary) and Sizes: the family's fit per size and per size
 * and colour, from reviews that say how it fits and returns marked "too small" / "too large" (`fit`, a size needs 5
 * mentions before it gets a verdict; fewer is "Too few", never a verdict). "Open in product studio" opens the
 * studio; "Suggest a fix" asks the AI for fixes (`POST /api/reviews/action-items/suggest`, nothing reaches a channel)
 * and opens Fixes for this product.
 */
import { useCallback, useState } from 'react'
import { ExternalLink, Sparkles } from 'lucide-react'
import { AsOf, Banner, Card, KeyValue, ProgressBar, RatingBars, StarRating, SummaryTable, useToast } from '@/design-system/components'
import { DetailModal } from '@/design-system/patterns'
import { Button, Pill, Tag } from '@/design-system/primitives'
import { emitInvalidation } from '@/lib/sync/invalidation-channel'
import Link from '@/lib/workspaces/Link'
import { useRouter } from '@/lib/workspaces/navigation'
import { reviewsSend } from '../../_lib/reviewsFetch'
import { inboxHref, insightsHref } from '../../_lib/reviewsLinks'
import { periodWords, scopeApiParams, type InsightsScope } from '../_shared/insightsScope'
import { fitHeaderWords, fitShare, fitVerdictPill, type FitCell, type ProductFit } from '../_shared/fitView'
import { useInsightsRead } from '../_shared/useInsights'
import {
  allReviewsHref,
  feedbackWords,
  headerPills,
  languageName,
  marketRows,
  needsImport,
  productSubtitle,
  productTabs,
  productTitle,
  returnsFacts,
  reviewByline,
  reviewHref,
  reviewStarsWords,
  studioHref,
  suggestHeld,
  suggestResultWords,
  themeImpact,
  themeInboxHref,
  whenWords,
  type ProductDetail,
  type ProductDetailReview,
  type ProductTab,
} from './productModalModel'
import shared from '../_shared/insights.module.css'
import s from './products.module.css'

export interface ProductReviewsModalProps {
  productId: string
  /** The products on the page, in order, for K / J. */
  ids: readonly string[]
  scope: InsightsScope
  canManage: boolean
  onGo: (productId: string) => void
  onClose: () => void
}

interface SuggestAnswer { ok: boolean; created: unknown[]; theme: string | null; market: string | null; words: string | null }

export function ProductReviewsModal({ productId, ids, scope, canManage, onGo, onClose }: ProductReviewsModalProps) {
  const router = useRouter()
  const { toast } = useToast()
  const [tab, setTab] = useState<ProductTab>('summary')
  const read = useInsightsRead<ProductDetail>(`/reviews/insights/products/${encodeURIComponent(productId)}`, scopeApiParams(scope), ['review.updated', 'review.imported', 'review.alert.changed'])
  const detail = read.data
  const [asking, setAsking] = useState(false)

  const suggest = useCallback(async () => {
    setAsking(true)
    const res = await reviewsSend<SuggestAnswer>('POST', '/reviews/action-items/suggest', { productId })
    setAsking(false)
    if (res.error || !res.data) return toast(res.error ?? 'Nexus could not ask for fixes.', 'danger')
    const created = res.data.created.length
    toast(suggestResultWords(created, res.data.words), created ? 'success' : 'warning')
    if (created) {
      emitInvalidation({ type: 'review.fix.changed' })
      router.push(insightsHref('fixes', { product: productId, channel: scope.channel, market: scope.market, period: scope.period }))
    }
  }, [productId, toast, router, scope.channel, scope.market, scope.period])

  const period = periodWords(scope.period)
  const held = asking ? 'Asking the AI for fixes…' : suggestHeld(canManage, detail)
  const actions = (
    <div className={shared.actions}>
      <Button asChild size="sm">
        <Link href={studioHref(productId)}><ExternalLink size={13} aria-hidden /> Open in product studio</Link>
      </Button>
      <Button size="sm" variant="primary" heldReason={held} onClick={() => void suggest()}>
        <Sparkles size={13} aria-hidden /> {asking ? 'Asking…' : 'Suggest a fix'}
      </Button>
    </div>
  )
  const meta = detail ? (
    <span className={shared.line}>
      {headerPills(detail, period.label).map((p) => <Pill key={p.text} tone={p.tone}>{p.text}</Pill>)}
      {detail.themes[0] && detail.themes[0].starImpact != null && detail.themes[0].starImpact < 0 && <Tag tone="danger">{detail.themes[0].label}</Tag>}
    </span>
  ) : undefined
  const topics = detail?.topicsAt ? new Date(detail.topicsAt).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : null
  const footer = (
    <div className={s.modalFoot}>
      <span className={shared.muted}>
        {topics ? `Amazon topics from ${topics} (English) · ` : ''}reviews {detail ? <>up to <AsOf at={detail.generatedAt} kind="event" /></> : 'loading'}
      </span>
      <Button onClick={onClose}>Close</Button>
    </div>
  )

  return (
    <DetailModal
      open
      onClose={onClose}
      title={detail ? productTitle(detail.product) : 'Product'}
      subtitle={detail ? productSubtitle(detail) : undefined}
      meta={meta}
      actions={actions}
      tabs={productTabs(detail)}
      activeTab={tab}
      onTabChange={(id) => setTab(id as ProductTab)}
      tabsLabel="Product sections"
      nav={{ ids, current: productId, onGo, noun: 'product' }}
      loading={read.loading}
      error={!detail && read.error ? read.error : undefined}
      onRetry={read.reload}
      footer={footer}
    >
      {detail && (
        <div className={s.modalBody}>
          {read.error && <Banner tone="warning" title="Not updating">{read.error}</Banner>}
          {tab === 'summary' && <SummaryTab detail={detail} scope={scope} />}
          {tab === 'reviews' && <ReviewsTab detail={detail} scope={scope} />}
          {tab === 'themes' && <ThemesTab detail={detail} scope={scope} />}
          {tab === 'returns' && <ReturnsTab detail={detail} />}
          {tab === 'sizes' && <SizesTab detail={detail} scope={scope} />}
        </div>
      )}
    </DetailModal>
  )
}

function MarketTable({ detail }: { detail: ProductDetail }) {
  const rows = marketRows(detail)
  if (rows.length === 0) return <p className={shared.muted}>No reviews and no Amazon market for this product in this scope.</p>
  return (
    <SummaryTable
      label="Rating by channel and market"
      columns={['Where', 'Rating', 'Reviews', 'Change']}
      rows={rows.map((r) => ({
        id: r.key,
        cells: [
          <span key="w" className={shared.stack}><span className={shared.main}>{r.where}</span><span className={shared.sub}>{r.note}</span></span>,
          r.kind === 'none' ? (
            needsImport(r)
              ? <Link key="r" href={inboxHref({ import: 1 })}>Import reviews</Link>
              : <span key="r" className={shared.sub}>No rating data</span>
          ) : r.kind === 'positive' ? (
            <span key="r" className={shared.line}><b className={shared.num}>{r.value}</b><span className={shared.sub}>positive</span></span>
          ) : (
            <span key="r" className={shared.line}><b className={shared.num}>{r.value}</b><StarRating value={r.stars} size="sm" /></span>
          ),
          <span key="n" className={shared.num}>{r.reviews}</span>,
          <span key="c" className={shared.num}>{r.change}</span>,
        ],
      }))}
    />
  )
}

function ThemeList({ detail, scope, limit, quotes }: { detail: ProductDetail; scope: InsightsScope; limit?: number; quotes?: boolean }) {
  const themes = limit ? detail.themes.slice(0, limit) : detail.themes
  if (themes.length === 0) return <p className={shared.muted}>No review or Amazon topic about this product names a theme in this period.</p>
  return (
    <ul className={s.themeList}>
      {themes.map((t) => {
        const impact = themeImpact(t)
        return (
          <li key={t.key} className={s.themeRow}>
            <Link href={themeInboxHref(detail, t.key, scope)} className={s.themeName}>{t.label}</Link>
            <ProgressBar value={t.share ?? 0} height={6} ariaLabel={`${t.label}: ${t.share ?? 0}% of this product’s reviews`} />
            <span className={shared.num}>{t.share == null ? '—' : `${t.share}%`}</span>
            <span title={impact.words} aria-label={impact.words}><Pill tone={impact.tone}>{impact.text}</Pill></span>
            {quotes && t.quote && (
              <span className={`${shared.sub} ${s.themeQuote}`}>
                <Tag tone="neutral">{t.quote.from}</Tag> “{t.quote.text}”{t.quote.english ? ` — translated: “${t.quote.english}”` : ''}
              </span>
            )}
          </li>
        )
      })}
    </ul>
  )
}

function ReviewCard({ review }: { review: ProductDetailReview }) {
  const now = new Date()
  const fb = review.kind === 'feedback' ? feedbackWords(review.rating) : null
  return (
    <li className={s.reviewCard}>
      <div className={shared.line}>
        {fb ? <Pill tone={fb.tone}>{fb.text}</Pill> : <StarRating value={review.rating} size="sm" label={reviewStarsWords(review)} />}
        <span className={shared.sub}>{reviewByline(review)} · {whenWords(review.postedAt, now)}</span>
      </div>
      <p lang={review.language ?? undefined}>{review.text || 'No text'}</p>
      {review.english && <p className={shared.sub}>Translated from {languageName(review.language) ?? 'another language'}: {review.english}</p>}
      <div className={shared.line}>
        {review.themes.map((t) => <Tag key={t} tone="neutral">{t}</Tag>)}
        <Button asChild size="sm" variant="link"><Link href={reviewHref(review.id)}>Open in the Inbox</Link></Button>
      </div>
    </li>
  )
}

function SummaryTab({ detail, scope }: { detail: ProductDetail; scope: InsightsScope }) {
  const s0 = detail.summary
  return (
    <div className={s.summaryGrid}>
      <div className={s.summaryCol}>
        <Card header="Rating by channel and market"><MarketTable detail={detail} /></Card>
        <Card header="Latest reviews" headerAction={<Button asChild size="sm" variant="link"><Link href={allReviewsHref(detail, scope)}>All {s0.reviewsAllTime.toLocaleString('en-IE')} in the Inbox</Link></Button>}>
          {detail.latest.length ? <ul className={s.reviewList}>{detail.latest.map((r) => <ReviewCard key={r.id} review={r} />)}</ul> : <p className={shared.muted}>No reviews of this product yet.</p>}
        </Card>
      </div>
      <div className={s.summaryCol}>
        <Card header="Rating spread">
          <div className={shared.cardBody}>
            <span className={shared.line}>
              <b className={s.bigRating}>{s0.rating == null ? '—' : s0.rating.toFixed(1)}</b>
              <StarRating value={s0.rating} size="md" count={s0.reviews} />
            </span>
            <RatingBars counts={detail.spread} compact />
            <p className={shared.muted}>{s0.ratingWords}.</p>
          </div>
        </Card>
        <Card header="Themes" description="Share of reviews · star impact against this product’s average">
          <ThemeList detail={detail} scope={scope} limit={5} />
        </Card>
        <Card header="Size fit" description={detail.fit ? fitHeaderWords(detail.fit) : undefined}>
          <div className={shared.cardBody}>
            <FitBySize fit={detail.fit} />
          </div>
        </Card>
      </div>
    </div>
  )
}

function ReviewsTab({ detail, scope }: { detail: ProductDetail; scope: InsightsScope }) {
  return (
    <div className={shared.cardBody}>
      <div className={s.tabHead}>
        <span className={shared.muted}>
          {detail.summary.reviews.toLocaleString('en-IE')} reviews and feedback in the period, newest first · {detail.latest.length} shown here
        </span>
        <Button asChild size="sm"><Link href={allReviewsHref(detail, scope)}>Open all in the Inbox</Link></Button>
      </div>
      {detail.latest.length ? <ul className={s.reviewList}>{detail.latest.map((r) => <ReviewCard key={r.id} review={r} />)}</ul> : <p className={shared.muted}>No reviews of this product yet.</p>}
      <p className={shared.footnote}>Imported Amazon reviews say “imported from a file”: Amazon gives no review text by API.</p>
    </div>
  )
}

function ThemesTab({ detail, scope }: { detail: ProductDetail; scope: InsightsScope }) {
  return (
    <div className={shared.cardBody}>
      <p className={shared.muted}>Every theme in this product’s reviews and Amazon topics, {periodWords(scope.period).label}. Press a theme to open its reviews in the Inbox.</p>
      <ThemeList detail={detail} scope={scope} quotes />
    </div>
  )
}

function ReturnsTab({ detail }: { detail: ProductDetail }) {
  const total = detail.returns.reasons.reduce((n, r) => n + r.count, 0)
  return (
    <div className={shared.cardBody}>
      <KeyValue columns={3} items={returnsFacts(detail).map((f) => ({ label: f.label, value: f.value, hint: f.hint }))} />
      <Card header="Return reasons">
        {total === 0 ? (
          <p className={shared.muted}>No return of this product gave a reason in the last {detail.returns.windowDays} days.</p>
        ) : (
          <ul className={s.themeList}>
            {detail.returns.reasons.map((r) => (
              <li key={r.reason} className={s.themeRow}>
                <span className={shared.main}>{r.reason}</span>
                <ProgressBar value={r.share} height={6} ariaLabel={`${r.reason}: ${r.share}% of returns`} />
                <span className={shared.num}>{r.share}%</span>
                <span className={`${shared.num} ${shared.sub}`}>{r.count}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <p className={shared.footnote}>Return reasons come from Amazon, eBay and Shopify returns. Amazon returns arrive with a delay of about 2 days. Reasons are the buyer’s own choice from the channel’s list.</p>
    </div>
  )
}

const FIT_COLUMNS = ['Runs small', 'True to size', 'Runs large']

function FitMeter({ cell, direction, name }: { cell: FitCell; direction: 'small' | 'true' | 'large'; name: string }) {
  const share = fitShare(cell, direction)
  const what = direction === 'small' ? 'it runs small' : direction === 'large' ? 'it runs large' : 'it is true to size'
  return (
    <span className={s.fitMeter}>
      <ProgressBar value={share} height={6} ariaLabel={share == null ? `${name}: too few mentions to measure` : `${name}: ${share}% say ${what}`} />
      <span className={s.fitNum}>{share == null ? '—' : `${share}%`}</span>
    </span>
  )
}

function FitVerdict({ cell, minimum }: { cell: FitCell; minimum: number }) {
  const v = fitVerdictPill(cell, minimum)
  return (
    <span title={cell.words}>
      <Pill tone={v.tone}>{v.text}</Pill>
      {v.note && <span className="nds-summary-sub">{v.note}</span>}
    </span>
  )
}

interface FitRow { id: string; name: string; cell: FitCell }

/** One fit table: a row per size, or per size and colour, with the three shares, the mentions and the verdict. */
function FitRows({ rows, first, label, minimum, mentions }: { rows: readonly FitRow[]; first: string; label: string; minimum: number; mentions?: boolean }) {
  return (
    <SummaryTable
      label={label}
      stackOnPhone
      columns={[first, ...FIT_COLUMNS, ...(mentions ? ['Mentions'] : []), 'Verdict']}
      align={[undefined, undefined, undefined, undefined, ...(mentions ? ['right' as const] : []), 'left']}
      widths={[mentions ? '22%' : '10%', undefined, undefined, undefined, ...(mentions ? ['11%'] : []), mentions ? '24%' : '34%']}
      rows={rows.map(({ id, name, cell }) => ({
        id,
        cells: [
          <span key="n" className={shared.main}>{name}</span>,
          <FitMeter key="s" cell={cell} direction="small" name={name} />,
          <FitMeter key="t" cell={cell} direction="true" name={name} />,
          <FitMeter key="l" cell={cell} direction="large" name={name} />,
          ...(mentions ? [<span key="m" className={shared.num}>{cell.total}</span>] : []),
          <FitVerdict key="v" cell={cell} minimum={minimum} />,
        ],
      }))}
    />
  )
}

const sizeRows = (fit: ProductFit): FitRow[] => fit.sizes.map((c) => ({ id: c.size, name: c.size, cell: c }))

/** The family's fit per size with what to tell buyers; or why there is none. */
function FitBySize({ fit, mentions }: { fit: ProductFit | null; mentions?: boolean }) {
  if (!fit) return <p className={shared.muted}>This product’s family is no longer in Nexus.</p>
  if (fit.sizes.length === 0) return <p className={shared.muted}>This family has no sizes: fit per size does not apply.</p>
  return (
    <>
      <FitRows rows={sizeRows(fit)} first="Size" label="Fit per size" minimum={fit.minimum} mentions={mentions} />
      <p className={shared.muted}><b>What to tell buyers:</b> {fit.advice}</p>
    </>
  )
}

function SizesTab({ detail, scope }: { detail: ProductDetail; scope: InsightsScope }) {
  const fit = detail.fit
  return (
    <div className={shared.cardBody}>
      <p className={shared.muted}>
        Fit per size and colour of {fit && fit.family.id !== detail.product.id ? `its family, ${fit.family.name}` : 'this family'}, {periodWords(scope.period).label}, from reviews that say how it fits and from
        returns marked “too small” or “too large”{fit ? ` — ${fitHeaderWords(fit)}` : ''}.
      </p>
      <Card header="By size">
        <div className={shared.cardBody}><FitBySize fit={fit} mentions /></div>
      </Card>
      {fit && fit.variants.length > 0 && (
        <Card header="By size and colour" description={`Each variant on its own; it too needs ${fit.minimum} mentions for a verdict.`}>
          <div className={shared.cardBody}>
            <FitRows rows={fit.variants.map((v) => ({ id: v.productId, name: v.label, cell: v }))} first="Product" label="Fit per size and colour" minimum={fit.minimum} mentions />
          </div>
        </Card>
      )}
      {fit && <p className={shared.footnote}>{fit.words}</p>}
    </div>
  )
}
