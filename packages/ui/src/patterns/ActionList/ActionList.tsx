'use client'

/**
 * ActionList — what waits for a partner (B-W2b-155, design part ActionList): the customer's, supplier's and
 * subcontractor's Home ("Waiting for you"), and the model behind the rail's badges (`actionListCounts`).
 *
 *   <ActionList groups={[{ id: 'orders', label: 'Orders', items }]} labels={ds.actionList} countdownLabels={ds.countdown} />
 *
 * - Rows are grouped by kind (a `<section>` per group, its heading and how many still wait), sorted overdue first,
 *   then due today, soon, later and without a date (`sortActionItems`).
 * - Each row: the request in words, the record (a slot: the page passes a `RefPair`, their reference first), a line
 *   with the due and who asked, and ONE verb. The due: "Overdue since 3 Nov" in the danger role (icon and word), a live
 *   `Countdown` ("Due in 5 h") for today and soon, the date for later, nothing without one.
 * - The verb: `inline` runs in place (`onRun`; the page then passes `done` with `onUndo` while Undo is offered — the
 *   row says the done words and Undo, a polite region announces them); `dialog` opens the page's dialog
 *   (`aria-haspopup="dialog"`, a signing verb); `link` is a real link to the record. A verb that cannot act is held
 *   with its reason (`heldReason`), a running one says so (`busy`). Never a dead button.
 * - Data in, events out; dates come written (`due.text`) and the due's state from the app (the site's day).
 */
import { useId, type ReactNode } from 'react'
import { AlertCircle, Clock } from 'lucide-react'

import { mergeLabels } from '../../lib/labels'
import { Button } from '../../primitives/Button'
import { Spinner } from '../../primitives/Spinner'
import { Countdown } from '../../components/Countdown'
import type { CountdownLabels } from '../../components/CountdownLabels'
import { ACTION_LIST_LABELS, type ActionListLabels } from './ActionListLabels'
import { actionDueView, actionListCounts, sortActionItems, type ActionDue } from './actionListModel'
import './actionList.css'

export interface ActionVerb {
  /** The one verb ("Confirm", "Upload", "Sign"). */
  label: string
  /** `inline` runs in place with Undo after; `dialog` opens the page's dialog (a signing verb); `link` opens the record. */
  kind: 'inline' | 'dialog' | 'link'
  /** For `link`: the record's page at this request. */
  href?: string
  /** For `inline` and `dialog`. */
  onRun?: () => void
  /** Why it cannot act now, in words: the verb is held (focusable, says why). */
  heldReason?: string | null
  /** It runs now: held with the busy words and a spinner. */
  busy?: boolean
}

export interface ActionDone {
  /** What happened, in words ("Confirmed. The office is told."). */
  words: string
  /** Takes it back while Undo is offered (the API's `canUndo`). */
  onUndo?: () => void
  /** Why Undo cannot act now. */
  undoHeldReason?: string | null
}

export interface ActionItem {
  id: string
  /** The request in words ("Confirm order PO-2026-0101"). */
  title: string
  /** The record: the page passes a `RefPair` (their reference first). */
  record?: ReactNode
  /** One line more ("Asked by Anna Rossi"). */
  meta?: string
  due?: ActionDue | null
  verb: ActionVerb
  /** Done just now: the done words and Undo replace the verb. */
  done?: ActionDone | null
}

export interface ActionGroup {
  id: string
  /** The kind's name ("Orders to confirm"). */
  label: string
  items: readonly ActionItem[]
}

export interface ActionListProps {
  groups: readonly ActionGroup[]
  /** Words when nothing waits (default `labels.empty`). */
  empty?: ReactNode
  /** The level of each group's heading (default 3). */
  headingLevel?: 2 | 3 | 4
  /** Sort each group overdue first (default true); false keeps the order given. */
  sort?: boolean
  labels?: Partial<ActionListLabels>
  /** The countdown's words (units, "now") in the person's language. */
  countdownLabels?: Partial<CountdownLabels>
  /** The read's clock, so a server render of the countdowns matches the first client render. */
  now?: number
  className?: string
}

export function ActionList({ groups, empty, headingLevel = 3, sort = true, labels, countdownLabels, now, className }: ActionListProps) {
  const lw = mergeLabels(ACTION_LIST_LABELS, labels)
  const uid = useId()
  const counts = actionListCounts(groups)
  const shown = groups.filter((group) => group.items.length > 0)
  const H = `h${headingLevel}` as 'h3'

  return (
    <div className={['nds-actions', className].filter(Boolean).join(' ')}>
      {shown.length === 0 ? <p className="nds-actions-empty">{empty ?? lw.empty}</p> : null}
      {shown.map((group, g) => {
        const headingId = `${uid}-g${g}`
        const items = sort ? sortActionItems(group.items) : group.items
        return (
          <section key={group.id} className="nds-actions-group" aria-labelledby={headingId}>
            <div className="nds-actions-head">
              <H id={headingId} className="nds-actions-heading">
                {group.label}
              </H>
              <span className="nds-actions-count">{lw.groupCount(counts.byGroup[group.id] ?? 0)}</span>
            </div>
            <ul className="nds-actions-list">
              {items.map((item) => (
                <ActionRow key={item.id} item={item} lw={lw} countdownLabels={countdownLabels} now={now} />
              ))}
            </ul>
          </section>
        )
      })}
    </div>
  )
}

function ActionRow({ item, lw, countdownLabels, now }: { item: ActionItem; lw: ActionListLabels; countdownLabels?: Partial<CountdownLabels>; now?: number }) {
  const due = actionDueView(item.due)
  const done = item.done ?? null
  return (
    <li className="nds-actions-row" data-due={item.due?.state ?? 'none'} data-done={done ? 'true' : undefined}>
      <div className="nds-actions-text">
        <span className="nds-actions-title">{item.title}</span>
        {item.record ? <span className="nds-actions-record">{item.record}</span> : null}
        {due.kind !== 'none' || item.meta ? (
          <span className="nds-actions-meta">
            {due.kind === 'overdue' ? (
              <span className="nds-actions-due" data-tone="danger">
                <AlertCircle aria-hidden className="nds-actions-due-icon" />
                {lw.overdue(due.text)}
              </span>
            ) : due.kind === 'countdown' ? (
              <span className="nds-actions-due" data-tone={due.tone}>
                <Clock aria-hidden className="nds-actions-due-icon" />
                <Countdown to={due.at} label={lw.dueIn} doneLabel={lw.dueNow} labels={countdownLabels} now={now} announce={false} />
              </span>
            ) : due.kind === 'date' ? (
              <span className="nds-actions-due">{lw.dueOn(due.text)}</span>
            ) : null}
            {item.meta ? <span className="nds-actions-who">{item.meta}</span> : null}
          </span>
        ) : null}
      </div>
      <div className="nds-actions-verb">
        {done ? (
          <>
            <span className="nds-actions-done">{done.words}</span>
            {done.onUndo ? (
              <Button size="sm" variant="quiet" onClick={done.onUndo} heldReason={done.undoHeldReason ?? null}>
                {lw.undo}
              </Button>
            ) : null}
          </>
        ) : (
          <Verb verb={item.verb} lw={lw} />
        )}
        {/* One polite region per row, always there, so the done words are announced when they come. */}
        <span className="nds-vh" aria-live="polite" aria-atomic="true">
          {done ? done.words : ''}
        </span>
      </div>
    </li>
  )
}

function Verb({ verb, lw }: { verb: ActionVerb; lw: ActionListLabels }) {
  const held = verb.heldReason ?? (verb.busy ? lw.busy : null)
  if (verb.kind === 'link' && verb.href) {
    return (
      <Button asChild heldReason={held}>
        <a href={verb.href}>{verb.label}</a>
      </Button>
    )
  }
  return (
    <Button onClick={verb.onRun} heldReason={held} aria-haspopup={verb.kind === 'dialog' ? 'dialog' : undefined}>
      {verb.busy ? <Spinner size={14} /> : null}
      {verb.label}
    </Button>
  )
}
