'use client'

/**
 * Reviews › Requests › Rules — "Test run": which orders a rule would ask today (`POST /api/review-rules/:id/dry-run`).
 * Nothing is sent and nothing is written. A rule that is off still shows, but never sends. "Queue these N…" asks first,
 * then adds the orders to the queue (`POST /api/review-rules/:id/run`): they go at the next run of the sender.
 * Several ticked rules show one after another.
 */
import { useCallback, useEffect, useState } from 'react'
import { Banner, Modal, SummaryTable, useActionConfirm, useToast } from '@/design-system/components'
import { Button, Skeleton } from '@/design-system/primitives'
import { emitInvalidation } from '@/lib/sync/invalidation-channel'
import { reviewsSend } from '../../../_lib/reviewsFetch'
import { channelMarketWords } from '../../../_lib/reviewWords'
import s from './rules.module.css'

export interface DryRunSample {
  orderId: string
  channelOrderId: string
  channel: string
  marketplace: string | null
  deliveredAt: string | null
  scheduledFor: string | null
}

export interface DryRun {
  rule: { id: string; name: string }
  matchCount: number
  sample: DryRunSample[]
}

/** One rule's test run (nothing is sent). */
export function readDryRun(id: string) {
  return reviewsSend<DryRun>('POST', `/review-rules/${encodeURIComponent(id)}/dry-run`)
}

/** "Thu 29 Oct 10:00" in the viewer's clock. */
export function firstTryWhen(iso: string | null): string {
  if (!iso) return 'No delivery date yet'
  const d = new Date(iso)
  return `${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })}`
}

const SAMPLE_ROWS = 5
const MANAGE_QUEUE = "You need 'Manage reviews' to queue review requests."

export interface TestRunModalProps {
  rules: readonly { id: string; name: string; isActive: boolean }[]
  onClose: () => void
  canManage: boolean
}

interface Result { id: string; data: DryRun | null; error: string | null }

export function TestRunModal({ rules, onClose, canManage }: TestRunModalProps) {
  const { toast } = useToast()
  const confirm = useActionConfirm()
  const [results, setResults] = useState<Record<string, Result>>({})
  const [busy, setBusy] = useState<string | null>(null)

  const run = useCallback(async (id: string) => {
    setResults((r) => ({ ...r, [id]: { id, data: null, error: null } }))
    const res = await readDryRun(id)
    setResults((r) => ({ ...r, [id]: { id, data: res.data, error: res.error } }))
  }, [])
  // Once per set of rules (the parent may hand a new array with the same rules).
  const idsKey = rules.map((r) => r.id).join('|')
  useEffect(() => {
    for (const id of idsKey.split('|')) if (id) void run(id)
  }, [idsKey, run])

  const queue = useCallback(async (rule: { id: string; name: string; isActive: boolean }, matches: number) => {
    const ok = await confirm.ask({
      level: 'confirm',
      title: `Queue ${matches} ${matches === 1 ? 'order' : 'orders'} for “${rule.name}”?`,
      confirmLabel: `Queue ${matches}`,
      consequences: [
        `Adds ${matches} ${matches === 1 ? 'order' : 'orders'} to the queue as due now`,
        'They go out at the next run of the sender (every hour), unless sending is paused',
        'Orders that already have a request are left out (one request per order)',
      ],
      sideEffects: rule.isActive ? [] : ['The rule is off: queued requests still go out'],
    })
    if (!ok) return
    setBusy(rule.id)
    const res = await reviewsSend<{ enqueued: number; skipped: number }>('POST', `/review-rules/${encodeURIComponent(rule.id)}/run`, undefined, { idempotent: true, what: 'queue' })
    setBusy(null)
    if (res.error || !res.data) return toast(res.error ?? 'Nexus could not queue them.', 'danger')
    toast(`${res.data.enqueued} added to the queue · ${res.data.skipped} already had a request`, 'success')
    emitInvalidation({ type: 'review.request.updated', meta: { count: res.data.enqueued } })
    void run(rule.id)
  }, [confirm, toast, run])

  const title = rules.length === 1 ? `Test run — ${rules[0].name}` : `Test run — ${rules.length} rules`

  return (
    <>
      <Modal open onClose={onClose} size="lg" title={title} subtitle="Which orders each rule would ask today. Nothing is sent." footer={<Button onClick={onClose}>Close</Button>}>
        <div className={s.testRuns}>
          {rules.map((rule) => {
            const result = results[rule.id]
            const data = result?.data ?? null
            const shown = data?.sample.slice(0, SAMPLE_ROWS) ?? []
            return (
              <section key={rule.id} className={s.testRun} aria-label={`Test run of ${rule.name}`}>
                {rules.length > 1 && <h3 className={s.sectionHead}>{rule.name}{rule.isActive ? '' : ' (off)'}</h3>}
                {result?.error ? (
                  <Banner tone="danger" title="The test run failed" action={<Button size="sm" onClick={() => void run(rule.id)}>Try again</Button>}>{result.error}</Banner>
                ) : !data ? (
                  <Skeleton height={120} />
                ) : (
                  <>
                    <p className={s.bigNumber}>
                      <strong>{data.matchCount.toLocaleString('en-IE')}</strong> {data.matchCount === 1 ? 'order matches' : 'orders match'} this rule today
                    </p>
                    {shown.length > 0 && (
                      <SummaryTable
                        label="Sample orders"
                        columns={['Order', 'Channel', 'First try']}
                        rows={shown.map((o) => ({ id: o.orderId, cells: [o.channelOrderId, channelMarketWords(o.channel, o.marketplace), firstTryWhen(o.scheduledFor)] }))}
                      />
                    )}
                    <p className={s.muted}>
                      {data.matchCount > shown.length ? `Showing ${shown.length} of ${data.matchCount}. ` : ''}
                      Times are the buyer’s local time. Orders that already have a request, or that the rule skips, do not count.
                      {rule.isActive ? '' : ' This rule is off: it never sends on its own.'}
                    </p>
                    {data.matchCount > 0 && (
                      <div>
                        <Button size="sm" variant="primary" onClick={() => void queue(rule, data.matchCount)} heldReason={!canManage ? MANAGE_QUEUE : busy === rule.id ? 'Queueing…' : null}>
                          Queue these {data.matchCount}…
                        </Button>
                      </div>
                    )}
                  </>
                )}
              </section>
            )
          })}
        </div>
      </Modal>
      {confirm.element}
    </>
  )
}
