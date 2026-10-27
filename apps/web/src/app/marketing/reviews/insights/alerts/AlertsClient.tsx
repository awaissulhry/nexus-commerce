'use client'

/**
 * Reviews › Insights › Alerts (`/marketing/reviews/insights/alerts`, build spec §3.4 + ruling 7, the Alerts board): a
 * theme that suddenly comes up more often for one product in one market, or (Phase 3, when "Rating drop" is on in
 * Reviews settings) a product family whose average stars fell in one market (`GET /api/reviews/spikes`, checked hourly).
 *
 *   Tiles    Open (the default) · Acknowledged · Resolved filter the list (`?status=`, a removable chip) · time to resolve
 *   Filters  theme, product
 *   List     newest first; each alert: status, theme, the rise, the product (opens its pop-up), the buyers' words, "See the
 *            N reviews" (the Inbox), who acknowledged or resolved it, and Acknowledge / Resolve / Reopen / Suggest fixes
 *            (`PATCH /api/reviews/spikes/:id`, the AI for fixes) — or a link to its fixes
 *   Bulk     tick alerts (or Select all): Acknowledge N · Resolve N · Suggest fixes (≤ 5) (`POST …/reviews/spikes/bulk`, keyed: a retry never runs it twice),
 *            each counting what it changes and held with why when it changes nothing; Clear unticks; a new status
 *            filter clears the ticks
 *   Aside    how an alert starts, and the last hourly check
 * Without "Manage reviews" every action is held and says so. No optimistic rows: the call, then every open Reviews page
 * reads again, then a toast in the server's count.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Bell, CheckCheck, CircleCheck, RotateCcw, Sparkles } from 'lucide-react'
import { Banner, Card, EmptyState, KeyValue, MetricStrip, ToastProvider, useToast, type Metric } from '@/design-system/components'
import { GridCard, GridSelectionActions, SelectionLabel } from '@/design-system/grid'
import { FilterBar, GridToolbar, type FilterDimension } from '@/design-system/patterns'
import { Button, Checkbox, Pill, Tag, TokenChip } from '@/design-system/primitives'
import { useAuth } from '@/lib/auth/AuthProvider'
import { emitInvalidation } from '@/lib/sync/invalidation-channel'
import Link from '@/lib/workspaces/Link'
import { reviewsSend } from '../../_lib/reviewsFetch'
import { insightsHref, productReviewsHref, reviewsSettingsHref } from '../../_lib/reviewsLinks'
import { THEME_LABEL } from '../../_lib/reviewWords'
import { InsightsHeader } from '../_shared/InsightsHeader'
import { useAddressSync, useInsightsRead, useInsightsScope, useScopeChoices } from '../_shared/useInsights'
import {
  MANAGE_ALERTS,
  STATUS_WORDS,
  agoWords,
  alertActions,
  alertApiStatus,
  alertFilterParam,
  alertReviewsHref,
  alertTiles,
  alertTitle,
  bulkHeld,
  bulkLabel,
  bulkPlan,
  bulkResultWords,
  checkWords,
  clockWords,
  decisionWords,
  emptyTitle,
  filterChip,
  fixWords,
  parseAlertFilter,
  riseWords,
  shownWords,
  timeToResolveWords,
  toggleFilter,
  whoWords,
  type AlertBulkAction,
  type AlertFilter,
  type AlertItem,
  type AlertsAnswer,
} from './alertsModel'
import shared from '../_shared/insights.module.css'
import s from './alerts.module.css'

const EVENTS = ['review.alert.changed', 'review.fix.changed'] as const
const THEME_OPTIONS = [{ value: '', label: 'All' }, ...Object.entries(THEME_LABEL).map(([value, label]) => ({ value, label })), { value: 'RATING_DROP', label: 'Rating drop' }]

interface BulkAnswer { changed: number; held: Array<{ id: string; words: string }>; fixes?: number }

export function AlertsClient() {
  return (
    <ToastProvider>
      <Alerts />
    </ToastProvider>
  )
}

function Alerts() {
  const { status: authStatus, has } = useAuth()
  const canManage = authStatus !== 'authed' || has('reviews.manage')
  const { toast } = useToast()
  const { scope, initial, setScope } = useInsightsScope()

  // ── The address: the status filter, theme and product ──
  const [filter, setFilterState] = useState<AlertFilter | null>(null)
  const [theme, setTheme] = useState<string | null>(null)
  const [product, setProduct] = useState<string | null>(null)
  useEffect(() => {
    if (!initial) return
    setFilterState(parseAlertFilter(initial.get('status')))
    setTheme((initial.get('theme') ?? '').trim().toUpperCase() || null)
    setProduct((initial.get('product') ?? '').trim() || null)
  }, [initial])
  useAddressSync(filter ? scope : null, { status: filter ? alertFilterParam(filter) : null, theme, product })

  const read = useInsightsRead<AlertsAnswer>(
    scope && filter ? '/reviews/spikes' : null,
    scope && filter ? { channel: scope.channel, market: scope.market, status: alertApiStatus(filter), theme, productId: product, limit: 200 } : {},
    [...EVENTS],
    { keep: scope ? `${scope.channel}|${scope.market}` : null },
  )
  const choices = useScopeChoices(scope?.period ?? null)
  const data = read.data
  const items = useMemo(() => data?.items ?? [], [data])

  // ── Ticks: cleared when what shows changes ──
  const [ticked, setTicked] = useState<Set<string>>(new Set())
  const showKey = `${filter}|${theme}|${product}|${scope?.channel}|${scope?.market}`
  useEffect(() => { setTicked(new Set()) }, [showKey])
  // A tick on an alert that is no longer listed (another tab resolved it) goes.
  useEffect(() => {
    setTicked((prev) => {
      const next = new Set([...prev].filter((id) => items.some((a) => a.id === id)))
      return next.size === prev.size ? prev : next
    })
  }, [items])
  const selected = useMemo(() => items.filter((a) => ticked.has(a.id)), [items, ticked])
  const allTicked = items.length > 0 && selected.length === items.length
  const tick = (id: string, on: boolean) => setTicked((prev) => {
    const next = new Set(prev)
    if (on) next.add(id)
    else next.delete(id)
    return next
  })
  const setFilter = (next: AlertFilter) => setFilterState(next)

  // ── Changes ──
  const [busy, setBusy] = useState<string | null>(null)
  const decide = useCallback(async (a: AlertItem, decision: 'ACKNOWLEDGED' | 'RESOLVED' | 'REOPEN') => {
    setBusy(`${a.id}:${decision}`)
    const res = await reviewsSend<unknown>('PATCH', `/reviews/spikes/${encodeURIComponent(a.id)}`, { status: decision })
    setBusy(null)
    if (res.error) return toast(res.error, 'danger')
    emitInvalidation({ type: 'review.alert.changed', id: a.id })
    toast(decisionWords(decision, a), 'success')
  }, [toast])

  const runBulk = useCallback(async (action: AlertBulkAction, ids: string[]) => {
    setBusy(`bulk:${action}`)
    const res = await reviewsSend<BulkAnswer>('POST', '/reviews/spikes/bulk', { ids, action }, { idempotent: true, what: 'change' })
    setBusy(null)
    if (res.error || !res.data) return toast(res.error ?? 'Nexus could not do this.', 'danger')
    emitInvalidation({ type: 'review.alert.changed' })
    if (action === 'suggest' && (res.data.fixes ?? 0) > 0) emitInvalidation({ type: 'review.fix.changed' })
    toast(bulkResultWords(action, res.data.changed, res.data.held, res.data.fixes), res.data.changed ? 'success' : 'warning')
    setTicked(new Set())
  }, [toast])

  // ── Tiles, filters ──
  const tiles = data ? alertTiles(data) : []
  const ttr = data ? timeToResolveWords(data.timeToResolve) : null
  const metrics: Metric[] = data && filter
    ? [
        ...tiles.map((t) => ({ label: t.label, value: t.value, hint: t.hint, accent: t.accent, onClick: () => setFilter(toggleFilter(filter, t.status)), active: filter === t.status })),
        { label: 'Time to resolve', value: ttr?.value ?? '—', delta: ttr?.delta ?? undefined, hint: 'middle value, last 30 days' },
      ]
    : []
  const productOptions = useMemo(() => {
    const seen = new Map<string, string>()
    for (const a of items) if (a.product) seen.set(a.product.id, a.product.name)
    if (product && !seen.has(product)) seen.set(product, 'This product')
    return [{ value: '', label: 'All' }, ...[...seen.entries()].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label))]
  }, [items, product])
  const dimensions: FilterDimension[] = [
    { key: 'theme', label: 'Theme', kind: 'select', options: THEME_OPTIONS, value: theme ?? '', onChange: (v) => setTheme(v || null) },
    { key: 'product', label: 'Product', kind: 'select', options: productOptions, value: product ?? '', onChange: (v) => setProduct(v || null) },
  ]
  const chip = filter ? filterChip(filter) : null
  const now = Date.now()
  const check = data ? checkWords(data.check, now) : null

  // ── Bulk bar ──
  const bulkBar = selected.length > 0 ? (() => {
    const actions: Array<{ action: AlertBulkAction; icon: typeof Bell }> = [
      { action: 'acknowledge', icon: CheckCheck },
      { action: 'resolve', icon: CircleCheck },
      { action: 'suggest', icon: Sparkles },
    ]
    return (
      <GridSelectionActions>
        {actions.map(({ action, icon: Icon }) => {
          const plan = bulkPlan(selected, action)
          const held = busy ? 'Wait for the change on its way.' : bulkHeld(canManage, action, selected.length, plan)
          return (
            <Button key={action} size="sm" heldReason={held} onClick={() => void runBulk(action, plan.apply)}>
              <Icon size={13} aria-hidden /> <SelectionLabel>{bulkLabel(action, plan)}</SelectionLabel>
            </Button>
          )
        })}
        <Button size="sm" variant="link" onClick={() => setTicked(new Set())}>Clear</Button>
      </GridSelectionActions>
    )
  })() : null

  const subtitle = !scope || read.loading
    ? 'Loading…'
    : data ? `A theme that suddenly comes up more often, or a rating that drops, for one product in one market · ${data.counts.open} open · checked every hour` : 'A theme that suddenly comes up more often, or a rating that drops'

  return (
    <div className={shared.page}>
      <InsightsHeader scope={scope} onScope={setScope} subtitle={subtitle} choices={choices.data?.options ?? []} />

      {metrics.length > 0 && <MetricStrip metrics={metrics} minTileWidth={150} />}

      <FilterBar dimensions={dimensions} activeCount={[theme, product].filter(Boolean).length} onClear={() => { setTheme(null); setProduct(null) }} defaultOpen={false} />

      {chip && filter && (
        <div className={shared.chips} role="group" aria-label="This page shows only">
          <TokenChip removeLabel={chip.removeLabel} onRemove={() => setFilter('ALL')}>{chip.label}</TokenChip>
        </div>
      )}

      <div className={shared.split}>
        <div className={shared.column}>
          {read.error && !data ? (
            <Banner tone="danger" title="Couldn’t read the alerts" action={<Button size="sm" onClick={read.reload}>Try again</Button>}>
              {read.error} This is not an empty list.
            </Banner>
          ) : (
            <GridCard
              toolbar={(
                <GridToolbar
                  count={selected.length ? <><b>{selected.length}</b> selected</> : data && filter ? <b>{shownWords(items.length, filter)}</b> : 'Reading…'}
                  right={(
                    <>
                      <span className={shared.sub}>Newest first</span>
                      {check && <Pill tone={read.error ? 'danger' : check.tone} dot size="md">{read.error ? 'Not updating' : check.words}</Pill>}
                    </>
                  )}
                >
                  {bulkBar}
                </GridToolbar>
              )}
            >
              {read.loading ? (
                <p className={`${shared.muted} ${s.pad}`}>Reading the alerts…</p>
              ) : items.length === 0 ? (
                <EmptyState
                  icon={<Bell size={20} aria-hidden />}
                  title={emptyTitle(filter ?? 'OPEN')}
                  description={filter === 'OPEN' ? 'Nexus checks every hour. Resolved alerts stay under “Resolved”.' : 'Nexus checks every hour. An alert opens when a theme suddenly comes up more often for one product in one market, or its rating drops.'}
                  action={filter !== 'ALL' ? <Button size="sm" onClick={() => setFilter('ALL')}>Show every alert</Button> : undefined}
                />
              ) : (
                <>
                  <div className={s.selectAll}>
                    <Checkbox
                      label="Select all"
                      checked={allTicked}
                      aria-label={allTicked ? 'Untick every alert' : 'Select all alerts'}
                      onChange={(e) => setTicked(e.target.checked ? new Set(items.map((a) => a.id)) : new Set())}
                    />
                  </div>
                  <ul className={s.list} aria-label="Alerts">
                    {items.map((a) => (
                      <AlertRow
                        key={a.id}
                        alert={a}
                        ticked={ticked.has(a.id)}
                        onTick={(on) => tick(a.id, on)}
                        canManage={canManage}
                        busy={busy}
                        now={now}
                        reviewsHref={alertReviewsHref(a, { channel: scope?.channel ?? null })}
                        productHref={a.product ? productReviewsHref(a.product.id, { channel: scope?.channel, market: scope?.market, period: scope?.period }) : null}
                        fixesHref={insightsHref('fixes', { product: a.product?.id ?? null, channel: scope?.channel, market: scope?.market, period: scope?.period })}
                        onDecide={(d) => void decide(a, d)}
                        onSuggest={() => void runBulk('suggest', [a.id])}
                      />
                    ))}
                  </ul>
                </>
              )}
            </GridCard>
          )}
          {read.error && data && <p className={shared.muted} role="status">Not updating: {read.error}</p>}
          <p className={shared.footnote}>New alerts also show in Overview › Needs you. Actions need “Manage reviews”; without it the buttons say why.</p>
        </div>

        <aside className={shared.aside} aria-label="About alerts">
          <Card header="How an alert starts">
            <div className={shared.cardBody}>
              <p>For one product in one market, a theme’s share of reviews in the last 7 days is at least <b>2×</b> its share over 28 days, with at least <b>5 reviews</b> in those 7 days.</p>
              <p className={shared.muted}>Amazon topics count once a week, when Amazon’s report arrives. Resolving does not hide it for good: if the share stays high for 7 more days, a new alert opens.</p>
              <p>A <b>rating drop</b>: a product family’s average stars in one market fall <b>0.3</b> or more, the last 7 days against the 28 days before, with at least <b>5 rated reviews</b> in each — when “Rating drop” is on in Reviews settings.</p>
              <p className={shared.muted}>Only product reviews with stars count: never seller feedback, and Amazon only from imported reviews.</p>
              <Button asChild size="sm" variant="link"><Link href={reviewsSettingsHref('alerts')}>Who is told, in Reviews settings</Link></Button>
            </div>
          </Card>
          <Card header="Last check" headerAction={check ? <Pill tone={check.tone}>{check.tone === 'danger' ? 'Failed' : check.tone === 'success' ? 'Ran fine' : 'Not yet'}</Pill> : undefined}>
            {data ? (
              <KeyValue
                columns={2}
                dense
                items={[
                  { label: 'Ran', value: clockWords(data.check.lastRunAt), hint: agoWords(data.check.lastRunAt, now) },
                  { label: 'Next', value: clockWords(data.check.nextRunAt), hint: 'every hour' },
                ]}
              />
            ) : <p className={shared.muted}>Reading…</p>}
          </Card>
        </aside>
      </div>
    </div>
  )
}

interface AlertRowProps {
  alert: AlertItem
  ticked: boolean
  onTick: (on: boolean) => void
  canManage: boolean
  busy: string | null
  now: number
  reviewsHref: string
  productHref: string | null
  fixesHref: string
  onDecide: (decision: 'ACKNOWLEDGED' | 'RESOLVED' | 'REOPEN') => void
  onSuggest: () => void
}

function AlertRow({ alert: a, ticked, onTick, canManage, busy, now, reviewsHref, productHref, fixesHref, onDecide, onSuggest }: AlertRowProps) {
  const can = alertActions(a)
  const st = STATUS_WORDS[a.status]
  const who = whoWords(a, now)
  const fixes = fixWords(a)
  const held = !canManage ? MANAGE_ALERTS : busy ? 'Wait for the change on its way.' : null
  const name = a.product?.name ?? 'A product'
  return (
    <li className={s.row}>
      <div className={s.tick}>
        <Checkbox checked={ticked} onChange={(e) => onTick(e.target.checked)} aria-label={`Select: ${a.theme.label} for ${name} in ${a.where}`} />
      </div>
      <div className={s.body}>
        <div className={shared.line}>
          <Pill tone={st.tone}>{st.word}</Pill>
          {a.newToday && <Pill tone="info">New today</Pill>}
          <Tag tone="danger">{a.theme.label}</Tag>
          <span className={shared.main}>{alertTitle(a)}</span>
        </div>
        <div className={`${shared.line} ${shared.sub}`}>
          {productHref ? <Link href={productHref}>{name}</Link> : <span>{name}</span>}
          <span>{a.where}</span>
          <span><b>{riseWords(a)}</b></span>
          <span>Opened {agoWords(a.detectedAt, now)}</span>
        </div>
        <div className={shared.line}>
          {a.phrases.length > 0 && <span className={shared.sub}>Buyers say:</span>}
          {a.phrases.slice(0, 3).map((p) => <Tag key={p} tone="neutral">“{p}”</Tag>)}
          <Button asChild size="sm" variant="link"><Link href={reviewsHref}>See the {a.count} {a.count === 1 ? 'review' : 'reviews'}</Link></Button>
        </div>
        {who && <span className={shared.sub}>{who}</span>}
      </div>
      <div className={s.actions}>
        {can.acknowledge && <Button size="sm" heldReason={held} onClick={() => onDecide('ACKNOWLEDGED')}><CheckCheck size={13} aria-hidden /> Acknowledge</Button>}
        {can.resolve && <Button size="sm" heldReason={held} onClick={() => onDecide('RESOLVED')}><CircleCheck size={13} aria-hidden /> Resolve</Button>}
        {can.reopen && <Button size="sm" heldReason={held} onClick={() => onDecide('REOPEN')}><RotateCcw size={13} aria-hidden /> Reopen</Button>}
        {can.suggest && <Button size="sm" variant="primary" heldReason={held ?? can.suggestHeld} onClick={onSuggest}><Sparkles size={13} aria-hidden /> Suggest fixes</Button>}
        {fixes && <Button asChild size="sm" variant="tonal"><Link href={fixesHref}>{fixes}</Link></Button>}
      </div>
    </li>
  )
}
