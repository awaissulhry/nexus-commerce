'use client'

/**
 * Reviews › Requests › Timing — the "Timing tests" section (build spec B22, PR J): try different first-try days on real
 * Amazon orders and keep the one that brings more reviews.
 *
 *   New timing test   market, product type, the days to compare (2–4), the holdout % that gets no request, when it ends
 *                     (at this market's pace). "Start test — send for approval": the test is made and a person approves
 *                     its start on the Approvals page — nothing changes before (`reviewsSend('POST', '/review-timing-tests')`).
 *   A test's card     not started (why, send again) · waiting for approval · running (each group's progress, "too early
 *                     to call" or the leader and how sure, Stop test…) · finished or stopped (the result in words, the
 *                     table per group, Apply winner — send for approval, Keep day N).
 * Stop test needs no approval: it only stops a split (it asks first, and says what happens).
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Banner, Card, Field, Listbox, ProgressBar, SummaryTable, useActionConfirm, useToast, type ListboxOption } from '@/design-system/components'
import { Button, FilterChip, NumberStepper, Pill, Skeleton } from '@/design-system/primitives'
import { useInvalidationChannel, emitInvalidation } from '@/lib/sync/invalidation-channel'
import Link from '@/lib/workspaces/Link'
import { reviewsGet, reviewsSend } from '../../../_lib/reviewsFetch'
import {
  APPROVALS_PATH,
  DAY_CHOICES,
  HOLDOUT_MAX,
  NEW_TEST_FORM,
  TEST_MARKETS,
  armLine,
  armProgress,
  armRows,
  daysHint,
  keepLabel,
  needMoreWords,
  newTestBody,
  newTestHeld,
  splitTests,
  statusPill,
  toggleDay,
  type AskAnswer,
  type NewTestForm,
  type TimingEstimate,
  type TimingTest,
  type TimingTestsAnswer,
} from './timingTestsModel'
import s from './timing.module.css'

const MARKET_OPTIONS: ListboxOption[] = TEST_MARKETS.map((m) => ({ value: m.value, label: m.label }))

export interface TimingTestsSectionProps {
  canManage: boolean
  /** The product-type words of the timing table (the product type picker). */
  patterns: readonly string[]
}

export function TimingTestsSection({ canManage, patterns }: TimingTestsSectionProps) {
  const { toast } = useToast()
  const confirm = useActionConfirm()
  const [answer, setAnswer] = useState<{ data: TimingTestsAnswer | null; error: string | null } | null>(null)
  const load = useCallback(async () => {
    const res = await reviewsGet<TimingTestsAnswer>('/review-timing-tests', { kind: 'TIMING' })
    setAnswer({ data: res.data, error: res.error })
  }, [])
  useEffect(() => { void load() }, [load])
  useInvalidationChannel(['review.rule.changed'], () => { void load() })

  const after = useCallback(async (res: { data: AskAnswer | { test: TimingTest } | null; error: string | null }, done: string) => {
    if (res.error || !res.data) {
      toast(res.error ?? 'Nexus could not do this.', 'danger')
    } else if ('approval' in res.data && !res.data.approval) {
      toast(res.data.words ?? 'It was not sent for approval.', 'danger')
    } else {
      toast(done, 'success')
    }
    emitInvalidation({ type: 'review.rule.changed' })
    await load()
  }, [toast, load])

  const startAgain = useCallback(async (t: TimingTest) => {
    const res = await reviewsSend<AskAnswer>('POST', `/review-timing-tests/${encodeURIComponent(t.id)}/start`, undefined, { idempotent: true, what: 'start' })
    await after(res, 'Sent for approval — the test starts once a person approves it')
  }, [after])

  const stop = useCallback(async (t: TimingTest) => {
    const waiting = t.status === 'WAITING_APPROVAL'
    const ok = await confirm.ask({
      level: 'confirm',
      title: t.status === 'RUNNING' ? `Stop the test ${t.title}?` : `Stop ${t.title} before it starts?`,
      confirmLabel: 'Stop test',
      consequences: t.status === 'RUNNING'
        ? [
            'New orders are asked by their rule again from the next run',
            'Requests the test already queued keep their day',
            'Buyers it held out are not asked later',
            'The result so far stays on this page',
          ]
        : [waiting ? 'Its request on the Approvals page is withdrawn' : 'It is never sent for approval', 'Nothing was changed by it'],
    })
    if (!ok) return
    const res = await reviewsSend<{ test: TimingTest }>('POST', `/review-timing-tests/${encodeURIComponent(t.id)}/stop`, undefined, { idempotent: true, what: 'stop' })
    await after(res, `${t.title}: the test stopped`)
  }, [confirm, after])

  const apply = useCallback(async (t: TimingTest) => {
    const res = await reviewsSend<AskAnswer>('POST', `/review-timing-tests/${encodeURIComponent(t.id)}/apply`, undefined, { idempotent: true, what: 'apply' })
    await after(res, 'Sent for approval — the rule changes once a person approves it')
  }, [after])

  const keep = useCallback(async (t: TimingTest) => {
    const res = await reviewsSend<{ test: TimingTest }>('POST', `/review-timing-tests/${encodeURIComponent(t.id)}/keep`, undefined, { idempotent: true, what: 'keep' })
    await after(res, `${keepLabel(t).replace(/^Keep/, 'Kept')} — nothing changed`)
  }, [after])

  const tests = answer?.data?.tests ?? []
  const { live, ended } = splitTests(tests)

  return (
    <section className={s.tests} aria-labelledby="timing-tests-title">
      <div className={s.testsHead}>
        <h2 id="timing-tests-title" className={s.sectionTitle}>Timing tests</h2>
        <p className={s.muted}>
          Try different first-try days on real orders and keep the one that brings more reviews. Each buyer is still asked only once.
          A test starts only after a person approves it, and you set how many orders get no request at all.
        </p>
      </div>
      {answer?.error && !answer.data ? (
        <Banner tone="danger" title="Could not read the timing tests" action={<Button size="sm" onClick={() => void load()}>Try again</Button>}>{answer.error}</Banner>
      ) : null}
      <div className={s.testGrid}>
        <NewTimingTest canManage={canManage} patterns={patterns} onSent={after} />
        {!answer ? <Skeleton height={260} /> : null}
        {[...live, ...ended].map((t) => (
          <TestCard key={t.id} test={t} canManage={canManage} onStart={startAgain} onStop={stop} onApply={apply} onKeep={keep} />
        ))}
      </div>
      {confirm.element}
    </section>
  )
}

// ── New timing test ──────────────────────────────────────────────────────────────────────────────────────────────

function NewTimingTest({ canManage, patterns, onSent }: { canManage: boolean; patterns: readonly string[]; onSent: (res: { data: AskAnswer | null; error: string | null }, done: string) => Promise<void> }) {
  const [form, setForm] = useState<NewTestForm>(NEW_TEST_FORM)
  const [sending, setSending] = useState(false)
  const [estimate, setEstimate] = useState<{ key: string; data: TimingEstimate | null; error: string | null } | null>(null)
  const typeOptions: ListboxOption[] = useMemo(() => [{ value: '', label: 'Every product' }, ...[...new Set(patterns)].sort().map((p) => ({ value: p, label: p }))], [patterns])
  const key = JSON.stringify([form.market, form.productType, form.days, form.holdoutPct])
  useEffect(() => {
    let alive = true
    const t = window.setTimeout(() => {
      void reviewsGet<TimingEstimate>('/review-timing-tests/estimate', { market: form.market, productType: form.productType || undefined, days: form.days.join(','), holdout: form.holdoutPct }).then((res) => {
        if (alive) setEstimate({ key, data: res.data, error: res.error })
      })
    }, 300)
    return () => {
      alive = false
      window.clearTimeout(t)
    }
  }, [key, form.market, form.productType, form.days, form.holdoutPct])
  const est = estimate?.key === key ? estimate : null
  const held = newTestHeld(form, { canManage, sending })

  const send = useCallback(async () => {
    if (newTestHeld(form, { canManage, sending: false })) return
    setSending(true)
    const res = await reviewsSend<AskAnswer>('POST', '/review-timing-tests', newTestBody(form), { idempotent: true, what: 'test' })
    setSending(false)
    await onSent(res, 'Sent for approval — the test starts once a person approves it')
    if (res.data?.approval) setForm(NEW_TEST_FORM)
  }, [form, canManage, onSent])

  return (
    <Card header="New timing test" description="Splits new orders by order number" headingLevel={3}>
      <div className={s.stack}>
        <div className={s.formRow}>
          <Field label="Market">
            <Listbox options={MARKET_OPTIONS} value={form.market} onChange={(v) => setForm((f) => ({ ...f, market: v }))} ariaLabel="Market" width={200} />
          </Field>
          <Field label="Product type">
            <Listbox options={typeOptions} value={form.productType} onChange={(v) => setForm((f) => ({ ...f, productType: v }))} ariaLabel="Product type" width={200} />
          </Field>
        </div>
        <Field label={<span id="new-test-days">Compare first try on</span>} hint={daysHint(form)}>
          <div className={s.chips} role="group" aria-labelledby="new-test-days">
            {DAY_CHOICES.map((d) => (
              <FilterChip key={d} pressed={form.days.includes(d)} onClick={() => setForm((f) => toggleDay(f, d))}>Day {d}</FilterChip>
            ))}
          </div>
        </Field>
        {est?.data ? <p className={s.muted}>{est.data.currentWords}.</p> : null}
        <div className={s.formRow}>
          <Field label="Holdout — not asked" hint="Shows what asking adds at all. These buyers get no request.">
            <div className={s.stepperBox}>
              <NumberStepper size="sm" value={form.holdoutPct} min={0} max={HOLDOUT_MAX} suffix="%" onChange={(v) => setForm((f) => ({ ...f, holdoutPct: v }))} aria-label="Holdout, percent of the orders not asked" decrementLabel="Smaller holdout" incrementLabel="Bigger holdout" />
            </div>
          </Field>
          <Field label="Ends">
            <span className={s.endsText}>{est?.error ? est.error : est?.data ? est.data.endsWords : 'Reading the pace of this market…'}</span>
          </Field>
        </div>
        <div className={s.sendRow}>
          <Button size="sm" variant="primary" onClick={() => void send()} heldReason={held}>Start test — send for approval</Button>
          <span className={s.muted}>It changes when real buyers are asked, so a person approves it first.</span>
        </div>
      </div>
    </Card>
  )
}

// ── One test ─────────────────────────────────────────────────────────────────────────────────────────────────────

interface TestCardProps {
  test: TimingTest
  canManage: boolean
  onStart: (t: TimingTest) => void
  onStop: (t: TimingTest) => void
  onApply: (t: TimingTest) => void
  onKeep: (t: TimingTest) => void
}

const MANAGE = "You need 'Manage reviews' to change a test."

function TestCard({ test, canManage, onStart, onStop, onApply, onKeep }: TestCardProps) {
  const pill = statusPill(test)
  const since = test.startedAt ? ` · started ${new Date(test.startedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : ''
  const manage = canManage ? null : MANAGE
  const stopButton = (
    <Button size="sm" variant="danger-outline" onClick={() => onStop(test)} heldReason={manage ?? test.held.stop}>Stop test…</Button>
  )
  return (
    <Card header={test.title} description={`${test.groupsWords}${since}`} headerAction={<Pill tone={pill.tone} dot>{pill.label}</Pill>} headingLevel={3}>
      <div className={s.stack}>
        {test.status === 'DRAFT' && (
          <>
            {test.lastWords ? <Banner tone="warning" title="Not started">{test.lastWords}</Banner> : <p className={s.muted}>Not sent for approval yet.</p>}
            <div className={s.sendRow}>
              <Button size="sm" variant="primary" onClick={() => onStart(test)} heldReason={manage ?? test.held.start}>Send for approval again</Button>
              {stopButton}
            </div>
          </>
        )}
        {test.status === 'WAITING_APPROVAL' && (
          <>
            <p className={s.muted}>A person approves the start on the Approvals page. Nothing changes before. {test.endsWords}.</p>
            {test.lastWords ? <Banner tone="warning" title="The approved start did not run">{test.lastWords}</Banner> : null}
            <div className={s.sendRow}>
              <Button asChild size="sm"><Link href={APPROVALS_PATH}>Open Approvals</Link></Button>
              {stopButton}
            </div>
          </>
        )}
        {test.status === 'RUNNING' && (
          <>
            <ul className={s.armList} aria-label={`Groups of ${test.title}`}>
              {[...test.arms].sort((a, b) => a.position - b.position).map((a) => (
                <li key={a.id} className={s.armRow}>
                  <span className={s.armLabel}>{a.label}</span>
                  <ProgressBar value={armProgress(a, test)} ariaLabel={`${a.label}: ${armLine(a)}`} />
                  <span className={s.armCount}>{armLine(a)}</span>
                </li>
              ))}
            </ul>
            <Banner tone="info" title="Result so far">
              {test.result.words}{needMoreWords(test) && !test.result.words.includes('more orders') ? ` ${needMoreWords(test)}` : ''}
            </Banner>
            <p className={s.muted}>{test.endsWords}. {test.countedWords}</p>
            <div className={s.sendRow}>{stopButton}</div>
          </>
        )}
        {(test.status === 'DONE' || test.status === 'STOPPED') && <ResultBody test={test} manage={manage} onApply={onApply} onKeep={onKeep} />}
      </div>
    </Card>
  )
}

function ResultBody({ test, manage, onApply, onKeep }: { test: TimingTest; manage: string | null; onApply: (t: TimingTest) => void; onKeep: (t: TimingTest) => void }) {
  const rows = armRows(test)
  return (
    <>
      <p className={s.headline}>{test.result.words}</p>
      <SummaryTable
        label={`Result of ${test.title} by first try`}
        columns={['First try', 'Orders', 'Sent', 'Counted', 'Reviews', 'Rate']}
        align={[undefined, 'right', 'right', 'right', 'right', 'right']}
        rows={rows.map((r) => ({ id: r.id, cells: r.leader ? r.cells.map((c, i) => (i === 0 || i === 5 ? <strong key={i}>{c}</strong> : c)) : r.cells }))}
        stackOnPhone
      />
      <p className={s.muted}>
        {test.result.sureWords ? `${test.result.sureWords} ` : ''}{test.countedWords}
      </p>
      {test.status === 'STOPPED' && test.lastWords ? <p className={s.muted}>{test.lastWords}</p> : null}
      {test.applied ? (
        <p className={s.applied}>
          <Pill tone="success" dot>Applied</Pill> “{test.applied.ruleName}” asks on day {test.applied.delayDays} after delivery.
        </p>
      ) : test.kept ? (
        <p className={s.applied}><Pill tone="neutral">Kept</Pill> The day in place stays. Nothing was changed.</p>
      ) : null}
      {test.applyWords ? <p className={s.muted}>{test.applyWords}</p> : null}
      <div className={s.sendRow}>
        {test.approval?.what === 'apply' ? (
          <>
            <Pill tone="warning" dot size="md">Waiting for approval</Pill>
            <Button asChild size="sm"><Link href={APPROVALS_PATH}>Open Approvals</Link></Button>
          </>
        ) : !test.applied && !test.kept ? (
          <Button size="sm" variant="primary" onClick={() => onApply(test)} heldReason={manage ?? test.held.apply}>Apply winner — send for approval</Button>
        ) : null}
        {!test.applied && !test.kept && test.approval?.what !== 'apply' ? (
          <Button size="sm" onClick={() => onKeep(test)} heldReason={manage ?? test.held.keep}>{keepLabel(test)}</Button>
        ) : null}
      </div>
    </>
  )
}
