'use client'

/**
 * AX-VT.4 — the launch receipt.
 *
 * Every builder used to end the same way: create the campaigns, then navigate straight to the
 * campaign list. That is how an operator launched 11 campaigns into a portfolio Amazon put none
 * of them in and saw nothing but success — the only check anybody had written was "did we get an
 * id back", and nothing ever compared the result to the request.
 *
 * So this component is deliberately asymmetric, and only renders when there is something to say:
 *
 *   ok  → the builder navigates away exactly as before. A verified launch needs no ceremony, and
 *         adding a click to dismiss "it worked" is how confirmation screens get ignored.
 *   !ok → the builder STOPS here and shows what Amazon actually reports, per entity. The operator
 *         leaves knowing, instead of finding out days later in Amazon's console.
 *
 * W2-A (CC-2, CC-16, CC-17) — one receipt on every create screen (SP Super Wizard, Quick, Guided, Single, AI Goal and its
 * dashboard launch). It shows two things: what the launch made, campaign by campaign (`launch`: live / partly made with
 * what failed and why / not made and why), and Amazon's read-back of it (`v`: auto groups, negatives and placements
 * included). A read-back that could not run is said, never taken as a pass.
 *
 * Built from design-system primitives (Banner / Pill / Button) on the shared token layer.
 */
import { useState } from 'react'
import { AlertTriangle, ChevronDown, ChevronRight, RefreshCw } from 'lucide-react'
import { Banner } from '@/design-system/components/Banner'
import { DataGrid } from '@/design-system/grid/datagrid'
import { Button } from '@/design-system/primitives/Button'
import { Pill } from '@/design-system/primitives/Pill'
import type { Tone } from '@/design-system/primitives/tone'
import { STATUS_LABEL, STEP_LABEL, launchHeadline, madeSummary, type LaunchCampaignResult, type LaunchCampaignStatus, type LaunchResult } from './launch-receipt-model'
import type { useLaunchReceipt } from './useLaunchReceipt'

export type LaunchVerdict = 'VERIFIED' | 'MISMATCH' | 'MISSING_ON_AMAZON' | 'NOT_PUSHED'

export interface LaunchEntityResult {
  entityType: 'CAMPAIGN' | 'AD_GROUP' | 'KEYWORD' | 'TARGET' | 'PRODUCT_AD' | 'NEGATIVE_KEYWORD' | 'NEGATIVE_TARGET' | 'PLACEMENT'
  localId: string
  externalId: string | null
  label: string
  verdict: LaunchVerdict
  deltas: Array<{ field: string; intended: string | null; observed: string | null }>
}

export interface LaunchVerification {
  ok: boolean
  total: number
  verified: number
  mismatch: number
  missingOnAmazon: number
  notPushed: number
  entities: LaunchEntityResult[]
  problems: string[]
  errors: string[]
}

/** Every non-verified state is a problem, but they are not equally alarming. */
const VERDICT_TONE: Record<LaunchVerdict, Tone> = {
  VERIFIED: 'success',
  MISMATCH: 'warning',
  MISSING_ON_AMAZON: 'danger',
  NOT_PUSHED: 'danger',
}

const VERDICT_LABEL: Record<LaunchVerdict, string> = {
  VERIFIED: 'Verified',
  MISMATCH: 'Differs',
  MISSING_ON_AMAZON: 'Missing',
  NOT_PUSHED: 'Not sent',
}

const TYPE_LABEL: Record<LaunchEntityResult['entityType'], string> = {
  CAMPAIGN: 'Campaign', AD_GROUP: 'Ad group', KEYWORD: 'Keyword',
  TARGET: 'Target', PRODUCT_AD: 'Product ad',
  NEGATIVE_KEYWORD: 'Negative keyword', NEGATIVE_TARGET: 'Negative product', PLACEMENT: 'Placements',
}

const STATUS_TONE: Record<LaunchCampaignStatus, Tone> = { live: 'success', partial: 'warning', failed: 'danger' }

export function LaunchReceipt({ v, launch, onRecheck, onContinue, rechecking, recheckError, continueLabel = 'Continue anyway' }: {
  /** Amazon's read-back of the launch; null when it could not run (never a pass). */
  v?: LaunchVerification | null
  /** W2-A — what the launch made, campaign by campaign. */
  launch?: LaunchResult | null
  onRecheck?: () => void
  onContinue?: () => void
  rechecking?: boolean
  /** W2-A — why the last Re-check could not read Amazon. */
  recheckError?: string
  continueLabel?: string
}) {
  const [open, setOpen] = useState(true)
  const failed = (v?.entities ?? []).filter((e) => e.verdict !== 'VERIFIED')
  const launchShort = !!launch && !launch.ok

  // A read that failed means we do not KNOW the launch is wrong — only that we cannot say it is
  // right. Saying "3 problems" when the truth is "we could not check" would be a lie in the
  // direction that loses trust fastest.
  const unread = !v || (v.errors.length > 0 && failed.length === 0)

  const title = launchShort
    ? launchHeadline(launch)
    : unread
      ? 'Launch created — but Amazon could not be read back'
      : `Launch created, but ${failed.length} of ${v!.total} ${failed.length === 1 ? 'item does' : 'items do'} not match what was requested`

  return (
    <div className="h10-vt-receipt">
      <Banner
        tone={launchShort || !unread ? 'danger' : 'warning'}
        icon={<AlertTriangle size={16} />}
        title={title}
        action={
          <div className="h10-vt-receipt-actions">
            {onRecheck && (
              <Button size="sm" variant="secondary" onClick={onRecheck} disabled={rechecking}>
                <RefreshCw size={13} className={rechecking ? 'h10-spin' : undefined} /> Re-check
              </Button>
            )}
            {onContinue && <Button size="sm" variant="ghost" onClick={onContinue}>{continueLabel}</Button>}
          </div>
        }
      >
        {launchShort
          ? <>Not everything you asked for is on Amazon. Each campaign below says what is live there and what failed, with Amazon&apos;s or Nexus&apos;s reason. Nothing was retried for you.</>
          : unread
            ? <>The campaigns were sent to Amazon, but reading them back {v ? 'failed' : 'could not run'}, so their live state is unconfirmed. Re-check in a moment — this is usually a transient rate limit.</>
            : <>The campaigns were created. These specific items are not in the state you asked for on Amazon, so fix them before relying on this launch.</>}
      </Banner>

      {launch && launch.campaigns.length > 0 && launchShort && (
        <div className="h10-vt-receipt-body">
          <DataGrid<LaunchCampaignResult>
            className="h10-vt-receipt-grid" size="xs"
            rows={launch.campaigns}
            rowKey={(c) => `${c.campaignId ?? 'none'}-${c.name}`}
            columns={[
              { key: 'name', label: 'Campaign', width: 220, render: (c) => <span className="h10-vt-l" title={c.name}>{c.name}</span> },
              { key: 'status', label: 'On Amazon', width: 110, render: (c) => <Pill tone={STATUS_TONE[c.status]}>{STATUS_LABEL[c.status]}</Pill> },
              {
                key: 'what', label: 'What happened',
                render: (c) => (
                  <span className="h10-vt-d">
                    {c.status !== 'failed' && <span className="h10-vt-muted">Live on Amazon: {madeSummary(c.made)}</span>}
                    {c.status === 'failed' && <span>{c.reason}</span>}
                    {c.failed.map((f, i) => (
                      <span key={i} className="h10-vt-delta"><b>{STEP_LABEL[f.step]} {f.item}</b><span>{f.reason}</span></span>
                    ))}
                  </span>
                ),
              },
            ]}
          />
        </div>
      )}

      {((v && v.errors.length > 0) || recheckError) && (
        <ul className="h10-vt-receipt-errors">
          {recheckError && <li>Re-check could not read Amazon: {recheckError}</li>}
          {(v?.errors ?? []).map((e, i) => <li key={i}>{e}</li>)}
        </ul>
      )}

      {v && failed.length > 0 && (
        <div className="h10-vt-receipt-body">
          <Button variant="quiet" size="sm" block className="h10-vt-receipt-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            {open ? 'Hide' : 'Show'} what Amazon reports
            <span className="h10-vt-receipt-counts">
              {v.verified > 0 && <Pill tone="success">{v.verified} verified</Pill>}
              {v.mismatch > 0 && <Pill tone="warning">{v.mismatch} differ</Pill>}
              {v.missingOnAmazon > 0 && <Pill tone="danger">{v.missingOnAmazon} missing</Pill>}
              {v.notPushed > 0 && <Pill tone="danger">{v.notPushed} not sent</Pill>}
            </span>
          </Button>

          {open && (
            <DataGrid<LaunchEntityResult>
              className="h10-vt-receipt-grid" size="xs"
              rows={failed}
              rowKey={(e) => `${e.entityType}-${e.localId}`}
              columns={[
                { key: 'type', label: 'Type', width: 120, render: (e) => <span className="h10-vt-t">{TYPE_LABEL[e.entityType] ?? e.entityType}</span> },
                { key: 'item', label: 'Item', width: 240, render: (e) => <span className="h10-vt-l" title={e.label}>{e.label}</span> },
                { key: 'status', label: 'Status', width: 110, render: (e) => <Pill tone={VERDICT_TONE[e.verdict]}>{VERDICT_LABEL[e.verdict]}</Pill> },
                {
                  key: 'differs', label: 'What differs',
                  render: (e) => (
                    <span className="h10-vt-d">
                      {e.verdict === 'NOT_PUSHED' && <span className="h10-vt-muted">Never reached Amazon</span>}
                      {e.verdict === 'MISSING_ON_AMAZON' && <span className="h10-vt-muted">Amazon does not return this id — will not self-heal</span>}
                      {e.verdict === 'MISMATCH' && e.deltas.map((d) => (
                        <span key={d.field} className="h10-vt-delta">
                          <b>{d.field}</b>
                          <span className="h10-vt-want">{d.intended}</span>
                          <span className="h10-vt-arrow">→</span>
                          <span className="h10-vt-got">{d.observed ?? 'empty'}</span>
                        </span>
                      ))}
                    </span>
                  ),
                },
              ]}
            />
          )}
        </div>
      )}
    </div>
  )
}

/** W2-A (CC-16) — the receipt a create screen shows for a launch it is holding (`useLaunchReceipt`); nothing otherwise. */
export function HeldLaunchReceipt({ state, onContinue, continueLabel }: {
  state: ReturnType<typeof useLaunchReceipt>
  onContinue: () => void
  continueLabel?: string
}) {
  if (!state.held) return null
  return (
    <LaunchReceipt
      launch={state.held.launch}
      v={state.held.verification}
      rechecking={state.rechecking}
      recheckError={state.recheckError}
      onRecheck={state.held.ids.length ? () => void state.recheck() : undefined}
      onContinue={onContinue}
      continueLabel={continueLabel}
    />
  )
}
