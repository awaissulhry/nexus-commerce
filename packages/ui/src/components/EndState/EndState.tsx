'use client'

/**
 * EndState — the one end of a link or portal task, and every link state (B-W2b-155, design part EndState): an icon, the
 * headline, what happened, what happens next, the receipt, the reference, your copy and whom to contact.
 *
 *   <EndState tone="success" title="Accepted — thank you, Anna." body="We sent a copy to anna@brand.example."
 *             next={['Pay the deposit of 714,00 € by 20 Nov.', 'We confirm the order within 1 working day.']}
 *             facts={[{ label: 'Accepted by', value: 'Anna Rossi' }, { label: 'At', value: '3 Nov 2026, 10:42' }]}
 *             reference={{ value: 'Q-2026-0042' }} copy={{ href: pdfUrl, fileName: 'Q-2026-0042.pdf' }}
 *             contact={{ name: 'Marco Demo', email: 'marco@factory.example' }} labels={ds.endState} />
 *
 * - The headline is the page's heading (`headingLevel`, default 2) and takes the focus when the end appears
 *   (`focusOnMount`, default true), so a screen reader hears what happened; the icon is decoration (its tone is in words
 *   in the headline).
 * - A dead link is not a dead end: `actions` holds "Ask for a new link"; pressed once, the page sets `done` and the
 *   button holds with those words ("Asked — we passed it on"). Busy and held actions say why (Button `heldReason`).
 * - `children` takes what belongs to this end (the deposit's bank details, a PaymentPanel), under the copy.
 * - The contact block is always last: name, detail, e-mail and phone as real links.
 */
import { createElement, useEffect, useId, useRef, type ReactNode } from 'react'
import { AlertTriangle, Check, CheckCircle2, Copy, Download, Info, Mail, Phone, XCircle } from 'lucide-react'

import { mergeLabels } from '../../lib/labels'
import { Button } from '../../primitives/Button'
import { useCopyText } from '../RefPair/useCopyText'
import { END_STATE_LABELS, type EndStateLabels } from './EndStateLabels'
import { endStateActionView, endStateSteps, mailtoOf, telOf, type EndStateAction, type EndStateContact, type EndStateTone } from './endStateModel'
import './endState.css'

export interface EndStateFact {
  label: ReactNode
  value: ReactNode
}

export interface EndStateCopy {
  /** The file's address (a presigned link, the PDF route). */
  href: string
  /** The link's words. Default "Download your copy" (with `fileName`: "… (Q-2026-0042.pdf)"). */
  label?: string
  /** The file's name, said in the link and offered to the browser as the download's name. */
  fileName?: string
}

export interface EndStateProps {
  /** How it ended: the icon and its colour. Default `success`. */
  tone?: EndStateTone
  /** Another icon (a link that expired: a clock). Default by tone. */
  icon?: ReactNode
  /** What happened, in one line: the page's heading. */
  title: ReactNode
  /** A line or two under it. */
  body?: ReactNode
  /** What happens next: one sentence, or the steps in order. */
  next?: ReactNode | readonly ReactNode[]
  /** The receipt: name, time, document code, terms version. */
  facts?: readonly EndStateFact[]
  /** The reference the partner quotes when they write, with a copy button. */
  reference?: { value: string; label?: string } | null
  /** Your copy of what was sent or signed. */
  copy?: EndStateCopy | null
  /** Buttons or links: "Ask for a new link", "Open the portal", "Back to orders". */
  actions?: readonly EndStateAction[]
  /** What belongs to this end, under the copy (the deposit's bank details, a PaymentPanel). */
  children?: ReactNode
  /** Whom to ask, always last. */
  contact?: EndStateContact | null
  /** The headline's level. Default 2 (the link page's h1 is the record's title). */
  headingLevel?: 1 | 2 | 3
  /** The headline takes the focus when the end appears. Default true. */
  focusOnMount?: boolean
  className?: string
  labels?: Partial<EndStateLabels>
}

const TONE_ICON = { success: CheckCircle2, info: Info, warning: AlertTriangle, danger: XCircle, neutral: Info } as const

export function EndState({
  tone = 'success', icon, title, body, next, facts, reference, copy, actions, children, contact, headingLevel = 2, focusOnMount = true, className, labels,
}: EndStateProps) {
  const lw = mergeLabels(END_STATE_LABELS, labels)
  const auto = useId()
  const titleId = `${auto}-title`
  const heading = useRef<HTMLHeadingElement>(null)
  const { state, copy: copyText } = useCopyText()
  useEffect(() => {
    if (focusOnMount) heading.current?.focus()
  }, [focusOnMount])
  const steps = endStateSteps(next)
  const H = `h${headingLevel}` as 'h2'
  const mail = contact ? mailtoOf(contact.email) : null
  const tel = contact ? telOf(contact.phone) : null
  const copied = state?.outcome === 'copied'

  return (
    <section className={['nds-endstate', className].filter(Boolean).join(' ')} data-tone={tone} aria-labelledby={titleId}>
      <div className="nds-endstate-head">
        <span className="nds-endstate-icon" aria-hidden>
          {icon ?? createElement(TONE_ICON[tone], { 'aria-hidden': true })}
        </span>
        <H id={titleId} ref={heading} tabIndex={-1} className="nds-endstate-title">
          {title}
        </H>
        {body ? <div className="nds-endstate-body">{body}</div> : null}
      </div>

      {steps.length ? (
        <div className="nds-endstate-block">
          <h3 className="nds-endstate-h">{lw.next}</h3>
          {steps.length === 1 ? (
            <p className="nds-endstate-next">{steps[0]}</p>
          ) : (
            <ol className="nds-endstate-steps">
              {steps.map((step, i) => (
                <li key={i}>{step}</li>
              ))}
            </ol>
          )}
        </div>
      ) : null}

      {facts?.length ? (
        <div className="nds-endstate-block">
          <h3 className="nds-endstate-h">{lw.receipt}</h3>
          <dl className="nds-endstate-facts">
            {facts.map((fact, i) => (
              <div key={i} className="nds-endstate-fact">
                <dt>{fact.label}</dt>
                <dd>{fact.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}

      {reference?.value ? (
        <div className="nds-endstate-ref">
          <span className="nds-endstate-ref-label">{reference.label ?? lw.reference}</span>
          <span className="nds-endstate-ref-value">{reference.value}</span>
          <Button size="sm" variant="quiet" aria-label={lw.copyReference(reference.value)} onClick={() => void copyText(reference.value)}>
            {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
          </Button>
          <span className="nds-vh" role="status">
            {state ? (copied ? lw.copied : lw.copyFailed) : ''}
          </span>
        </div>
      ) : null}

      {copy?.href ? (
        <div className="nds-endstate-copy">
          <Button asChild>
            <a href={copy.href} download={copy.fileName ?? true}>
              <Download size={16} aria-hidden />
              {copy.label ?? (copy.fileName ? lw.yourCopyNamed(copy.fileName) : lw.yourCopy)}
            </a>
          </Button>
        </div>
      ) : null}

      {actions?.length ? (
        <div className="nds-endstate-actions">
          {actions.map((action, i) => {
            const view = endStateActionView(action, lw.busy)
            const variant = action.variant ?? 'secondary'
            return action.href && !view.held ? (
              <Button key={i} variant={variant} asChild>
                <a href={action.href}>{view.words}</a>
              </Button>
            ) : (
              <Button key={i} variant={variant} heldReason={view.held} onClick={action.onClick}>
                {action.done ? <Check size={16} aria-hidden /> : null}
                {view.words}
              </Button>
            )
          })}
        </div>
      ) : null}

      {children ? <div className="nds-endstate-extra">{children}</div> : null}

      {contact ? (
        <footer className="nds-endstate-contact">
          <h3 className="nds-endstate-h">{lw.contact}</h3>
          <p className="nds-endstate-who">
            <strong>{contact.name}</strong>
            {contact.detail ? <span className="nds-endstate-detail">{contact.detail}</span> : null}
          </p>
          {contact.email || contact.phone ? (
            <p className="nds-endstate-reach">
              {contact.email ? (
                mail ? (
                  <a href={mail} className="nds-endstate-link" aria-label={`${lw.emailTo(contact.name)}: ${contact.email}`}>
                    <Mail size={16} aria-hidden />
                    {contact.email}
                  </a>
                ) : (
                  <span>{contact.email}</span>
                )
              ) : null}
              {contact.phone ? (
                tel ? (
                  <a href={tel} className="nds-endstate-link" aria-label={`${lw.callTo(contact.name)}: ${contact.phone}`}>
                    <Phone size={16} aria-hidden />
                    {contact.phone}
                  </a>
                ) : (
                  <span>{contact.phone}</span>
                )
              ) : null}
            </p>
          ) : null}
        </footer>
      ) : null}
    </section>
  )
}
