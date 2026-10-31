'use client'

/**
 * LegalGate — a card of legal preconditions that holds a switch until all are met (B-W2b-28, design part LegalGate):
 * piece pay at a site, one worker's efficiency, machine signals, People settings.
 *
 *   <LegalGate title="Cottimo a Sito Demo" items={conditions} on={false}
 *              action={{ label: 'Avvia il cottimo dal 1 dicembre', onClick: startPiecePay }} labels={ds.legalGate} />
 *
 * - Each condition: its state as an icon AND a word (Met / Missing / Expired / Not checked), what is needed, the law
 *   (`law` → a `LawRef` chip), who recorded it and when, a detail, and a link to record it where it is recorded.
 * - The switch (`action`, a DS `Button`) is held — focusable, announced, inert — with the missing conditions in words,
 *   and the same words are on screen under it (`legalGateModel.ts`). A host with its own control (a Toggle in a form)
 *   passes `children` and holds it with `legalGateHeld()`.
 * - On with every condition met: one line ("On since … · every condition met") with Show conditions. On while a
 *   condition is no longer met: never folded, a warning line says so.
 */
import { createElement, useId, useState, type ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, CircleHelp, ShieldCheck, XCircle } from 'lucide-react'

import { mergeLabels } from '../../lib/labels'
import { Button } from '../../primitives/Button'
import { LawRef, type LawRefProps } from '../LawRef/LawRef'
import type { LawRefLabels } from '../LawRef/LawRefLabels'
import { LEGAL_GATE_LABELS, type LegalGateLabels } from './LegalGateLabels'
import { legalGateFolds, legalGateHeld, legalGateSummary, type LegalItemState } from './legalGateModel'
import './legalGate.css'

export interface LegalGateItem {
  id: string
  /** What is needed ("The worker notice covers piece pay and is acknowledged"). */
  label: string
  state: LegalItemState
  /** The law it comes from. */
  law?: Pick<LawRefProps, 'law' | 'plain' | 'href'>
  /** Who recorded it ("Demo Person"). */
  recordedBy?: string
  /** When, already written in the page's language. */
  recordedAt?: string
  /** A line more ("14 of 16 acknowledged"). */
  detail?: ReactNode
  /** Where it is recorded. */
  href?: string
  /** The link's words (default "Record it"). */
  linkLabel?: string
}

export interface LegalGateAction {
  label: string
  onClick: () => void
  /** The command runs: held with `busyLabel`. */
  busy?: boolean
  busyLabel?: string
}

export interface LegalGateProps {
  title: ReactNode
  items: readonly LegalGateItem[]
  /** The switch is on. */
  on?: boolean
  /** Since when, written in the page's language. */
  onSince?: string
  /** The switch, held until every condition is met. */
  action?: LegalGateAction
  /** The host's own control, under the conditions (hold it with `legalGateHeld`). */
  children?: ReactNode
  /** Unfolded at first even when it could fold. */
  defaultOpen?: boolean
  /** The level of the title (default 3). */
  headingLevel?: 2 | 3 | 4
  labels?: Partial<LegalGateLabels>
  /** The LawRef chips' words. */
  lawLabels?: Partial<LawRefLabels>
  id?: string
}

const STATE_ICON = { met: CheckCircle2, missing: XCircle, expired: AlertTriangle, unknown: CircleHelp } as const

export function LegalGate({ title, items, on = false, onSince, action, children, defaultOpen = false, headingLevel = 3, labels, lawLabels, id }: LegalGateProps) {
  const lw = mergeLabels(LEGAL_GATE_LABELS, labels)
  const auto = useId()
  const titleId = `${auto}-title`
  const listId = `${auto}-list`
  const summary = legalGateSummary(items)
  const held = legalGateHeld(items, lw)
  const folds = legalGateFolds(on, items)
  const [open, setOpen] = useState(defaultOpen)
  const showList = !folds || open
  const H = `h${headingLevel}` as 'h3'

  return (
    <section id={id} className="nds-legalgate" data-on={on ? 'true' : 'false'} data-folded={folds && !open ? 'true' : undefined} aria-labelledby={titleId}>
      <div className="nds-legalgate-head">
        <ShieldCheck className="nds-legalgate-icon" aria-hidden />
        <H id={titleId} className="nds-legalgate-title">
          {title}
        </H>
        {folds ? (
          <span className="nds-legalgate-line" data-tone="success">
            {lw.onFolded(onSince)}
          </span>
        ) : on && summary.open.length ? (
          <span className="nds-legalgate-line" data-tone="warning">
            {lw.onButOpen(summary.open.length)}
          </span>
        ) : (
          <span className="nds-legalgate-line">{lw.summary(summary.met, summary.total)}</span>
        )}
        {folds ? (
          <Button size="sm" variant="quiet" aria-expanded={open} aria-controls={listId} onClick={() => setOpen((v) => !v)}>
            {open ? <ChevronUp size={14} aria-hidden /> : <ChevronDown size={14} aria-hidden />}
            {open ? lw.hide : lw.show}
          </Button>
        ) : null}
      </div>
      {showList ? (
        <ol id={listId} className="nds-legalgate-items" aria-label={lw.list}>
          {items.map((item) => (
            <li key={item.id} className="nds-legalgate-item" data-state={item.state}>
              <span className="nds-legalgate-state">
                {createElement(STATE_ICON[item.state], { 'aria-hidden': true, className: 'nds-legalgate-state-icon' })}
                {lw.states[item.state]}
              </span>
              <div className="nds-legalgate-body">
                <div className="nds-legalgate-label">
                  {item.label} {item.law ? <LawRef {...item.law} labels={lawLabels} /> : null}
                </div>
                {item.detail ? <div className="nds-legalgate-detail">{item.detail}</div> : null}
                <div className="nds-legalgate-who">{item.recordedBy ? lw.recordedBy(item.recordedBy, item.recordedAt) : lw.notRecorded}</div>
              </div>
              {item.href ? (
                <a className="nds-legalgate-link" href={item.href}>
                  {item.linkLabel ?? lw.record}
                </a>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
      {action && !on ? (
        <div className="nds-legalgate-action">
          <Button variant="primary" heldReason={held ?? (action.busy ? (action.busyLabel ?? action.label) : null)} onClick={action.onClick}>
            {action.busy && action.busyLabel ? action.busyLabel : action.label}
          </Button>
          {held ? <p className="nds-legalgate-held">{held}</p> : null}
        </div>
      ) : null}
      {children ? <div className="nds-legalgate-action">{children}</div> : null}
    </section>
  )
}
