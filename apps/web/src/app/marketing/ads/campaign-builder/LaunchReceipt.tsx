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
 * Built from design-system primitives (Banner / Pill / Button) on the shared token layer.
 */
import { useState } from 'react'
import { AlertTriangle, ChevronDown, ChevronRight, RefreshCw } from 'lucide-react'
import { Banner } from '@/design-system/components/Banner'
import { Button } from '@/design-system/primitives/Button'
import { Pill } from '@/design-system/primitives/Pill'
import type { Tone } from '@/design-system/primitives/tone'

export type LaunchVerdict = 'VERIFIED' | 'MISMATCH' | 'MISSING_ON_AMAZON' | 'NOT_PUSHED'

export interface LaunchEntityResult {
  entityType: 'CAMPAIGN' | 'AD_GROUP' | 'KEYWORD' | 'TARGET' | 'PRODUCT_AD'
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
}

export function LaunchReceipt({ v, onRecheck, onContinue, rechecking }: {
  v: LaunchVerification
  onRecheck?: () => void
  onContinue?: () => void
  rechecking?: boolean
}) {
  const [open, setOpen] = useState(true)
  const failed = v.entities.filter((e) => e.verdict !== 'VERIFIED')

  // A read that failed means we do not KNOW the launch is wrong — only that we cannot say it is
  // right. Saying "3 problems" when the truth is "we could not check" would be a lie in the
  // direction that loses trust fastest.
  const unknown = v.errors.length > 0 && failed.length === 0

  return (
    <div className="h10-vt-receipt">
      <Banner
        tone={unknown ? 'warning' : 'danger'}
        icon={<AlertTriangle size={16} />}
        title={unknown
          ? 'Launch created — but Amazon could not be read back'
          : `Launch created, but ${failed.length} of ${v.total} ${failed.length === 1 ? 'item does' : 'items do'} not match what was requested`}
        action={
          <div className="h10-vt-receipt-actions">
            {onRecheck && (
              <Button size="sm" variant="secondary" onClick={onRecheck} disabled={rechecking}>
                <RefreshCw size={13} className={rechecking ? 'h10-spin' : undefined} /> Re-check
              </Button>
            )}
            {onContinue && <Button size="sm" variant="ghost" onClick={onContinue}>Continue anyway</Button>}
          </div>
        }
      >
        {unknown
          ? <>The campaigns exist locally and were sent to Amazon, but the verification read failed, so their live state is unconfirmed. Re-check in a moment — this is usually a transient rate limit.</>
          : <>The campaigns were created. These specific items are not in the state you asked for on Amazon, so fix them before relying on this launch.</>}
      </Banner>

      {v.errors.length > 0 && (
        <ul className="h10-vt-receipt-errors">
          {v.errors.map((e, i) => <li key={i}>{e}</li>)}
        </ul>
      )}

      {failed.length > 0 && (
        <div className="h10-vt-receipt-body">
          <button type="button" className="h10-vt-receipt-toggle" onClick={() => setOpen((o) => !o)}>
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            {open ? 'Hide' : 'Show'} details
            <span className="h10-vt-receipt-counts">
              {v.verified > 0 && <Pill tone="success">{v.verified} verified</Pill>}
              {v.mismatch > 0 && <Pill tone="warning">{v.mismatch} differ</Pill>}
              {v.missingOnAmazon > 0 && <Pill tone="danger">{v.missingOnAmazon} missing</Pill>}
              {v.notPushed > 0 && <Pill tone="danger">{v.notPushed} not sent</Pill>}
            </span>
          </button>

          {open && (
            <div className="h10-vt-receipt-table-wrap">
              <table className="h10-vt-receipt-table">
                <thead>
                  <tr><th>Type</th><th>Item</th><th>Status</th><th>What differs</th></tr>
                </thead>
                <tbody>
                  {failed.map((e) => (
                    <tr key={`${e.entityType}-${e.localId}`}>
                      <td className="h10-vt-t">{TYPE_LABEL[e.entityType]}</td>
                      <td className="h10-vt-l" title={e.label}>{e.label}</td>
                      <td><Pill tone={VERDICT_TONE[e.verdict]}>{VERDICT_LABEL[e.verdict]}</Pill></td>
                      <td className="h10-vt-d">
                        {e.verdict === 'NOT_PUSHED' && <span className="h10-vt-muted">Never reached Amazon — needs pushing</span>}
                        {e.verdict === 'MISSING_ON_AMAZON' && <span className="h10-vt-muted">Amazon does not return this id — will not self-heal</span>}
                        {e.verdict === 'MISMATCH' && e.deltas.map((d) => (
                          <span key={d.field} className="h10-vt-delta">
                            <b>{d.field}</b>
                            <span className="h10-vt-want">{d.intended}</span>
                            <span className="h10-vt-arrow">→</span>
                            <span className="h10-vt-got">{d.observed ?? 'empty'}</span>
                          </span>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
