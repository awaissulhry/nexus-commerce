'use client'

/**
 * Reviews › Requests › Timing (`/marketing/reviews/requests/timing`, build spec §3.3d, PR C): which day and hour buyers
 * are asked, for the rules that do not set their own.
 *
 *   First try by product type   the first matching row from the top wins; reorder, add, remove, Reset to built-in…;
 *                               "Everything else" (the built-in default) is pinned last.
 *   Send hour by weekday        per market (Global default · Italy · Germany · France · Spain · UK): the heatmap of the
 *                               review rate by hour (the hour we send outlined) and the seven days' hour, rank and on/off.
 *                               `?section=send-hours` scrolls here.
 *   Conversion by send time     the parts of the day, with how far the numbers can be trusted.
 *   Timing tests                (PR J) a new test, the running ones, the results: TimingTestsSection.tsx.
 * One save bar (⌘S) saves both tables: `PUT /api/review-timing-defaults` and `PUT /api/review-send-windows` per market.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { Banner, Card, Listbox, SummaryTable, ToastProvider, useActionConfirm, useToast, type ListboxOption } from '@/design-system/components'
import { EditModeBar, PageHeader } from '@/design-system/patterns'
import { Button, Input, NumberStepper, SegmentedControl, Skeleton, Toggle, ToolbarButton } from '@/design-system/primitives'
import { useAuth } from '@/lib/auth/AuthProvider'
import { emitInvalidation, useInvalidationChannel } from '@/lib/sync/invalidation-channel'
import Link from '@/lib/workspaces/Link'
import { usePathname } from '@/lib/workspaces/navigation'
import { reviewsGet, reviewsSend } from '../../../_lib/reviewsFetch'
import { reviewsCrumbs } from '../../../_shell/reviews-crumbs'
import { ReviewsMenuButton } from '../../../_shell/ReviewsShell'
import { RULES_PATH } from '../../requestsPaths'
import type { RuleItem } from '../../rules/_rules/rulesModel'
import { SendHourHeatmap } from './SendHourHeatmap'
import { TimingTestsSection } from './TimingTestsSection'
import {
  BUILT_IN_DEFAULT_DAYS,
  DELAY_MAX,
  DELAY_MIN,
  GLOBAL_MARKET,
  TIMING_MARKETS,
  WEEKDAYS,
  addRow,
  dayParts,
  defaultsBody,
  defaultsChanges,
  defaultsHeld,
  hourWords,
  marketLabel,
  moveRow,
  removeRow,
  rowsFromDefaults,
  sampleWords,
  updateRow,
  usedByWords,
  windowsBody,
  windowsChanges,
  windowsFor,
  type ConversionReport,
  type SendWindow,
  type TimingDefault,
  type TypeRow,
  type WindowRow,
} from './timingModel'
import s from './timing.module.css'

const MANAGE_TIMING = "You need 'Manage reviews' to change the timing."
const HOUR_OPTIONS: ListboxOption[] = Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: hourWords(h) }))

export function TimingClient() {
  return (
    <ToastProvider>
      <Timing />
    </ToastProvider>
  )
}

function Timing() {
  const pathname = usePathname() ?? '/marketing/reviews/requests/timing'
  const { status: authStatus, has } = useAuth()
  const canManage = authStatus !== 'authed' || has('reviews.manage')
  const { toast } = useToast()
  const confirm = useActionConfirm()

  // ── Reads ──
  const [defaults, setDefaults] = useState<{ rows: TypeRow[] | null; error: string | null } | null>(null)
  const [windows, setWindows] = useState<{ all: SendWindow[] | null; error: string | null } | null>(null)
  const [rules, setRules] = useState<RuleItem[]>([])
  const loadDefaults = useCallback(async () => {
    const res = await reviewsGet<{ items: TimingDefault[] }>('/review-timing-defaults')
    setDefaults({ rows: res.data ? rowsFromDefaults(res.data.items) : null, error: res.error })
  }, [])
  const loadWindows = useCallback(async () => {
    const res = await reviewsGet<{ windows: SendWindow[] }>('/review-send-windows')
    setWindows({ all: res.data?.windows ?? null, error: res.error })
  }, [])
  const loadRules = useCallback(async () => {
    const res = await reviewsGet<{ items: RuleItem[] }>('/review-rules')
    setRules(res.data?.items ?? [])
  }, [])
  useEffect(() => {
    void loadDefaults()
    void loadWindows()
    void loadRules()
  }, [loadDefaults, loadWindows, loadRules])

  // ── Drafts ──
  const [typeDraft, setTypeDraft] = useState<TypeRow[] | null>(null)
  const [windowDrafts, setWindowDrafts] = useState<Record<string, WindowRow[]>>({})
  useEffect(() => { if (defaults?.rows) setTypeDraft(defaults.rows) }, [defaults])

  const [market, setMarket] = useState<string>(GLOBAL_MARKET)
  const read = useMemo(() => (windows?.all ? windowsFor(windows.all, market) : null), [windows, market])
  const dayRows = windowDrafts[market] ?? read?.rows ?? []
  const setDay = useCallback((dow: number, patch: Partial<WindowRow>) => {
    if (!read) return
    setWindowDrafts((d) => ({ ...d, [market]: (d[market] ?? read.rows).map((r) => (r.dayOfWeek === dow ? { ...r, ...patch } : r)) }))
  }, [market, read])

  // Something changed elsewhere (another tab saved): read again, keeping nothing stale.
  useInvalidationChannel(['review.rule.changed'], () => {
    void loadRules()
  })

  // ── Conversion for the market shown ──
  const [conversion, setConversion] = useState<{ market: string; data: ConversionReport | null; error: string | null } | null>(null)
  const loadConversion = useCallback(async () => {
    const res = await reviewsGet<ConversionReport>('/review-send-windows/conversion', { marketplace: market, windowDays: 90 })
    setConversion({ market, data: res.data, error: res.error })
  }, [market])
  useEffect(() => { void loadConversion() }, [loadConversion])
  const conv = conversion && conversion.market === market ? conversion : null

  // ── `?section=send-hours`: scroll there once, then drop it from the address ──
  const sendHoursRef = useRef<HTMLDivElement>(null)
  const scrolled = useRef(false)
  useEffect(() => {
    // The product-type table above must be drawn first (its draft, or its error): its loading rows are taller, so a
    // scroll made before it is drawn ends past the section.
    if (scrolled.current || !windows || !(typeDraft || defaults?.error)) return
    const params = new URLSearchParams(window.location.search)
    if (params.get('section') !== 'send-hours') return
    scrolled.current = true
    sendHoursRef.current?.scrollIntoView({ block: 'start' })
    params.delete('section')
    const rest = params.toString()
    window.history.replaceState({}, '', `${window.location.pathname}${rest ? `?${rest}` : ''}`)
  }, [windows, defaults, typeDraft])

  // ── What a save would change ──
  const typeChanges = defaults?.rows && typeDraft ? defaultsChanges(defaults.rows, typeDraft) : 0
  const windowChanges = useMemo(() => {
    if (!windows?.all) return {} as Record<string, number>
    const out: Record<string, number> = {}
    for (const [m, rows] of Object.entries(windowDrafts)) {
      const n = windowsChanges(windowsFor(windows.all, m).rows, rows)
      if (n) out[m] = n
    }
    return out
  }, [windows, windowDrafts])
  const windowCount = Object.values(windowChanges).reduce((a, b) => a + b, 0)
  const count = typeChanges + windowCount
  const [saving, setSaving] = useState(false)
  const held = !canManage ? MANAGE_TIMING : (typeDraft && typeChanges ? defaultsHeld(typeDraft) : null) ?? (saving ? 'Saving…' : null)

  const save = useCallback(async () => {
    if (held || !typeDraft) return
    setSaving(true)
    const failures: string[] = []
    if (typeChanges) {
      const res = await reviewsSend('PUT', '/review-timing-defaults', defaultsBody(typeDraft))
      if (res.error) failures.push(`Product types: ${res.error}`)
    }
    for (const m of Object.keys(windowChanges)) {
      const res = await reviewsSend('PUT', '/review-send-windows', windowsBody(m, windowDrafts[m]))
      if (res.error) failures.push(`${marketLabel(m)}: ${res.error}`)
    }
    setSaving(false)
    emitInvalidation({ type: 'review.rule.changed' })
    if (failures.length) toast(`Not everything was saved — ${failures.join(' · ')}`, 'danger')
    else toast(`Timing saved (${count} ${count === 1 ? 'change' : 'changes'})`, 'success')
    setWindowDrafts({})
    await Promise.all([loadDefaults(), loadWindows(), loadConversion()])
  }, [held, typeDraft, typeChanges, windowChanges, windowDrafts, count, toast, loadDefaults, loadWindows, loadConversion])

  const discard = useCallback(() => {
    if (defaults?.rows) setTypeDraft(defaults.rows)
    setWindowDrafts({})
  }, [defaults])

  // ── Resets (ask first; saved at once) ──
  const resetTypes = useCallback(async () => {
    const ok = await confirm.ask({
      level: 'confirm',
      title: 'Reset the product types to the built-in table?',
      confirmLabel: 'Reset to built-in',
      consequences: ['Puts the built-in product types back with their built-in days, turned on', 'Rows you added stay as they are', 'Unsaved changes to this table are dropped'],
    })
    if (!ok) return
    const res = await reviewsSend('POST', '/review-timing-defaults/seed?reset=1', undefined, { idempotent: true, what: 'reset' })
    if (res.error) return toast(res.error, 'danger')
    toast('The built-in product types are back', 'success')
    emitInvalidation({ type: 'review.rule.changed' })
    void loadDefaults()
  }, [confirm, toast, loadDefaults])

  const resetMarket = useCallback(async () => {
    const global = market === GLOBAL_MARKET
    const ok = await confirm.ask(global
      ? { level: 'confirm', title: 'Reset the global send hours?', confirmLabel: 'Reset to built-in', consequences: ['Puts the built-in hour and rank back for every weekday', 'Markets with their own times keep them'] }
      : { level: 'confirm', title: `Let ${marketLabel(market)} use the global default?`, confirmLabel: 'Use the global default', consequences: [`Removes ${marketLabel(market)}’s own send hours`, `${marketLabel(market)} then follows the global default`] })
    if (!ok) return
    const res = global
      ? await reviewsSend('POST', '/review-send-windows/seed?reset=1', undefined, { idempotent: true, what: 'reset' })
      : await reviewsSend('PUT', '/review-send-windows', { marketplace: market, windows: [] })
    if (res.error) return toast(res.error, 'danger')
    toast(global ? 'The global send hours are back to built-in' : `${marketLabel(market)} uses the global default`, 'success')
    setWindowDrafts((d) => {
      const next = { ...d }
      delete next[market]
      return next
    })
    emitInvalidation({ type: 'review.rule.changed' })
    void loadWindows()
  }, [market, confirm, toast, loadWindows])

  const manageHeld = canManage ? null : MANAGE_TIMING
  // The product-type words a timing test may pick (the saved table's).
  const patternWords = useMemo(() => (defaults?.rows ?? []).map((r) => r.pattern).filter(Boolean), [defaults])
  const actions = (
    <div className={s.actions}>
      <ReviewsMenuButton />
      <Button asChild size="sm"><Link href={RULES_PATH}>Rules</Link></Button>
    </div>
  )

  return (
    <div className={s.page}>
      <PageHeader eyebrow={reviewsCrumbs(pathname)} title="Timing" subtitle="Which day and hour buyers are asked · used by rules that do not set their own" actions={actions} />

      <Card
        header="First try by product type"
        description="Days after delivery. The first match from the top wins; a rule with its own day overrides this table."
        headerAction={(
          <span className={s.actions}>
            <Button size="sm" onClick={() => typeDraft && setTypeDraft(addRow(typeDraft))} heldReason={manageHeld ?? (typeDraft ? null : 'The table is still loading.')}>
              <Plus size={13} aria-hidden /> Add product type
            </Button>
            <Button size="sm" onClick={() => void resetTypes()} heldReason={manageHeld}>
              <RotateCcw size={13} aria-hidden /> Reset to built-in…
            </Button>
          </span>
        )}
      >
        {defaults?.error && !typeDraft ? (
          <Banner tone="danger" title="Could not read the product-type table" action={<Button size="sm" onClick={() => void loadDefaults()}>Try again</Button>}>{defaults.error}</Banner>
        ) : !typeDraft ? (
          <Skeleton height={240} />
        ) : (
          <div className={s.stack}>
            <p className={s.muted}>{usedByWords(rules)}</p>
            <div className={s.typeHead} aria-hidden>
              <span>Order</span><span>Product type</span><span>Matches the word</span><span>First try</span><span>On</span><span />
            </div>
            <ol className={s.typeRows} aria-label="Product types, first match wins">
              {typeDraft.map((row, i) => (
                <li key={row.key} className={s.typeRow}>
                  <span className={s.order}>
                    {i > 0 ? <ToolbarButton icon={<ArrowUp size={14} />} label={`Move ${row.label || row.pattern || 'this row'} up`} onClick={() => setTypeDraft(moveRow(typeDraft, i, -1))} /> : <span className={s.orderGap} />}
                    {i < typeDraft.length - 1 ? <ToolbarButton icon={<ArrowDown size={14} />} label={`Move ${row.label || row.pattern || 'this row'} down`} onClick={() => setTypeDraft(moveRow(typeDraft, i, 1))} /> : <span className={s.orderGap} />}
                  </span>
                  <Input size="sm" aria-label={`Name of row ${i + 1}`} value={row.label} placeholder={row.pattern || 'Name'} onChange={(e) => setTypeDraft(updateRow(typeDraft, row.key, { label: e.target.value }))} />
                  <Input size="sm" aria-label={`Word row ${i + 1} matches`} value={row.pattern} placeholder="e.g. jacket" onChange={(e) => setTypeDraft(updateRow(typeDraft, row.key, { pattern: e.target.value }))} />
                  <NumberStepper size="sm" value={row.delayDays} min={DELAY_MIN} max={DELAY_MAX} suffix="days" onChange={(n) => setTypeDraft(updateRow(typeDraft, row.key, { delayDays: n }))} aria-label={`First try of row ${i + 1}, days after delivery`} decrementLabel="One day earlier" incrementLabel="One day later" />
                  <Toggle size="sm" checked={row.isActive} onChange={(v) => setTypeDraft(updateRow(typeDraft, row.key, { isActive: v }))} aria-label={`Row ${i + 1} is on`} />
                  <ToolbarButton icon={<Trash2 size={14} />} label={`Remove ${row.label || row.pattern || 'this row'}`} onClick={() => setTypeDraft(removeRow(typeDraft, row.key))} />
                </li>
              ))}
              <li className={`${s.typeRow} ${s.pinned}`}>
                <span className={s.order} />
                <strong>Everything else</strong>
                <span className={s.muted}>no row matched</span>
                <span>{BUILT_IN_DEFAULT_DAYS} days (built in)</span>
                <span />
                <span />
              </li>
            </ol>
            <p className={s.muted}>
              Words match anywhere in the product type, in any letter case (“giacca” matches “Giacca touring”). Amazon still only accepts
              day 5–30 after its own delivery date, so an Amazon request never goes out before day 4 or after day 30.
            </p>
          </div>
        )}
      </Card>

      <div id="send-hours" ref={sendHoursRef} className={s.anchor}>
        <Card
          header="Send hour by weekday"
          description="Shaded by review rate of requests sent at that hour, last 90 days · outlined = the hour we send that day · buyer’s local time"
          headerAction={(
            <Button size="sm" onClick={() => void resetMarket()} heldReason={manageHeld ?? (market !== GLOBAL_MARKET && read && !read.own ? `${marketLabel(market)} already uses the global default.` : null)}>
              <RotateCcw size={13} aria-hidden /> {market === GLOBAL_MARKET ? 'Reset to built-in…' : 'Use the global default…'}
            </Button>
          )}
        >
          <div className={s.stack}>
            <SegmentedControl size="sm" wrap ariaLabel="Market" options={TIMING_MARKETS} value={market} onChange={setMarket} />
            {market !== GLOBAL_MARKET && read && !read.own && !windowDrafts[market] && (
              <Banner tone="info" title={`${marketLabel(market)} uses the global default`}>
                Change any hour to give {marketLabel(market)} its own times.
              </Banner>
            )}
            {windows?.error && !read ? (
              <Banner tone="danger" title="Could not read the send hours" action={<Button size="sm" onClick={() => void loadWindows()}>Try again</Button>}>{windows.error}</Banner>
            ) : !read ? (
              <Skeleton height={260} />
            ) : (
              <>
                <SendHourHeatmap report={conv?.data ?? null} rows={dayRows} error={conv?.error ?? null} onRetry={() => void loadConversion()} />
                <div className={s.dayHead} aria-hidden><span>Day</span><span>Send at</span><span>Rank</span><span>On</span></div>
                <ul className={s.dayRows} aria-label={`Send hour per weekday, ${marketLabel(market)}`}>
                  {WEEKDAYS.map((d) => {
                    const row = dayRows.find((r) => r.dayOfWeek === d.dow)
                    if (!row) return null
                    return (
                      <li key={d.dow} className={s.dayRow}>
                        <strong>{d.long}</strong>
                        <Listbox size="sm" options={HOUR_OPTIONS} value={String(row.hourLocal)} onChange={(v) => setDay(d.dow, { hourLocal: Number(v) })} ariaLabel={`${d.long}: send at`} width={100} />
                        <NumberStepper size="sm" value={row.dayRank} min={1} max={7} onChange={(n) => setDay(d.dow, { dayRank: n })} aria-label={`${d.long}: rank`} decrementLabel="Better rank" incrementLabel="Worse rank" />
                        <Toggle size="sm" checked={row.isActive} onChange={(v) => setDay(d.dow, { isActive: v })} aria-label={`${d.long} is on`} />
                      </li>
                    )
                  })}
                </ul>
                <p className={s.muted}>Rank decides where “Shift to the best day” moves a try (1 = best). A rule with a fixed send hour ignores this table.</p>
              </>
            )}
          </div>
        </Card>
      </div>

      <Card header="Conversion by send time" description={`${marketLabel(market)} · last 90 days`}>
        {conv?.error ? (
          <Banner tone="danger" title="Could not read the conversion" action={<Button size="sm" onClick={() => void loadConversion()}>Try again</Button>}>{conv.error}</Banner>
        ) : !conv?.data ? (
          <Skeleton height={160} />
        ) : (
          <div className={s.stack}>
            <SummaryTable
              label="Conversion by part of the day"
              columns={['Sent in the', 'Sent', 'Reviews', 'Rate']}
              rows={dayParts(conv.data).map((p) => ({ id: p.label, cells: [p.label, p.sent.toLocaleString('en-IE'), p.sent ? p.reviews.toLocaleString('en-IE') : '—', p.rate] }))}
            />
            <p className={s.muted}>{sampleWords(conv.data)}</p>
          </div>
        )}
      </Card>

      <TimingTestsSection canManage={canManage} patterns={patternWords} />

      {count > 0 && (
        <EditModeBar
          message={`${count} unsaved ${count === 1 ? 'change' : 'changes'} in the timing tables`}
          count={count}
          onDiscard={discard}
          onApply={() => void save()}
          applyLabel="Save"
          busy={saving}
          applyHeldReason={held}
          saveShortcut
        />
      )}
      {confirm.element}
    </div>
  )
}
