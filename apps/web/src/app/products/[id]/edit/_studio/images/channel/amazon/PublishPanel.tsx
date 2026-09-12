'use client'

/**
 * PES.7 — the Amazon publish panel.
 *
 * The only surface in this tab that reaches a real marketplace. Everything it is allowed to say and
 * offer comes from `publishPlan.ts`, which is pure and tested; this file renders that decision and
 * adds no judgement of its own.
 *
 * Preflight is run on OPEN, not on tab load — it walks every ASIN's resolved plan, and most visits
 * to the images tab are not about publishing.
 *
 * 🔴 Two facts are always shown separately because they fail differently: whether DRY RUN is on
 * (the operator's choice) and whether the server's gate is open (`getAmazonPublishMode()`). An
 * operator who turned dry-run off must still be told the gate is closed.
 */
import { useCallback, useEffect, useState } from 'react'

import { Modal } from '@/design-system/components'
import { Button, Checkbox, Pill } from '@/design-system/primitives'

import { apiSend, routes, type ApiResult } from '../../api'
import { writeSubject } from '../../imageWrites'
import { buildPublishPlan } from './publishPlan'
import { usePublishGate } from './usePublishGate'
import styles from './matrix.module.css'

export interface PublishPanelProps {
  open: boolean
  productId: string
  market: string | null
  activeAxis: string | null
  onClose(): void
  onSubmitted(): Promise<void>
  write<T>(subject: string, run: () => Promise<ApiResult<T>>): Promise<ApiResult<T>>
}

interface PublishResponse { feedId?: string | null; jobId?: string | null; skus?: unknown[]; dryRun?: boolean }

export function PublishPanel({
  open, productId, market, activeAxis, onClose, onSubmitted, write,
}: PublishPanelProps) {
  const [submitting, setSubmitting] = useState(false)
  const [outcome, setOutcome] = useState<string | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const gate = usePublishGate({ productId, market, activeAxis, write })

  useEffect(() => {
    if (!open) { setOutcome(null); setRefusal(null); return }
    void gate.refresh()
    // `gate.refresh` is stable per (productId, market, activeAxis); re-running on its identity
    // would re-preflight on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, productId, market, activeAxis])

  const plan = buildPublishPlan({ readiness: gate.readiness, validation: gate.validation, dryRun: false })

  const submit = useCallback(async () => {
    if (!market) return
    setSubmitting(true)
    setRefusal(null)
    const res = await write(writeSubject.surface('amazon-publish'), () => apiSend<PublishResponse>(routes.amazonPublish(productId), 'POST', {
      marketplace: market,
      activeAxis,
      // Sent EXPLICITLY, and equal to what will actually happen. The server ignores it for the
      // submission decision, but it is what lands in the audit log, so it must not be a wish.
      dryRun: plan.rehearsalOnly,
    }))
    setSubmitting(false)
    if (!res.ok) { setRefusal(res.message); return }
    const skus = Array.isArray(res.data?.skus) ? res.data.skus.length : 0
    /*
     * 🔴 The outcome comes from the SERVER'S answer and nothing else.
     *
     * This used to read `res.data?.dryRun || dryRun || plan.rehearsalOnly`, so the REQUEST flag won
     * the OR — and the request flag is inert. `submitAmazonImageFeed` never forwards it
     * (`...(dryRun ? {} : {})` is an empty object either way, and `AmazonBatchSubmission` has no
     * such field); submission is decided solely by `getAmazonPublishMode()`. With the gate live, a
     * request asking for a dry run submits a real feed — and this panel would have reported
     * "nothing was submitted to Amazon". Exactly the lie this rebuild exists to remove.
     *
     * `undefined` is its own answer: the server did not say, so neither does this.
     */
    const serverSaysDryRun = res.data?.dryRun
    setOutcome(
      serverSaysDryRun === true
        ? `Dry run completed for ${skus} SKU${skus === 1 ? '' : 's'} — Amazon was not contacted.`
        : serverSaysDryRun === false
          // "Queued", not "published": the feed is asynchronous and Amazon has not answered yet.
          ? `Queued ${skus} SKU${skus === 1 ? '' : 's'} to Amazon${res.data?.feedId ? ` (feed ${res.data.feedId})` : ''}. Amazon has not confirmed yet — the feed status will say.`
          : `The request completed for ${skus} SKU${skus === 1 ? '' : 's'}, but the server did not say whether the feed was submitted. Check the publish record below before assuming either way.`,
    )
    await onSubmitted()
  }, [activeAxis, market, onSubmitted, plan.rehearsalOnly, productId, write])

  if (!open) return null

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title="Publish images to Amazon"
      subtitle={market ? `Amazon · ${market}` : undefined}
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
          <Button
            size="sm"
            variant="primary"
            disabled={!plan.canSubmit || submitting || gate.loading}
            onClick={() => void submit()}
          >
            {submitting ? 'Working…' : plan.actionLabel}
          </Button>
        </>
      }
    >
      {gate.error && <p className={styles.warning} role="alert">{gate.error}</p>}
      {refusal && <p className={styles.warning} role="alert">{refusal}</p>}
      {outcome && <p className={styles.notice} role="status">{outcome}</p>}

      {gate.loading && <p className={styles.pickerState}>Running preflight against every ASIN…</p>}

      {!gate.loading && (
        <>
          <div className={styles.publishRow}>
            <Pill tone={plan.rehearsalOnly ? 'warning' : 'success'}>
              {gate.readiness
                ? gate.readiness.enabled ? `server mode: ${gate.readiness.mode}` : 'publishing disabled on the server'
                : 'publish settings unknown'}
            </Pill>
            {plan.blockedAsins > 0 && <Pill tone="danger">{plan.blockedAsins} blocked</Pill>}
            {plan.warnings.length > 0 && <Pill tone="warning">{plan.warnings.length} warnings</Pill>}
          </div>

          {plan.advisory && <p className={styles.pickerState}>{plan.advisory}</p>}

          {/*
            🔴 Shown, and NOT a choice — because the endpoint cannot honour it.
            The `dryRun` body field never reaches the submission (see the note in `submit`), so a
            checkbox here would be a switch wired to nothing. What actually decides is the server's
            publish gate, which is what this now reflects. The reason is beside it rather than in a
            tooltip: a disabled control cannot explain itself.
          */}
          <label className={styles.publishRow}>
            <Checkbox checked={plan.rehearsalOnly} disabled readOnly />
            <span>
              {plan.rehearsalOnly
                ? 'Dry run — the publish gate is closed on this deployment, so the feed is built and checked but not submitted.'
                : 'Live — the publish gate is open, so pressing this submits a real feed. This endpoint has no rehearsal mode of its own.'}
            </span>
          </label>

          {plan.errors.length > 0 && (
            <section className={styles.issues}>
              <span className={styles.issuesTitle}>Blocking — these ASINs will be skipped</span>
              <ul>
                {plan.errors.slice(0, 12).map((i, n) => (
                  <li key={n}><code>{i.asin ?? i.sku}</code> {i.slot ? `· ${i.slot} ` : ''}— {i.message}</li>
                ))}
                {plan.errors.length > 12 && <li>and {plan.errors.length - 12} more</li>}
              </ul>
            </section>
          )}

          {plan.warnings.length > 0 && (
            <section className={styles.issues}>
              <span className={styles.issuesTitle}>Warnings — these do not block a submission</span>
              <ul>
                {plan.warnings.slice(0, 8).map((i, n) => (
                  <li key={n}><code>{i.asin ?? i.sku}</code> {i.slot ? `· ${i.slot} ` : ''}— {i.message}</li>
                ))}
                {plan.warnings.length > 8 && <li>and {plan.warnings.length - 8} more</li>}
              </ul>
            </section>
          )}
        </>
      )}
    </Modal>
  )
}
