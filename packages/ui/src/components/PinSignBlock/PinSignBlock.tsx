'use client'

/**
 * PinSignBlock — SignBlock's PIN variant (B-W2b-28, D22 / A2 G12): sign on a floor tablet with your PIN — incoming
 * inspection, in-line and final checks, the supervisor's approvals, training sign-off.
 *
 *   <PinSignBlock title="Firma il controllo finale" summary={<KeyValue … />}
 *                 meaning="Firmando confermi di aver controllato 32 capi su 32 e che sono conformi."
 *                 signer={{ name: operator.name, detail: 'Collaudo' }} onNotYou={backToNames}
 *                 onSign={(pin) => sign(pin)} state={state} locked={tries.locked} message={tries.message}
 *                 done={<p>Firmato alle 10:42.</p>} labels={ds.pinSignBlock} />
 *
 * - Order (`pinSignBlockModel.ts`): what is signed, what signing means, who signs (initials and name, "Not you?"),
 *   what is recorded, then the PIN pad — the sixth digit signs. Cancel last.
 * - Held: `heldReason` holds every key with the reason on screen; `locked` (too many tries) holds the keys and forgets
 *   the digits, the app's `message` says until when; `busy` holds the keys and says "Checking…".
 * - Done: the app's end state replaces the pad, announced.
 * - The app checks the PIN and records who, when, the device and the summary's fingerprint. No digit is ever shown,
 *   spoken or kept (`PinPad`).
 * - Sized by the density (the floor kit's PinPad and FloorButton; the initials as the OperatorChip draws them).
 */
import { useId, type ReactNode } from 'react'
import { Check, PenLine } from 'lucide-react'

import { mergeLabels } from '../../lib/labels'
import { FloorButton } from '../../floor/FloorButton'
import { operatorInitials } from '../../floor/OperatorChip'
import { PinPad } from '../../floor/PinPad'
import { PIN_SIGN_BLOCK_LABELS, type PinSignBlockLabels } from './PinSignBlockLabels'
import { pinSignView, type PinSignState } from './pinSignBlockModel'
import './pinSignBlock.css'

export interface PinSignSigner {
  name: string
  /** Station, role or team. */
  detail?: string
  initials?: string
}

export interface PinSignBlockProps {
  title?: ReactNode
  /** What is signed: counts, the item, the result (a KeyValue, a FloorCard). */
  summary?: ReactNode
  /** What signing means, in words, read before the PIN. */
  meaning: ReactNode
  signer: PinSignSigner
  /** The PIN, once all digits are typed. */
  onSign: (pin: string) => void
  /** "Not you?" — back to the name or badge step. */
  onNotYou?: () => void
  onCancel?: () => void
  /** Default `idle`. */
  state?: PinSignState
  /** Shown instead of the pad when `state` is `done`. */
  done?: ReactNode
  /** Holds every key, with the reason on screen. */
  heldReason?: string | null
  /** Too many wrong PINs: keys held, digits forgotten. */
  locked?: boolean
  /** The app's answer ("Wrong PIN. 2 tries left.", "Locked until 10:47."). */
  message?: ReactNode
  messageTone?: 'danger' | 'warning' | 'info' | 'success'
  /** PIN length (default 6). */
  length?: number
  autoFocus?: boolean
  labels?: Partial<PinSignBlockLabels>
  id?: string
}

export function PinSignBlock({
  title,
  summary,
  meaning,
  signer,
  onSign,
  onNotYou,
  onCancel,
  state = 'idle',
  done,
  heldReason,
  locked,
  message,
  messageTone = 'danger',
  length,
  autoFocus,
  labels,
  id,
}: PinSignBlockProps) {
  const lw = mergeLabels(PIN_SIGN_BLOCK_LABELS, labels)
  const auto = useId()
  const titleId = `${auto}-title`
  const view = pinSignView({ state, heldReason, locked })

  return (
    <section id={id} className="nds-pinsign" data-state={state} aria-labelledby={title ? titleId : undefined}>
      {title ? (
        <div id={titleId} className="nds-pinsign-title">
          {title}
        </div>
      ) : null}
      {summary ? <div className="nds-pinsign-summary">{summary}</div> : null}
      {view.showPad ? (
        <>
          <div className="nds-pinsign-meaning">
            <span className="nds-pinsign-meaning-icon" aria-hidden>
              <PenLine />
            </span>
            <div>
              <div className="nds-pinsign-meaning-title">{lw.meaningTitle}</div>
              <div className="nds-pinsign-meaning-body">{meaning}</div>
            </div>
          </div>
          <div className="nds-pinsign-signer">
            <span className="nds-pinsign-initials" aria-hidden>
              {signer.initials ?? operatorInitials(signer.name)}
            </span>
            <span className="nds-pinsign-signer-text">
              <span className="nds-pinsign-signing-as">{lw.signingAs(signer.name)}</span>
              {signer.detail ? <span className="nds-pinsign-signer-detail">{signer.detail}</span> : null}
            </span>
            {onNotYou ? (
              <FloorButton size="sm" variant="quiet" onClick={onNotYou} heldReason={state === 'busy' ? lw.busy : null}>
                {lw.notYou}
              </FloorButton>
            ) : null}
          </div>
          <p className="nds-pinsign-records">{lw.records}</p>
          {view.heldReason ? (
            <p className="nds-pinsign-message" data-tone="warning" role="status">
              {view.heldReason}
            </p>
          ) : state === 'busy' ? (
            <p className="nds-pinsign-message" data-tone="info" role="status">
              {lw.busy}
            </p>
          ) : null}
          <PinPad
            label={lw.pin}
            enteredLabel={lw.entered}
            clearLabel={lw.clear}
            backLabel={lw.back}
            onSubmit={onSign}
            locked={view.padLocked}
            busy={view.padBusy}
            message={message}
            messageTone={messageTone}
            length={length}
            autoFocus={autoFocus}
          />
          {onCancel ? (
            <div className="nds-pinsign-actions">
              <FloorButton variant="secondary" onClick={onCancel} heldReason={state === 'busy' ? lw.busy : null}>
                {lw.cancel}
              </FloorButton>
            </div>
          ) : null}
        </>
      ) : (
        <div className="nds-pinsign-done" role="status">
          <span className="nds-pinsign-done-icon" aria-hidden>
            <Check />
          </span>
          <div className="nds-pinsign-done-body">{done}</div>
        </div>
      )}
    </section>
  )
}
