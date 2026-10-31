'use client'

/**
 * CheckList — named checks before an action (B-W2b-09; the design's CheckList and ReadinessChecklist are this one
 * part): each check's state with an icon AND a word, its reason in words and a Fix link; it re-runs as data changes;
 * it feeds the action's held primary (`checkListHeld`, `checkListButton`: "Release · 2 checks open").
 *
 *   const held = checkListHeld(checks, ds.checkList)
 *   <CheckList label="Before release" checks={checks} labels={ds.checkList} />
 *   <Button variant="primary" heldReason={held}>{checkListButton('Release', checks, ds.checkList)}</Button>
 *
 * - States: pass (✓ Done), warning (! passes, says what to watch), fail (✗ Open), checking (being run again — never
 *   claimed as passed), skipped (– Not needed), unknown (? could not be checked). fail, checking and unknown hold the
 *   action unless a check says `blocks`.
 * - A check's `fix` is where to fix it: `{ label, href }` (a real link; `target: '_blank'` for "opens in a new tab"),
 *   `{ label, onClick }`, or the app's own node. Shown for checks that do not pass.
 * - The summary ("2 of 7 checks open") is a polite live region, mounted once: a check that changes is heard.
 * Its own entry point (`patterns/checklist`), not in the patterns barrel. Every word comes from `labels` or the app.
 */
import { isValidElement, type ComponentType, type MouseEventHandler, type ReactNode } from 'react'
import NextLink from 'next/link'
import { AlertTriangle, CheckCircle2, CircleHelp, MinusCircle, XCircle } from 'lucide-react'

import { Button } from '../../primitives/Button'
import { Spinner } from '../../primitives/Spinner'
import { mergeLabels } from '../../lib/labels'
import { CHECK_LIST_LABELS, type CheckListLabels } from './CheckListLabels'
import { checkBlocks, checkListSummary, type CheckState } from './checkListModel'
import './checklist.css'

export interface CheckFix {
  /** "Open the lot", "Upload the certificate". */
  label: string
  href?: string
  /** `_blank`: the link opens a new tab (its words should say so). */
  target?: '_blank'
  onClick?: () => void
}

export interface CheckItem {
  id: string
  state: CheckState
  /** The check's name: "Lot released". Also names it in the held reason. */
  name: string
  /** The reason in words: "Lot L-0042 is on hold since 12 Oct (fabric shade)". */
  detail?: ReactNode
  /** Where to fix it (shown when the check does not pass). */
  fix?: CheckFix | ReactNode
  /** Overrides whether this check holds the action. */
  blocks?: boolean
}

/** The host's link (the web app's workspace `Link`; Next's `Link` by default). */
export type CheckListLinkComponent = ComponentType<{
  href: string
  className?: string
  children?: ReactNode
  target?: string
  rel?: string
  onClick?: MouseEventHandler<HTMLAnchorElement>
}>

export interface CheckListProps {
  checks: readonly CheckItem[]
  /** The list's name for a screen reader: "Before release". */
  label: string
  /** Draw the summary line above the checks. Default true. */
  summary?: boolean
  /** `compact`: one line per check, the reason under the name only when it does not pass. */
  density?: 'comfortable' | 'compact'
  linkAs?: CheckListLinkComponent
  labels?: Partial<CheckListLabels>
  className?: string
}

const ICON: Record<CheckState, ReactNode> = {
  pass: <CheckCircle2 size={16} aria-hidden />,
  warning: <AlertTriangle size={16} aria-hidden />,
  fail: <XCircle size={16} aria-hidden />,
  checking: <Spinner size={14} />,
  skipped: <MinusCircle size={16} aria-hidden />,
  unknown: <CircleHelp size={16} aria-hidden />,
}

const isFix = (fix: unknown): fix is CheckFix => !!fix && typeof fix === 'object' && !isValidElement(fix) && 'label' in (fix as object)

export function CheckList({ checks, label, summary = true, density = 'comfortable', linkAs, labels, className }: CheckListProps) {
  const words = mergeLabels(CHECK_LIST_LABELS, labels)
  const states = { ...CHECK_LIST_LABELS.states, ...(labels?.states ?? {}) }
  const sum = checkListSummary(checks, words)
  const Link = linkAs ?? NextLink
  const fixOf = (fix: CheckItem['fix']) => {
    if (fix == null || fix === false) return null
    if (!isFix(fix)) return fix as ReactNode
    if (fix.href) {
      return (
        <Link className="nds-checklist-fix" href={fix.href} target={fix.target} rel={fix.target === '_blank' ? 'noopener noreferrer' : undefined}>
          {fix.label}
        </Link>
      )
    }
    return (
      <Button size="sm" variant="link" inline onClick={fix.onClick}>
        {fix.label}
      </Button>
    )
  }
  const cls = ['nds-checklist', density === 'compact' ? 'compact' : '', className ?? ''].filter(Boolean).join(' ')
  return (
    <section className={cls} aria-label={label}>
      {/* Mounted from the first render, so a check that changes is heard; hidden when `summary` is off. */}
      <p className={summary ? `nds-checklist-summary${sum.ready ? ' is-ready' : sum.open > 0 ? ' is-open' : ''}` : 'nds-vh'} role="status" aria-live="polite">
        {sum.words}
      </p>
      {checks.length > 0 && (
        <ul className="nds-checklist-items">
          {checks.map((check) => {
            const blocking = checkBlocks(check)
            const showFix = check.state !== 'pass' && check.state !== 'skipped'
            const showDetail = density !== 'compact' || check.state !== 'pass'
            return (
              <li key={check.id} className={`nds-checklist-item is-${check.state}${blocking ? ' is-blocking' : ''}`}>
                <span className="nds-checklist-mark">
                  <span className="nds-checklist-icon" aria-hidden>{ICON[check.state]}</span>
                  <span className="nds-checklist-word">{states[check.state]}</span>
                </span>
                <span className="nds-checklist-body">
                  <span className="nds-checklist-name">{check.name}</span>
                  {showDetail && check.detail != null && check.detail !== '' && <span className="nds-checklist-detail">{check.detail}</span>}
                </span>
                {showFix && check.fix != null && <span className="nds-checklist-fixes">{fixOf(check.fix)}</span>}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
