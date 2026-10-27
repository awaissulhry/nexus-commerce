'use client'

/**
 * Reviews › Requests › the rule editor (`/marketing/reviews/requests/rules/<id>`, `new` for a new rule; build spec
 * §3.3c, PR C): a full page, not a pop-up — the DS Builder in page mode: a section strip across the top, the sections in
 * the middle, the live column on the right ("When it sends", Test run), and the save bar (⌘S) at the end.
 *
 *   Name · Who (channel, market, shipped by, product types, minimum total) · When (first try, window, send hour, skip
 *   weekends, best day) · Skip when · Message (Amazon's own fixed message; our email shown, its own text per rule comes
 *   later) · Sentiment check (kept exactly as it was, Owner ruling 2) · A/B split (PR J: AbSplitCard.tsx — start, results,
 *   how sure, End test).
 *
 * Saving: POST (new) or PATCH the whole rule; Save is held with the first thing to fix (ruleForm.ts `saveHeld`). The
 * notes are checked for buyer-copy problems (`POST /api/review-rules/lint`); an error holds Save.
 */
import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, ArrowLeft, Copy, Mail, TestTube2 } from 'lucide-react'
import { Banner, Card, EmptyState, Field, Listbox, SummaryTable, ToastProvider, useToast, type ListboxOption } from '@/design-system/components'
import { Builder, EditModeBar, PageHeader, type BuilderSection } from '@/design-system/patterns'
import { Button, Checkbox, Input, NumberStepper, Pill, RadioCard, SegmentedControl, Skeleton, TagInput, Textarea, Toggle } from '@/design-system/primitives'
import { COUNTRY_NAMES } from '@/app/_shared/app-nav'
import { useAuth } from '@/lib/auth/AuthProvider'
import { emitInvalidation } from '@/lib/sync/invalidation-channel'
import Link from '@/lib/workspaces/Link'
import { usePathname, useRouter } from '@/lib/workspaces/navigation'
import { reviewsGet, reviewsSend } from '../../../../_lib/reviewsFetch'
import { EBAY_NOT_EMAILED } from '../../../../_lib/reviewWords'
import { reviewsCrumbs } from '../../../../_shell/reviews-crumbs'
import { ReviewsMenuButton } from '../../../../_shell/ReviewsShell'
import { AMAZON_EMAIL_WORDS, EmailPreviewModal } from '../../../_queue/EmailPreviewModal'
import { NEW_RULE_ID, RULES_PATH, rulePath, timingPath } from '../../../requestsPaths'
import { channelWords, duplicateHeld, marketsWords, type RuleItem } from '../../_rules/rulesModel'
import { TestRunModal, firstTryWhen, readDryRun, type DryRun } from '../../_rules/TestRunModal'
import {
  NEW_RULE_FORM,
  RULE_MARKETS,
  RULE_SCOPES,
  SKIP_CHOICES,
  WINDOW_MAX,
  WINDOW_MIN,
  changedFields,
  formFromRule,
  isAmazon,
  ruleBody,
  saveHeld,
  toggleSkip,
  unsavedWords,
  withFirstTryDays,
  withScope,
  withWindow,
  type Anchor,
  type LintIssue,
  type RuleForm,
  type ShippedBy,
} from './ruleForm'
import { previewBody, whenItSends, type TimingPreview } from './whenItSends'
import { AbSplitCard } from './AbSplitCard'
import s from './editor.module.css'

const PREVIEW_DEBOUNCE_MS = 400
const LINT_DEBOUNCE_MS = 500
const MARKET_OPTIONS: ListboxOption[] = RULE_MARKETS.map((m) => ({ value: m, label: COUNTRY_NAMES[m] ?? m }))
const HOUR_OPTIONS: ListboxOption[] = Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: `${String(h).padStart(2, '0')}:00` }))
const SHIPPED_BY_OPTIONS = [
  { value: 'any', label: 'Anyone' },
  { value: 'fbm', label: 'Us (FBM)' },
  { value: 'fba', label: 'Amazon (FBA)' },
]
const FIRST_TRY_OPTIONS = [
  { value: 'table', label: 'Product-type table' },
  { value: 'custom', label: 'This rule’s own day' },
]

export function RuleEditorClient({ id }: { id: string }) {
  return (
    <ToastProvider>
      {/* A new rule saved becomes its own page: a fresh editor, not the new one's state. */}
      <RuleEditor key={id} id={id} />
    </ToastProvider>
  )
}

interface Loaded { rule: RuleItem | null; error: string | null; status: number }

function RuleEditor({ id }: { id: string }) {
  const isNew = id === NEW_RULE_ID
  const pathname = usePathname() ?? RULES_PATH
  const router = useRouter()
  const { status: authStatus, has } = useAuth()
  const canManage = authStatus !== 'authed' || has('reviews.manage')
  const { toast } = useToast()

  // ── The rule, every rule (A/B marks), the product-type words ──
  const [loaded, setLoaded] = useState<Loaded | null>(isNew ? { rule: null, error: null, status: 200 } : null)
  const [initial, setInitial] = useState<RuleForm | null>(isNew ? NEW_RULE_FORM : null)
  const [form, setForm] = useState<RuleForm>(NEW_RULE_FORM)
  const [allRules, setAllRules] = useState<RuleItem[]>([])
  const [patterns, setPatterns] = useState<string[]>([])

  const load = useCallback(async () => {
    if (isNew) return
    const res = await reviewsGet<RuleItem>(`/review-rules/${encodeURIComponent(id)}`)
    setLoaded({ rule: res.data, error: res.error, status: res.status })
    if (res.data) {
      const f = formFromRule(res.data)
      setInitial(f)
      setForm(f)
    }
  }, [id, isNew])
  useEffect(() => { void load() }, [load])
  useEffect(() => {
    void reviewsGet<{ items: RuleItem[] }>('/review-rules').then((res) => setAllRules(res.data?.items ?? []))
    void reviewsGet<{ items: { pattern: string }[] }>('/review-timing-defaults').then((res) => setPatterns([...new Set((res.data?.items ?? []).map((i) => i.pattern))]))
  }, [])

  const update = useCallback((patch: Partial<RuleForm> | ((f: RuleForm) => RuleForm)) => {
    setForm((f) => (typeof patch === 'function' ? patch(f) : { ...f, ...patch }))
  }, [])

  // ── Notes copy check ──
  const [lint, setLint] = useState<LintIssue[]>([])
  useEffect(() => {
    const text = form.notes
    if (!text.trim()) {
      setLint([])
      return
    }
    const t = window.setTimeout(() => {
      void reviewsSend<{ issues: LintIssue[] }>('POST', '/review-rules/lint', { text }).then((res) => setLint(res.data?.issues ?? []))
    }, LINT_DEBOUNCE_MS)
    return () => window.clearTimeout(t)
  }, [form.notes])

  // ── When it sends (live) ──
  const [preview, setPreview] = useState<{ data: TimingPreview | null; error: string | null } | null>(null)
  const previewKey = JSON.stringify(previewBody(form))
  useEffect(() => {
    let alive = true
    const t = window.setTimeout(() => {
      void reviewsSend<TimingPreview>('POST', '/review-rules/preview-timing', JSON.parse(previewKey)).then((res) => {
        if (alive) setPreview({ data: res.data, error: res.error })
      })
    }, PREVIEW_DEBOUNCE_MS)
    return () => {
      alive = false
      window.clearTimeout(t)
    }
  }, [previewKey])

  // ── Test run (of the saved rule) ──
  const [dry, setDry] = useState<{ data: DryRun | null; error: string | null; at: number } | null>(null)
  const runDry = useCallback(async () => {
    if (isNew) return
    setDry(null)
    const res = await readDryRun(id)
    setDry({ data: res.data, error: res.error, at: Date.now() })
  }, [id, isNew])
  useEffect(() => { void runDry() }, [runDry])
  const [testOpen, setTestOpen] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)

  // ── Save ──
  const changes = initial ? changedFields(initial, form) : []
  const count = changes.length
  const [saving, setSaving] = useState(false)
  const held = saveHeld(form, { canManage, lint }) ?? (saving ? 'Saving…' : null)
  const save = useCallback(async () => {
    if (saveHeld(form, { canManage, lint })) return
    setSaving(true)
    const body = ruleBody(form)
    const res = isNew
      ? await reviewsSend<RuleItem>('POST', '/review-rules', body, { idempotent: true, what: 'rule' })
      : await reviewsSend<RuleItem>('PATCH', `/review-rules/${encodeURIComponent(id)}`, body)
    setSaving(false)
    if (res.error || !res.data) return toast(res.error ?? 'The rule was not saved.', 'danger')
    emitInvalidation({ type: 'review.rule.changed', id: res.data.id })
    toast(isNew ? `“${res.data.name}” saved${res.data.isActive ? ' and on' : ' (off)'}` : 'Rule saved', 'success')
    if (isNew) {
      setInitial(form)
      router.replace(rulePath(res.data.id))
      return
    }
    const next = formFromRule({ ...res.data, exclusions: res.data.exclusions ?? body.exclusions })
    setInitial(next)
    setForm(next)
    void runDry()
  }, [form, canManage, lint, isNew, id, toast, router, runDry])
  const discard = useCallback(() => { if (initial) setForm(initial) }, [initial])

  const duplicate = useCallback(async () => {
    const res = await reviewsSend<{ rule: { id: string; name: string } }>('POST', `/review-rules/${encodeURIComponent(id)}/duplicate`, undefined, { idempotent: true, what: 'copy' })
    if (res.error || !res.data) return toast(res.error ?? 'Nexus could not copy the rule.', 'danger')
    emitInvalidation({ type: 'review.rule.changed', id: res.data.rule.id })
    toast(`“${res.data.rule.name}” made (off) — change it, then turn it on`, 'success')
    router.push(rulePath(res.data.rule.id))
  }, [id, toast, router])

  // ── Not found / failed ──
  if (!isNew && loaded && !loaded.rule) {
    return (
      <div className={s.page}>
        <PageHeader eyebrow={reviewsCrumbs(pathname)} title="Rule" actions={<ReviewsMenuButton />} />
        <EmptyState
          icon={<AlertTriangle size={20} aria-hidden />}
          title={loaded.status === 404 ? 'This rule does not exist any more' : 'Couldn’t read the rule'}
          description={loaded.error ?? undefined}
          action={(
            <span className={s.row}>
              {loaded.status !== 404 && <Button size="sm" onClick={() => void load()}>Try again</Button>}
              <Button asChild size="sm"><Link href={RULES_PATH}>Back to rules</Link></Button>
            </span>
          )}
        />
      </div>
    )
  }
  if (!initial) {
    return (
      <div className={s.page} aria-busy="true" aria-label="Loading the rule">
        <Skeleton width={220} height={12} />
        <Skeleton width={260} height={26} />
        <Skeleton height={480} />
      </div>
    )
  }

  const amazon = isAmazon(form.scope)
  const knownScope = RULE_SCOPES.some((sc) => sc.value === form.scope)
  const savedRule = loaded?.rule ?? null
  const dupHeld = isNew ? 'Save the rule first.' : count > 0 ? 'Save your changes first — the copy is made from the saved rule.' : !canManage ? "You need 'Manage reviews' to copy a rule." : duplicateHeld(form, allRules)
  const testHeld = isNew ? 'Save the rule first: a test run reads the saved rule.' : null
  const preview_ = preview?.data ? whenItSends(preview.data) : null
  const lintErrors = lint.filter((i) => i.severity === 'error')

  const sections: BuilderSection[] = [
    {
      id: 'name',
      label: 'Name',
      title: 'Name',
      content: (
        <div className={s.fields}>
          <p className={s.hint}>Only your team sees the name and notes.</p>
          <Field label="Rule name" required>
            <Input value={form.name} onChange={(e) => update({ name: e.target.value })} placeholder="e.g. Germany jackets" maxLength={120} />
          </Field>
          <Field label="Notes" hint="Checked for words a buyer message may not use (a reward, a request for a good rating).">
            <Textarea value={form.notes} onChange={(e) => update({ notes: e.target.value })} rows={3} limit={500} />
          </Field>
          {lint.length > 0 && (
            <ul className={s.lint} aria-label="Problems in the notes">
              {lint.map((issue, i) => (
                <li key={i} className={issue.severity === 'error' ? s.lintError : s.lintWarn}>
                  {issue.severity === 'error' ? 'Not allowed: ' : 'Check: '}{issue.message}{issue.match ? ` (“${issue.match}”)` : ''}
                </li>
              ))}
            </ul>
          )}
        </div>
      ),
    },
    {
      id: 'who',
      label: 'Who',
      title: 'Who — which orders this rule asks',
      content: (
        <div className={s.fields}>
          {!knownScope && (
            <Banner tone="warning" title={`This rule is for ${channelWords(form)}: it matches no orders`}>
              Nexus asks only Amazon and Shopify buyers. Pick one of them, or delete the rule.
            </Banner>
          )}
          {form.scope === 'EBAY' && (
            <Banner tone="warning" title="eBay buyers are not e-mailed">
              {EBAY_NOT_EMAILED} Pick Amazon or Shopify, or delete the rule.
            </Banner>
          )}
          <div className={s.scopes} role="radiogroup" aria-label="Channel">
            {RULE_SCOPES.map((sc) => (
              <RadioCard
                key={sc.value}
                name="rule-scope"
                value={sc.value}
                title={sc.title}
                description={sc.description}
                checked={form.scope === sc.value}
                selected={form.scope === sc.value}
                onChange={() => update((f) => withScope(f, sc.value))}
              />
            ))}
          </div>
          {form.scope === 'AMAZON_PER_MARKETPLACE' && (
            <Field label="Market" required hint="A rule for one market wins over the rule for all markets.">
              <Listbox options={MARKET_OPTIONS} value={form.marketplace ?? undefined} onChange={(v) => update({ marketplace: v })} placeholder="Pick the market" ariaLabel="Market" width={220} />
            </Field>
          )}
          {amazon && (
            <Field label="Shipped by">
              <SegmentedControl size="sm" ariaLabel="Shipped by" options={SHIPPED_BY_OPTIONS} value={form.shippedBy} onChange={(v) => update({ shippedBy: v as ShippedBy })} />
            </Field>
          )}
          <Field label="Product types" hint="Words in the product type. Empty = every product.">
            <TagInput value={form.productTypes} onChange={(tags) => update({ productTypes: tags.map((t) => t.toLowerCase()) })} suggestions={patterns} placeholder="Add a word…" aria-label="Product types" />
          </Field>
          <Field label="Minimum order total" hint="Skip orders below this total, tax included. Empty = no minimum.">
            <Input value={form.minOrderTotal} onChange={(e) => update({ minOrderTotal: e.target.value })} prefix="€" inputMode="decimal" placeholder="0.00" fieldClassName={s.money} />
          </Field>
        </div>
      ),
    },
    {
      id: 'when',
      label: 'When',
      title: 'When — the day and hour of the first try',
      content: (
        <div className={s.fields}>
          <Field label="First try">
            <div className={s.stack}>
              <SegmentedControl size="sm" ariaLabel="Where the first try’s day comes from" options={FIRST_TRY_OPTIONS} value={form.firstTryMode} onChange={(v) => update({ firstTryMode: v as RuleForm['firstTryMode'] })} />
              {form.firstTryMode === 'custom' ? (
                <span className={s.row}>
                  <NumberStepper value={form.firstTryDays} onChange={(n) => update((f) => withFirstTryDays(f, n))} min={amazon ? WINDOW_MIN : 1} max={amazon ? WINDOW_MAX : 60} size="sm" suffix="days" decrementLabel="One day earlier" incrementLabel="One day later" />
                  <span>after</span>
                  {amazon ? (
                    <strong>delivery</strong>
                  ) : (
                    <SegmentedControl
                      size="sm"
                      ariaLabel="Count from"
                      options={[{ value: 'DELIVERY', label: 'delivery' }, { value: 'SHIP', label: 'shipping' }, ...(form.anchor === 'PURCHASE' ? [{ value: 'PURCHASE', label: 'the order' }] : [])]}
                      value={form.anchor}
                      onChange={(v) => update({ anchor: v as Anchor })}
                    />
                  )}
                </span>
              ) : (
                <span className={s.hint}>
                  The first matching row of the <Link href={timingPath()}>product-type table (Timing)</Link> sets the day.
                </span>
              )}
              {amazon && <span className={s.hint}>Amazon counts from delivery, so an Amazon rule always does too.</span>}
            </div>
          </Field>
          <Field label="Allowed window" hint={`Orders delivered day ${WINDOW_MIN}–${WINDOW_MAX} ago. Amazon allows day 5–30 after its own delivery date; Nexus counts from its own, so day 4 is the earliest.`}>
            <span className={s.row}>
              <NumberStepper value={form.windowFrom} onChange={(n) => update((f) => withWindow(f, n, f.windowTo))} min={WINDOW_MIN} max={WINDOW_MAX} size="sm" decrementLabel="First day earlier" incrementLabel="First day later" aria-label="First day of the window" />
              <span>to</span>
              <NumberStepper value={form.windowTo} onChange={(n) => update((f) => withWindow(f, f.windowFrom, n))} min={WINDOW_MIN} max={WINDOW_MAX} size="sm" decrementLabel="Last day earlier" incrementLabel="Last day later" aria-label="Last day of the window" />
              <span>days</span>
            </span>
          </Field>
          <div className={s.toggleRow}>
            <Toggle checked={form.fixedHour} onChange={(v) => update({ fixedHour: v })} aria-label="Fixed send hour" />
            <div className={s.toggleText}>
              <strong>Fixed send hour</strong>
              <span className={s.hint}>{form.fixedHour ? 'Every first try goes at this hour, buyer’s local time.' : 'Off: the best hour of each weekday from Timing (Send hour by weekday).'}</span>
              {form.fixedHour && <Listbox options={HOUR_OPTIONS} value={String(form.sendHour)} onChange={(v) => update({ sendHour: Number(v) })} ariaLabel="Send hour" width={110} />}
            </div>
          </div>
          <div className={s.toggleRow}>
            <Toggle checked={form.skipWeekends} onChange={(v) => update({ skipWeekends: v })} aria-label="Skip weekends" />
            <div className={s.toggleText}>
              <strong>Skip weekends</strong>
              <span className={s.hint}>A Saturday or Sunday try moves to Monday.</span>
            </div>
          </div>
          <div className={s.toggleRow}>
            <Toggle checked={form.shiftToBestDay} onChange={(v) => update({ shiftToBestDay: v })} aria-label="Shift to the best day" />
            <div className={s.toggleText}>
              <strong>Shift to the best day</strong>
              <span className={s.hint}>Moves the try to the best-ranked nearby weekday from Timing, inside the window.</span>
            </div>
          </div>
        </div>
      ),
    },
    {
      id: 'skip',
      label: 'Skip when',
      title: 'Skip when',
      content: (
        <div className={s.fields}>
          <p className={s.hint}>Operational reasons only — facts about the order. A skipped order is never asked.</p>
          {SKIP_CHOICES.map((c) => (
            <Checkbox
              key={c.key}
              checked={form.skips.includes(c.key)}
              onChange={() => update((f) => toggleSkip(f, c.key))}
              label={<span className={s.checkLabel}><span>{c.label}</span><span className={s.hint}>{c.hint}</span></span>}
            />
          ))}
        </div>
      ),
    },
    {
      id: 'message',
      label: 'Message',
      title: 'Message',
      content: amazon ? (
        <Banner tone="info" title="Amazon sends its own fixed message">
          {AMAZON_EMAIL_WORDS} Nobody can change its text — this rule only picks the day.
        </Banner>
      ) : form.scope === 'EBAY' ? (
        <Banner tone="info" title="No message: eBay asks the buyer itself">{EBAY_NOT_EMAILED}</Banner>
      ) : (
        <div className={s.fields}>
          <p className={s.hint}>
            {channelWords(form)} buyers get our review email — Italian for Italy, English for every other market — asking for an
            honest review, with an unsubscribe link. Every rule sends the same text today.
          </p>
          <div>
            <Button size="sm" onClick={() => setPreviewOpen(true)}><Mail size={13} aria-hidden /> Preview email</Button>
          </div>
          {/* ⛔ KEEP — Coming later placeholder (Owner ruling 3): this rule's own subject and text per language (Phase 3). */}
          <p className={s.placeholder}>
            <Pill tone="neutral">Coming later</Pill> This rule’s own subject and text per language, with a live check of the words.
          </p>
        </div>
      ),
    },
    {
      id: 'sentiment',
      label: 'Sentiment check',
      title: 'Sentiment check',
      content: (
        <div className={s.fields}>
          <div className={s.toggleRow}>
            <Toggle checked={form.useSentimentDiversion} onChange={(v) => update({ useSentimentDiversion: v })} aria-label="Ask “How was it?” first" />
            <div className={s.toggleText}>
              <strong>Ask “How was it?” first</strong>
              <span className={s.hint}>
                Before the review request, the buyer gets our “How was it?” email with two buttons. A happy answer goes on to the review
                request; an unhappy one goes to your support inbox{amazon ? ', and Amazon’s request is then not sent for that order' : ', and our review email is then not sent'}.
              </span>
              <span className={s.hint}>
                Ask every buyer the same way: asking only happy buyers, or sending unhappy buyers elsewhere, is not allowed.
              </span>
              <span className={s.hint}>
                Timing: the “How was it?” email goes on day {form.windowFrom} after delivery. With no answer in 5 days, the switch
                below decides.
              </span>
            </div>
          </div>
          {form.useSentimentDiversion && (
            <div className={s.toggleRow}>
              <Toggle checked={form.fallbackOnNoResponse} onChange={(v) => update({ fallbackOnNoResponse: v })} aria-label="Ask anyway when there is no answer in 5 days" />
              <div className={s.toggleText}>
                <strong>Ask anyway when there is no answer in 5 days</strong>
                <span className={s.hint}>
                  On — the review request goes after 5 days without an answer (default). Off — a buyer who did not answer
                  “How was it?” is not asked.
                </span>
              </div>
            </div>
          )}
        </div>
      ),
    },
    {
      id: 'ab',
      label: 'A/B split',
      title: 'A/B split',
      content: <AbSplitCard rule={savedRule} rules={allRules} canManage={canManage} unsaved={count} />,
    },
  ]

  const aside = (
    <div className={s.aside}>
      <Card header="When it sends" description="Live — follows your changes">
        {preview?.error ? (
          <p className={s.errorText}>{preview.error}</p>
        ) : !preview_ ? (
          <Skeleton height={120} />
        ) : (
          <div className={s.when}>
            <p className={s.whenLine}>{preview_.line}</p>
            <ol className={s.steps}>
              {preview_.steps.map((st) => (
                <li key={st.label}>
                  <strong>{st.label}</strong> <span>{st.when}</span>
                  <span className={s.hint}>{st.detail}</span>
                </li>
              ))}
            </ol>
            <p className={s.hint}>{preview_.note}</p>
          </div>
        )}
      </Card>
      <Card
        header="Test run"
        description={isNew ? 'After the first save' : dry ? `Ran ${firstTryWhen(new Date(dry.at).toISOString())}` : 'Running…'}
        headerAction={<Button size="sm" onClick={() => void runDry()} heldReason={testHeld}>Run again</Button>}
      >
        {isNew ? (
          <p className={s.hint}>Save the rule, then see which orders it would ask today. Nothing is sent by a test run.</p>
        ) : !dry ? (
          <Skeleton height={90} />
        ) : dry.error ? (
          <p className={s.errorText}>{dry.error}</p>
        ) : dry.data ? (
          <div className={s.when}>
            {count > 0 && <p className={s.warnText}>Ran on the saved rule, before your changes — save, then run again to see the new result.</p>}
            <p className={s.whenLine}>{dry.data.matchCount} {dry.data.matchCount === 1 ? 'order' : 'orders'} would be asked today</p>
            {dry.data.sample.length > 0 && (
              <SummaryTable label="Sample orders" columns={['Order', 'First try']} rows={dry.data.sample.slice(0, 3).map((o) => ({ id: o.orderId, cells: [o.channelOrderId, firstTryWhen(o.scheduledFor)] }))} />
            )}
            <p className={s.hint}>Nothing is sent by a test run.</p>
          </div>
        ) : null}
      </Card>
    </div>
  )

  const footer = count > 0 || isNew ? (
    <EditModeBar
      message={count > 0 ? `${unsavedWords(count)}` : 'New rule — not saved yet'}
      count={count}
      onDiscard={isNew ? () => router.push(RULES_PATH) : discard}
      onApply={() => void save()}
      applyLabel="Save rule"
      busy={saving}
      applyHeldReason={held ?? (count === 0 && !isNew ? 'Nothing changed yet.' : null)}
      saveShortcut
    />
  ) : undefined

  const subtitle = isNew
    ? 'A new rule · off until you turn it on'
    : `${channelWords(form)} · ${marketsWords(form)} · ${form.isActive ? 'on' : 'off'}${savedRule && savedRule.isActive !== form.isActive ? ' (not saved)' : ''}`

  const actions = (
    <div className={s.actions}>
      <ReviewsMenuButton />
      <span className={s.onOff}>
        <Toggle checked={form.isActive} onChange={(v) => update({ isActive: v })} aria-label={form.isActive ? 'Rule is on — turn it off' : 'Rule is off — turn it on'} />
        <span>{form.isActive ? 'On' : 'Off'}</span>
      </span>
      <Button size="sm" onClick={() => void duplicate()} heldReason={dupHeld}><Copy size={13} aria-hidden /> Duplicate as A/B</Button>
      <Button size="sm" onClick={() => setTestOpen(true)} heldReason={testHeld}><TestTube2 size={13} aria-hidden /> Test run</Button>
      <Button asChild size="sm"><Link href={RULES_PATH}><ArrowLeft size={13} aria-hidden /> Back to rules</Link></Button>
    </div>
  )

  return (
    <div className={s.page}>
      <PageHeader eyebrow={reviewsCrumbs(pathname)} title={isNew ? (form.name.trim() || 'New rule') : form.name.trim() || savedRule?.name || 'Rule'} subtitle={subtitle} actions={actions} />
      {lintErrors.length > 0 && (
        <Banner tone="danger" title={`${lintErrors.length} ${lintErrors.length === 1 ? 'problem' : 'problems'} in the notes`}>Save waits until the notes are fixed.</Banner>
      )}
      <Builder mode="page" sections={sections} aside={aside} asideLabel="When it sends and test run" footer={footer} navLabel="Rule sections" />
      {testOpen && savedRule && <TestRunModal rules={[{ id: savedRule.id, name: savedRule.name, isActive: savedRule.isActive }]} onClose={() => setTestOpen(false)} canManage={canManage} />}
      {previewOpen && <EmailPreviewModal onClose={() => setPreviewOpen(false)} canManage={canManage} sending={null} />}
    </div>
  )
}
