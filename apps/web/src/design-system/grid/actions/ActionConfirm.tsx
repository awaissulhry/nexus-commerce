'use client'

/**
 * GDS — the ONE way a grid verb asks.
 *
 * `runAction` owns the sequence and hands the surface an `ActionImpact` to render. This is that
 * rendering, in the design system rather than per lane, for the same reason `runAction` is: a
 * confirmation is a safety control, and two copies of one drift until the dangerous verb is the
 * one asking the gentler question.
 *
 * Four things it will not do, each of which a hand-rolled dialog gets wrong:
 *
 * 1. **Consequences are itemised, never counted.** "5 listings" tells an operator less than naming
 *    the five marketplaces — the count is the thing they already knew.
 * 2. **Side effects are separated from consequences.** A consequence is what you asked for; a side
 *    effect is what the endpoint also does (reparent demotes an emptied parent, unlink leaves a
 *    childless one behind). Mixing them lets the unasked-for one read as intended.
 * 3. **`type-to-confirm` means the phrase must MATCH.** The confirm button stays disabled until it
 *    does, and the phrase is the real SKU — never the word "DELETE", which trains an operator to
 *    type five letters without reading anything.
 *
 *    🔴 And the button never carries the INSTRUCTION. It used to read "Type the name to confirm"
 *    while disabled, which measured **2.60:1** — the 0.5 disabled opacity blends white text and the
 *    danger fill toward the modal surface (7.53:1 enabled). WCAG 1.4.3 exempts inactive controls,
 *    and that exemption is normally right; it is void here, because that label was the only
 *    instruction on screen. It rendered at 2.6:1 exactly while the operator needed to read it and
 *    brightened to 7.5:1 once they no longer did — the affordance inverted. The instruction now
 *    lives beside the input, where it is body text at full contrast, and the button just says
 *    "Confirm". (PES.4 measured it in the GDS lab; hub ruling #133.)
 * 4. **The dialog never decides severity.** It renders what the preflight found. A surface that
 *    could soften a level would be the one place the safety check does not hold.
 */

import { useCallback, useRef, useState } from 'react'

import { Modal } from '../../components/Modal'
import { Button } from '../../primitives/Button'
import { Input } from '../../primitives/Input'

import { requiresTypedConfirm, type ActionImpact } from './registry'
import type { AskToConfirm } from './runAction'

interface Pending {
  impact: ActionImpact
  resolve: (ok: boolean) => void
}

export interface ActionConfirmApi {
  /** Pass to `runAction`. Resolves true only when the operator confirmed. */
  ask: AskToConfirm
  /** Mount this once, anywhere inside the surface. */
  element: React.ReactNode
}

export function useActionConfirm(): ActionConfirmApi {
  const [pending, setPending] = useState<Pending | null>(null)
  const [typed, setTyped] = useState('')
  const pendingRef = useRef<Pending | null>(null)

  const ask = useCallback<AskToConfirm>((impact) => {
    return new Promise<boolean>((resolve) => {
      const next = { impact, resolve }
      pendingRef.current = next
      setTyped('')
      setPending(next)
    })
  }, [])

  const settle = useCallback((ok: boolean) => {
    const p = pendingRef.current
    pendingRef.current = null
    setPending(null)
    setTyped('')
    // Closing without answering is a NO. A dialog that resolved nothing would leave `runAction`
    // awaiting forever and the verb stuck mid-flight with no way for the operator to tell.
    p?.resolve(ok)
  }, [])

  const impact = pending?.impact
  const needsTyping = impact ? requiresTypedConfirm(impact) : false
  const canConfirm = !needsTyping || typed.trim() === impact?.confirmPhrase?.trim()

  const element = impact ? (
    <Modal
      open
      onClose={() => settle(false)}
      title={impact.title}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={() => settle(false)}>Cancel</Button>
          {/* Rule 3: the button never instructs. See the header — a disabled control's contrast
              exemption is void when that control carries the only instruction on screen. */}
          <Button variant={needsTyping ? 'danger' : 'primary'} disabled={!canConfirm} onClick={() => settle(true)}>
            Confirm
          </Button>
        </>
      }
    >
      {impact.consequences && impact.consequences.length > 0 && (
        <div className="nds-grid-confirm-block">
          <div className="nds-cell-strong">What this changes</div>
          {/* Rule 1: itemised. */}
          <ul className="nds-grid-confirm-list">
            {impact.consequences.map((c, i) => <li key={i}>{c}</li>)}
          </ul>
        </div>
      )}

      {impact.findings && impact.findings.length > 0 && (
        <div className="nds-grid-confirm-block">
          <div className="nds-cell-strong">What the check found</div>
          <ul className="nds-grid-confirm-list">
            {impact.findings.map((f, i) => (
              <li key={i} className={f.severity === 'error' ? 'nds-grid-confirm-error' : f.severity === 'warn' ? 'nds-grid-confirm-warn' : undefined}>
                {f.label}
              </li>
            ))}
          </ul>
        </div>
      )}

      {impact.sideEffects && impact.sideEffects.length > 0 && (
        // Rule 2: kept apart from the consequences, because these are the things the operator did
        // NOT ask for and would otherwise read as part of what they chose.
        <div className="nds-grid-confirm-block nds-grid-confirm-aside">
          <div className="nds-cell-strong">This also happens</div>
          <ul className="nds-grid-confirm-list">
            {impact.sideEffects.map((s, i) => <li key={i}>{s}</li>)}
          </ul>
        </div>
      )}

      {needsTyping && (
        <div className="nds-grid-confirm-block">
          {/* Rule 3: the real name, so typing it requires reading it. */}
          {/* NOT muted. This is now the only instruction in the dialog, and dimming the one line
              that tells the operator how to proceed is the same mistake as burying it on a disabled
              button — one step less obvious. */}
          <label htmlFor="nds-grid-confirm-phrase">
            Type <span className="nds-cell-strong">{impact.confirmPhrase}</span> to confirm
          </label>
          <Input
            id="nds-grid-confirm-phrase"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoFocus
            autoComplete="off"
            spellCheck={false}
          />
        </div>
      )}
    </Modal>
  ) : null

  return { ask, element }
}
