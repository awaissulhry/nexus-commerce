'use client'

/**
 * SignBlock — read, then accept by typing your name (gap G12): the quote-accept and PO-confirm links (SCR-099, SCR-100),
 * the worker notice (SCR-025), an inspection report's sign-off (SCR-076).
 *
 *   <SignBlock
 *     title="Accetta il preventivo Q-2026-0042"
 *     summary={<SummaryTable … />}
 *     legal={<p>Scrivendo il tuo nome accetti il preventivo e le condizioni di vendita …</p>}
 *     acknowledgements={[{ id: 'mtm', label: 'Ho letto: i capi su misura non si possono restituire.' }]}
 *     nameLabel="Nome e cognome" expectedName="Maria Rossi" nameEmptyLabel="Scrivi nome e cognome"
 *     nameMismatchLabel="Il nome non è quello del preventivo"
 *     email={{ label: 'Email', expected: link.email, emptyLabel: 'Scrivi la tua email', invalidLabel: '…', mismatchLabel: '…' }}
 *     acceptLabel="Accetto" onAccept={(s) => accept(s)} state={state} busyLabel="Invio…" done={<p>Accettato …</p>}
 *   />
 *
 * - **Order on the page**: what is being accepted (`summary`), what accepting means (`legal`), the ticks, the typed name,
 *   the email, then the actions — Decline before Accept, Accept last.
 * - **Checks** (`signBlockModel.ts`): the name loosely against `expectedName` (case, accents, punctuation, order and a
 *   middle name do not matter); the email well-formed and, with `email.expected`, the same address; every
 *   acknowledgement ticked. Nothing is shown while a person types: a field says what is wrong after they leave it, or
 *   when Accept is pressed — then focus goes to the first problem. Accept is never silently disabled.
 * - **States**: `busy` holds Accept (its words become `busyLabel`) and makes the fields read-only; `done` replaces the
 *   form with the app's end state (`done`: "Accepted — we sent a copy to …"), announced; `heldReason` holds the whole
 *   block (a link already used or expired), read-only, and says why on screen. A server's answer goes in `message`.
 * - **Evidence is the app's**: `onAccept` hands over the typed name, the email and the ticks; the app records the
 *   time, the address and the document's fingerprint.
 * - **Density**: fields, ticks and buttons read `--nds-density-*`, so on a link page's comfortable tier the fields are
 *   44 px with 16 px text (no phone zooms into them) and the buttons 48 px; at standard they keep the console's sizes.
 * - Every word comes from the app.
 */
import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Check, PenLine } from 'lucide-react'

import { FloorButton } from '../../floor/FloorButton'
import { Checkbox } from '../../primitives/Checkbox'
import { Input } from '../../primitives/Input'
import { Field } from '../Field'
import { signCanAccept, signProblems, type SignProblems } from './signBlockModel'
import './signBlock.css'

export interface SignAcknowledgement {
  id: string
  /** What the person confirms they read ("I have read: made-to-measure garments cannot be returned."). */
  label: ReactNode
}

export interface SignEmailCheck {
  /** "Email". */
  label: string
  hint?: ReactNode
  /** The address the link was sent to. Without it any well-formed address passes. */
  expected?: string
  /** "Scrivi la tua email". */
  emptyLabel: string
  /** "Non sembra un indirizzo email". */
  invalidLabel: string
  /** "Non è l'indirizzo a cui abbiamo scritto" — needed with `expected`. */
  mismatchLabel?: string
}

/** What the person typed and ticked, handed to `onAccept`. */
export interface SignAcceptance {
  name: string
  email?: string
  acknowledged: string[]
}

export type SignBlockState = 'idle' | 'busy' | 'done'

export interface SignBlockProps {
  /** The block's heading ("Accetta il preventivo Q-2026-0042"). */
  title?: ReactNode
  /** What is being accepted: totals, dates, lines (a `SummaryTable`, a `KeyValue`). */
  summary?: ReactNode
  /** What accepting means, in the app's legal words. Read before the name is typed. */
  legal?: ReactNode
  /** Ticks that must be set before Accept runs. */
  acknowledgements?: readonly SignAcknowledgement[]
  /** "Spunta per continuare" — under a tick left empty. */
  acknowledgementMissingLabel?: string
  /** "Nome e cognome". */
  nameLabel: string
  nameHint?: ReactNode
  /** The name the document is for; matched loosely. */
  expectedName?: string
  /** "Scrivi nome e cognome". */
  nameEmptyLabel: string
  /** "Il nome non è quello del preventivo" — needed with `expectedName`. */
  nameMismatchLabel?: string
  /** Ask for an email too. */
  email?: SignEmailCheck
  /** "Accetto" / "Confermo l'ordine". */
  acceptLabel: string
  onAccept: (acceptance: SignAcceptance) => void
  /** "Rifiuta" — with `onDecline`. */
  declineLabel?: string
  onDecline?: () => void
  /** Default `idle`. */
  state?: SignBlockState
  /** Why Accept is held while busy ("Invio in corso"). */
  busyLabel?: string
  /** The end state, shown in place of the form when `state` is `done`. */
  done?: ReactNode
  /** Holds the whole block (the link was used, the quote expired): Accept is held with this reason. */
  heldReason?: string | null
  /** The server's answer or a problem outside the fields. */
  message?: ReactNode
  messageTone?: 'danger' | 'warning' | 'info' | 'success'
  id?: string
}

export function SignBlock({
  title,
  summary,
  legal,
  acknowledgements = [],
  acknowledgementMissingLabel,
  nameLabel,
  nameHint,
  expectedName,
  nameEmptyLabel,
  nameMismatchLabel,
  email,
  acceptLabel,
  onAccept,
  declineLabel,
  onDecline,
  state = 'idle',
  busyLabel,
  done,
  heldReason,
  message,
  messageTone = 'danger',
  id,
}: SignBlockProps) {
  const auto = useId()
  const titleId = `${auto}-title`
  const [name, setName] = useState('')
  const [mail, setMail] = useState('')
  const [ticked, setTicked] = useState<string[]>([])
  const [touched, setTouched] = useState<{ name?: boolean; email?: boolean }>({})
  const [tried, setTried] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)
  const emailRef = useRef<HTMLInputElement>(null)
  const ackRefs = useRef(new Map<string, HTMLInputElement>())

  const busy = state === 'busy'
  const readOnly = busy || !!heldReason
  const problems: SignProblems = signProblems(
    { name, email: mail, acknowledged: ticked },
    { expectedName, askEmail: !!email, expectedEmail: email?.expected, acknowledgements: acknowledgements.map((a) => a.id) },
  )
  const showName = tried || touched.name
  const showEmail = tried || touched.email
  const nameError = showName && problems.name ? (problems.name === 'empty' ? nameEmptyLabel : (nameMismatchLabel ?? nameEmptyLabel)) : undefined
  const emailError =
    email && showEmail && problems.email
      ? problems.email === 'empty'
        ? email.emptyLabel
        : problems.email === 'invalid'
          ? email.invalidLabel
          : (email.mismatchLabel ?? email.invalidLabel)
      : undefined
  const held = heldReason || (busy ? (busyLabel ?? acceptLabel) : null)

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (held) return
    setTried(true)
    if (!signCanAccept(problems)) {
      const firstAck = problems.acknowledgements[0]
      const target = firstAck != null ? ackRefs.current.get(firstAck) : problems.name ? nameRef.current : emailRef.current
      target?.focus()
      return
    }
    onAccept({ name: name.trim(), ...(email ? { email: mail.trim() } : {}), acknowledged: ticked })
  }

  return (
    <section id={id} className="nds-sign" data-state={state} aria-labelledby={title ? titleId : undefined}>
      {title ? (
        <div id={titleId} className="nds-sign-title">
          {title}
        </div>
      ) : null}
      {summary ? <div className="nds-sign-summary">{summary}</div> : null}
      {state === 'done' ? (
        <div className="nds-sign-done" role="status">
          <span className="nds-sign-done-icon" aria-hidden>
            <Check />
          </span>
          <div className="nds-sign-done-body">{done}</div>
        </div>
      ) : (
        <form className="nds-sign-form" noValidate onSubmit={submit} aria-busy={busy || undefined}>
          {legal ? <div className="nds-sign-legal">{legal}</div> : null}
          {acknowledgements.length ? (
            <div className="nds-sign-acks">
              {acknowledgements.map((a) => {
                const missing = tried && problems.acknowledgements.includes(a.id)
                const errorId = `${auto}-ack-${a.id}`
                return (
                  <div key={a.id} className="nds-sign-ack" data-invalid={missing ? 'true' : undefined}>
                    <Checkbox
                      ref={(el) => {
                        if (el) ackRefs.current.set(a.id, el)
                        else ackRefs.current.delete(a.id)
                      }}
                      label={a.label}
                      checked={ticked.includes(a.id)}
                      onChange={(e) => {
                        if (readOnly) return
                        const on = e.currentTarget.checked
                        setTicked((t) => (on ? [...t.filter((x) => x !== a.id), a.id] : t.filter((x) => x !== a.id)))
                      }}
                      aria-invalid={missing || undefined}
                      aria-describedby={missing && acknowledgementMissingLabel ? errorId : undefined}
                    />
                    {missing && acknowledgementMissingLabel ? (
                      <span id={errorId} className="nds-sign-error">
                        {acknowledgementMissingLabel}
                      </span>
                    ) : null}
                  </div>
                )
              })}
            </div>
          ) : null}
          <Field label={nameLabel} hint={nameHint} error={nameError} required>
            <Input
              ref={nameRef}
              fieldClassName="nds-sign-input"
              value={name}
              readOnly={readOnly}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => name.trim() && setTouched((t) => ({ ...t, name: true }))}
              autoComplete="name"
              autoCapitalize="words"
              spellCheck={false}
              aria-required
            />
          </Field>
          {email ? (
            <Field label={email.label} hint={email.hint} error={emailError} required>
              <Input
                ref={emailRef}
                fieldClassName="nds-sign-input"
                type="email"
                inputMode="email"
                value={mail}
                readOnly={readOnly}
                onChange={(e) => setMail(e.target.value)}
                onBlur={() => mail.trim() && setTouched((t) => ({ ...t, email: true }))}
                autoComplete="email"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                aria-required
              />
            </Field>
          ) : null}
          {message ? (
            <p className="nds-sign-message" data-tone={messageTone} role="alert">
              {message}
            </p>
          ) : heldReason ? (
            // A held block says why on screen, not only to a screen reader.
            <p className="nds-sign-message" data-tone="warning" role="status">
              {heldReason}
            </p>
          ) : null}
          <div className="nds-sign-actions">
            {onDecline && declineLabel ? (
              <FloorButton variant="secondary" size="lg" heldReason={heldReason || (busy ? (busyLabel ?? declineLabel) : null)} onClick={onDecline}>
                {declineLabel}
              </FloorButton>
            ) : null}
            <FloorButton type="submit" variant="primary" size="lg" icon={<PenLine />} heldReason={held}>
              {busy && busyLabel ? busyLabel : acceptLabel}
            </FloorButton>
          </div>
        </form>
      )}
    </section>
  )
}
