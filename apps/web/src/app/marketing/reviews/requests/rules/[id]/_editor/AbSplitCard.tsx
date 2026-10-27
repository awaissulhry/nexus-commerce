'use client'

/**
 * Reviews › Requests › the rule editor — the A/B split (build spec B22, PR J). A rule and its "Duplicate as A/B" copy B
 * split the orders rule A decides, 50 / 50 by order number: half are asked by A, half get B's timing and sentiment check.
 *
 *   no copy yet      says how to make one (Duplicate as A/B, top of the page)
 *   copy, no split   what each side does; "Start A/B test — send for approval" (held with why: A on, B off, B differs,
 *                    saved) → `POST /api/review-timing-tests/ab`; a person approves the start on the Approvals page
 *   waiting          Open Approvals, End test…
 *   running / ended  Side · Sent · Counted · Rate, the result in words, how sure (a bar), Open B (or Open A), End test…
 * End test needs no approval: it only stops the split (it asks first, and says what happens).
 */
import { useCallback, useEffect, useState } from 'react'
import { Banner, ProgressBar, SummaryTable, useActionConfirm, useToast } from '@/design-system/components'
import { Button, Pill, Skeleton } from '@/design-system/primitives'
import { emitInvalidation, useInvalidationChannel } from '@/lib/sync/invalidation-channel'
import Link from '@/lib/workspaces/Link'
import { reviewsGet, reviewsSend } from '../../../../_lib/reviewsFetch'
import { rulePath } from '../../../requestsPaths'
import {
  APPROVALS_PATH,
  abPartner,
  abRows,
  abStartHeld,
  abTestOf,
  needMoreWords,
  sideTimingWords,
  splitTests,
  statusPill,
  type AbRule,
  type AskAnswer,
  type TimingTest,
  type TimingTestsAnswer,
} from '../../../timing/_timing/timingTestsModel'
import s from './editor.module.css'

export interface AbSplitCardProps {
  /** The saved rule (null for a new rule). */
  rule: AbRule | null
  rules: readonly AbRule[]
  canManage: boolean
  /** Unsaved changes in the editor: the split uses the saved rules. */
  unsaved: number
}

export function AbSplitCard({ rule, rules, canManage, unsaved }: AbSplitCardProps) {
  const { toast } = useToast()
  const confirm = useActionConfirm()
  const [answer, setAnswer] = useState<{ data: TimingTestsAnswer | null; error: string | null } | null>(null)
  const [sending, setSending] = useState(false)
  const ruleId = rule?.id ?? null
  const load = useCallback(async () => {
    if (!ruleId) return
    const res = await reviewsGet<TimingTestsAnswer>('/review-timing-tests', { kind: 'AB', ruleId })
    setAnswer({ data: res.data, error: res.error })
  }, [ruleId])
  useEffect(() => { void load() }, [load])
  useInvalidationChannel(['review.rule.changed'], () => { void load() })

  const pair = rule ? abPartner(rule, rules.some((r) => r.id === rule.id) ? rules : [...rules, rule]) : null
  const tests = answer?.data?.tests ?? []
  const test = ruleId ? abTestOf(tests, ruleId) : null
  const live = test && splitTests([test]).live.length ? test : null

  const start = useCallback(async () => {
    if (!ruleId) return
    setSending(true)
    const res = live?.status === 'DRAFT'
      ? await reviewsSend<AskAnswer>('POST', `/review-timing-tests/${encodeURIComponent(live.id)}/start`, undefined, { idempotent: true, what: 'start' })
      : await reviewsSend<AskAnswer>('POST', '/review-timing-tests/ab', { ruleId }, { idempotent: true, what: 'split' })
    setSending(false)
    if (res.error || !res.data) toast(res.error ?? 'Nexus could not start the split.', 'danger')
    else if (!res.data.approval) toast(res.data.words ?? 'It was not sent for approval.', 'danger')
    else toast('Sent for approval — the split starts once a person approves it', 'success')
    emitInvalidation({ type: 'review.rule.changed' })
    void load()
  }, [ruleId, live, toast, load])

  const end = useCallback(async (t: TimingTest) => {
    const ok = await confirm.ask({
      level: 'confirm',
      title: 'End this A/B test?',
      confirmLabel: 'End test',
      consequences: t.status === 'RUNNING'
        ? ['Rule A asks all of its orders again from the next run', 'Requests already queued keep their day', 'B stays off', 'The result so far stays on this card']
        : [t.status === 'WAITING_APPROVAL' ? 'Its request on the Approvals page is withdrawn' : 'It is never sent for approval', 'Nothing was changed by it'],
    })
    if (!ok) return
    const res = await reviewsSend<{ test: TimingTest }>('POST', `/review-timing-tests/${encodeURIComponent(t.id)}/stop`, undefined, { idempotent: true, what: 'stop' })
    if (res.error) toast(res.error, 'danger')
    else toast('The A/B test ended', 'success')
    emitInvalidation({ type: 'review.rule.changed' })
    void load()
  }, [confirm, toast, load])

  if (!rule) return <p className={s.hint}>Save the rule first. Then “Duplicate as A/B” makes a copy B to change and test against it.</p>
  if (!pair) {
    return (
      <p className={s.hint}>
        No A/B copy of this rule yet. “Duplicate as A/B” (at the top) makes B, off: change its day or hour, then start the split here.
        It splits this rule’s orders 50 / 50 by order number.
      </p>
    )
  }
  const other = pair.a.id === rule.id ? pair.b : pair.a
  const manage = canManage ? null : "You need 'Manage reviews' to change a test."
  const startHeld = abStartHeld(pair, { canManage, unsaved, live: live && live.status !== 'DRAFT' ? live : null, sending })

  return (
    <div className={s.fields}>
      {answer?.error && !answer.data ? (
        <Banner tone="danger" title="Could not read the A/B test" action={<Button size="sm" onClick={() => void load()}>Try again</Button>}>{answer.error}</Banner>
      ) : null}
      {!answer && <Skeleton height={90} />}
      {answer && (!test || !live) && (
        <>
          <p className={s.hint}>Split 50 / 50 by order number: half of the orders “{pair.a.name}” decides are asked by A, half get B’s timing and sentiment check. Who is asked and “Skip when” stay A’s.</p>
          <SummaryTable
            label="The two sides"
            columns={['Side', 'What it does']}
            rows={[
              { id: 'a', cells: [`A · ${pair.a.name}${pair.a.id === rule.id ? ' (this)' : ''}`, sideTimingWords(pair.a)] },
              { id: 'b', cells: [`B · ${pair.b.name}${pair.b.id === rule.id ? ' (this)' : ''}`, sideTimingWords(pair.b)] },
            ]}
          />
          <div className={s.row}>
            <Button size="sm" variant="primary" onClick={() => void start()} heldReason={startHeld}>Start A/B test — send for approval</Button>
            <Button asChild size="sm"><Link href={rulePath(other.id)}>Open {other.id === pair.b.id ? 'B' : 'A'}</Link></Button>
          </div>
          <p className={s.hint}>It changes when real buyers are asked, so a person approves it first.</p>
        </>
      )}
      {test && <AbTestBody test={test} ruleId={rule.id} bOn={test.status === 'RUNNING' && pair.b.isActive} other={other} otherSide={other.id === pair.b.id ? 'B' : 'A'} manage={manage} onEnd={end} onStart={() => void start()} sending={sending} />}
      {confirm.element}
    </div>
  )
}

function AbTestBody({ test, ruleId, bOn, other, otherSide, manage, onEnd, onStart, sending }: {
  test: TimingTest
  ruleId: string
  bOn: boolean
  other: AbRule
  otherSide: 'A' | 'B'
  manage: string | null
  onEnd: (t: TimingTest) => void
  onStart: () => void
  sending: boolean
}) {
  const pill = statusPill(test)
  const ended = test.status === 'DONE' || test.status === 'STOPPED'
  return (
    <div className={s.when}>
      <p className={s.whenLine}>
        <Pill tone={pill.tone} dot>{ended ? `Last test: ${pill.label.toLowerCase()}` : pill.label}</Pill>
      </p>
      {test.status === 'DRAFT' && test.lastWords ? <Banner tone="warning" title="Not started">{test.lastWords}</Banner> : null}
      {test.status === 'WAITING_APPROVAL' && <p className={s.hint}>A person approves the start on the Approvals page. Nothing changes before.</p>}
      {bOn ? <Banner tone="warning" title="B is on">While B is on it also decides orders by itself, so the split is not clean. Turn B off.</Banner> : null}
      {(test.status === 'RUNNING' || ended) && (
        <>
          <SummaryTable label="A/B results" columns={['Side', 'Sent', 'Counted', 'Rate']} align={[undefined, 'right', 'right', 'right']} rows={abRows(test, ruleId)} />
          <div>
            <p className={s.whenLine}>{test.result.words}</p>
            {test.result.sure != null ? <ProgressBar value={test.result.sure} ariaLabel={`How sure: ${test.result.sure}%`} height={6} /> : null}
          </div>
          <p className={s.hint}>
            {[test.result.words.includes('more orders') ? null : needMoreWords(test), test.endsWords + '.', test.result.sureWords, test.countedWords].filter(Boolean).join(' ')}
          </p>
        </>
      )}
      <div className={s.row}>
        {test.status === 'DRAFT' && <Button size="sm" variant="primary" onClick={onStart} heldReason={manage ?? (sending ? 'Sending…' : test.held.start)}>Send for approval again</Button>}
        {test.status === 'WAITING_APPROVAL' && <Button asChild size="sm"><Link href={APPROVALS_PATH}>Open Approvals</Link></Button>}
        <Button asChild size="sm"><Link href={rulePath(other.id)}>Open {otherSide}</Link></Button>
        {!ended && <Button size="sm" variant="danger-outline" onClick={() => onEnd(test)} heldReason={manage ?? test.held.stop}>End test…</Button>}
      </div>
    </div>
  )
}
