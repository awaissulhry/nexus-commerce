'use client'

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Modal } from './Modal'
import { SummaryTable } from './SummaryTable'
import { AsOf } from './AsOf'
import { Button } from '../primitives/Button'
import { Input } from '../primitives/Input'
import { Checkbox } from '../primitives/Checkbox'
import { requiresTypedConfirm, reversalSentence, validateImpact, type ActionImpact } from '../grid/actions/registry'
import type { AskToConfirm } from '../grid/actions/runAction'

export interface ActionConfirmProps {
  impact: ActionImpact
  onConfirm: () => void
  onCancel: () => void
  /** Inline review keeps the same arming rules; the host owns its enclosing dialog. */
  mode?: 'modal' | 'inline'
}
/** Kept pure so direct hook users and registry users share the same safety boundary. */
export function canConfirmAction(impact: ActionImpact, typed: string, acknowledged: boolean): boolean {
  return !impact.cancelled && !impact.unavailable && !impact.refusal && validateImpact(impact).length === 0 &&
    (!requiresTypedConfirm(impact) || typed === impact.confirmPhrase) && (!impact.acknowledge || acknowledged)
}

/** Itemised consequences, exact subject typing, visible instructions and explicit acknowledgement. */
export function ActionConfirm({ impact, onConfirm, onCancel, mode = 'modal' }: ActionConfirmProps) {
  const [typed, setTyped] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const [answeredImpact, setAnsweredImpact] = useState(impact)
  if (answeredImpact !== impact) {
    // Inline hosts can replace a reviewed plan without unmounting this component.
    setAnsweredImpact(impact); setTyped(''); setAcknowledged(false)
  }
  const id = useId()
  const needsTyping = requiresTypedConfirm(impact)
  const canConfirm = canConfirmAction(impact, typed, acknowledged)
  const problems = impact.refusal?.reason ?? impact.unavailable ?? validateImpact(impact).join('; ')
  const danger = needsTyping || impact.reach === 'channel' || impact.reach === 'local-destructive' || impact.reversal?.fidelity === 'none'
  const footer = <>
    <Button variant="secondary" data-autofocus onClick={onCancel}>Cancel</Button>
    <Button variant={danger ? 'danger' : 'primary'} disabled={!canConfirm} onClick={() => { if (canConfirm) onConfirm() }}>Confirm</Button>
  </>
  const content = <>
    {impact.subject && <p className="nds-confirm-block">{impact.subject.kind}: <strong className="nds-confirm-h">{impact.subject.value}</strong></p>}
    {impact.asOf !== undefined && <p className="nds-confirm-block">Checked <AsOf at={impact.asOf} /></p>}
    {impact.consequences?.length ? <div className="nds-confirm-block">
      <div className="nds-confirm-h">What this changes</div>
      <ul className="nds-confirm-list">{impact.consequences.map((c, i) => <li key={i}>{c}</li>)}</ul>
    </div> : null}
    {impact.reversal && <p className="nds-confirm-block nds-confirm-h">{reversalSentence(impact)}</p>}
    {impact.findings?.length ? <div className="nds-confirm-block">
      <div className="nds-confirm-h">What the check found</div>
      <ul className="nds-confirm-list">{impact.findings.map((f, i) => <li key={i}
        className={f.severity === 'error' ? 'nds-confirm-error' : f.severity === 'warn' || f.severity === 'unknown' ? 'nds-confirm-warn' : undefined}>
        {f.severity === 'unknown' ? 'Not checked: ' : ''}{f.label}
        {f.asOf !== undefined && <> · <AsOf at={f.asOf} /></>}
      </li>)}</ul>
    </div> : null}
    {impact.sideEffects?.length ? <div className="nds-confirm-block nds-confirm-aside">
      <div className="nds-confirm-h">This also happens</div>
      <ul className="nds-confirm-list">{impact.sideEffects.map((s, i) => <li key={i}>{s}</li>)}</ul>
    </div> : null}
    {impact.review && <div className="nds-confirm-block"><SummaryTable label={impact.review.title}
      columns={['Item', 'Before', 'After']} rows={impact.review.rows.map((r, i) => ({ id: String(i), cells: [r.label, r.before, r.after] }))} /></div>}
    {impact.handoffs?.length ? <div className="nds-confirm-block">
      <div className="nds-confirm-h">Continue elsewhere</div>
      <ul className="nds-confirm-list">{impact.handoffs.map((h, i) => <li key={i}>
        {h.href && /^(https?:\/\/|\/(?!\/))/.test(h.href) ? <a href={h.href}>{h.label}</a> : h.label}: {h.reason}
      </li>)}</ul>
    </div> : null}
    {problems && <p className="nds-inline-error" role="alert">{problems}{impact.refusal?.whatWouldFix ? ` ${impact.refusal.whatWouldFix}` : ''}</p>}
    {needsTyping && <div className="nds-confirm-block">
      <label htmlFor={id}>Type <strong className="nds-confirm-h">{impact.confirmPhrase}</strong> exactly to confirm</label>
      <Input id={id} value={typed} onChange={e => setTyped(e.target.value)} autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} />
    </div>}
    {impact.acknowledge && <div className="nds-confirm-block"><Checkbox tone="warning" checked={acknowledged}
      onChange={e => setAcknowledged(e.target.checked)} label={impact.acknowledge} /></div>}
  </>
  if (mode === 'inline') return <section className="nds-confirm" aria-label={impact.title}>
    <div className="nds-confirm-h">{impact.title}</div>{content}<div className="nds-confirm-actions">{footer}</div>
  </section>
  return <Modal open onClose={onCancel} title={impact.title} size="md" footer={footer}>{content}</Modal>
}

interface Pending { impact: ActionImpact; resolve: (ok: boolean) => void; id: number }
export interface ActionConfirmApi { ask: AskToConfirm; element: ReactNode }
export function useActionConfirm(): ActionConfirmApi {
  const [pending, setPending] = useState<Pending | null>(null)
  const pendingRef = useRef<Pending | null>(null)
  const nextId = useRef(0)
  const ask = useCallback<AskToConfirm>(impact => new Promise<boolean>(resolve => {
    pendingRef.current?.resolve(false)
    const next = { impact, resolve, id: ++nextId.current }
    pendingRef.current = next
    setPending(next)
  }), [])
  const settle = useCallback((ok: boolean) => {
    const p = pendingRef.current
    pendingRef.current = null
    setPending(null)
    p?.resolve(ok)
  }, [])
  useEffect(() => () => { pendingRef.current?.resolve(false); pendingRef.current = null }, [])
  return { ask, element: pending ? <ActionConfirm key={pending.id} impact={pending.impact} onCancel={() => settle(false)} onConfirm={() => settle(true)} /> : null }
}
