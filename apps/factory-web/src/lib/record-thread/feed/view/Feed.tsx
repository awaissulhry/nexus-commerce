'use client'

import { useMemo, useState } from 'react'
import { Lock, Pin, WifiOff } from 'lucide-react'
// B-TH-255: the pills of what the View hides and of the mail that waits for a person.
import { EyeOff, MailWarning } from 'lucide-react'
import Link from 'next/link'
import { Banner, EmptyState } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { rightWords } from '../../../i18n/messages'
import { useLocale, useT } from '../../../i18n/provider'
import type { Translate } from '../../../i18n/messages'
import type { Locale } from '../../../i18n/locales'
import { replyWay, type CardContext, type CardMessage } from '../../card/model'
import { MessageCard, type CardActions } from '../../card/view/MessageCard'
// pt-w1 W1.3 (lane pt-, S4): the list both doors draw — its behaviour (the hook) and its scroller (the view); this feed draws the rows.
import { useFeedShell } from '../use-feed-shell'
import { dayText, DayRow, FeedEmpty, FeedFailed, FeedLoading, FeedShell, UnreadRow } from './FeedShell' // pt-w2 W2.2: the day pill and the unread band both doors draw
import { dayOf, timeOf } from '../../parts/time'
import { feedRows, whoWords, type FeedEvent, type FeedPin, type FeedRow } from '../model'
import { stepsWordsOf, stepVerbKey } from '../model' // F-OP-214: other modules' words, the run of steps
import { hiddenNewLine, waitingMailLine, type FeedWaitingMail } from '../model' // B-TH-255
import '../../parts/parts.css'
import { tonesFor } from '../../parts/tones' // tw- fx2 (G-7)
import '../feed.css'

export interface FeedModel {
  /** ready: the messages are read; loading: the first read; error: it failed; forbidden: the reader may not read threads. */
  state: 'loading' | 'error' | 'forbidden' | 'ready'
  /** tw- W2.4 (B6): forbidden only until the person confirms it is them (the second step): the words say how. Absent: a right is missing. */
  forbiddenWhy?: 'stepUp'
  messages: readonly CardMessage[]
  events: readonly FeedEvent[]
  context: CardContext
  /** Older messages exist (the top of the list reads the next page as the person scrolls up). */
  more: boolean
  /** The older page: reading ("Reading earlier messages…"), or it failed ("Could not load earlier messages · Retry"). */
  older?: 'idle' | 'loading' | 'failed'
  /** No network: the messages until then, and since when. */
  offline?: { since: string } | null
  /** Now, for Today / Yesterday (ISO). */
  now: string
  /** Messages that arrived while the reader was higher up: the round down button's count (design cases set it). */
  newCount?: number
  // ---- B-TH-229: the reader's own reading on arrival (B-TH-027): the band "3 unread messages" above the first new message, the
  // feed opening there; the count rides on the down button while the reader is above them.
  firstNewId?: string | null
  newSince?: number
  // ---- end B-TH-229
  // ---- B-TH-255 (B-TH-079): the messages new to the reader that the Head's View hides (the API's `hiddenNew` for the view; 0 or absent
  // on All), and the mail for this conversation that waits for a person (the office read's `waitingMail`; null: none).
  hiddenNew?: number
  waitingMail?: FeedWaitingMail | null
  // ---- end B-TH-255
  // ---- tw- W1.3 / W1.4 (THE THREAD REBUILD): the row a jump lights up (the container's: `seq` restarts it); the pins with who pinned
  // them ("Alex Demo pinned a message", office only); paper (R18: every message alone, its name, who reads it in words).
  flash?: { readonly id: string; readonly seq: number } | null
  pins?: readonly FeedPin[]
  paper?: boolean
  // ---- end tw- W1.3 / W1.4
}

export interface FeedActions extends CardActions {
  /** The next older page (the top of the list as the person scrolls up), and its Retry. */
  onOlder?: () => void
  /** "Try again" after the thread could not be read. */
  onReload?: () => void
  /** B-TH-229: the newest message that was on screen for a second (the container marks the thread read up to it, T1-F04). */
  onSeen?: (messageId: string) => void
  /** B-TH-255: "Show all" on the pill of what the View hides (the Head's View back to All). */
  onShowAll?: () => void
}

/**
 * The feed (B-TH-204, T4; tw- W1.3 THE THREAD REBUILD, 10-design §3, §6, §7): a record's messages oldest first in one scrolling
 * column (role feed; each message an article) — bubbles on two sides in runs, no fold: older pages load as the person scrolls up
 * (a pill only while one is read); every row that is not a message is a centred pill (the day, a step, changes, a pin); the day
 * floats at the top while scrolling; the band "3 unread messages" and the thread opens there; the round down button whenever the
 * reader is higher up, with the count of what arrived below (nothing jumps under the pointer); a jump lights the whole row. J / K walk
 * the messages and R answers the focused one while the feed has the focus. Draws its model; the container reads and re-reads.
 */
export function Feed({ model, actions }: { model: FeedModel; actions?: FeedActions }) {
  const t = useT('record-thread-feed')
  const locale = useLocale()
  const [shownChanges, setShownChanges] = useState<ReadonlySet<string>>(new Set())
  // tw- fx2 (walk G-7): one colour per person inside this list (the host's when it gave them).
  const listContext = useMemo(() => (model.context.tones ? model.context : { ...model.context, tones: tonesFor(model.messages.map((message) => message.senderKey)) }), [model.context, model.messages])
  const rows = useMemo(
    () => (model.state === 'ready' ? feedRows({ messages: model.messages, events: model.events, firstNewId: model.firstNewId ?? null, newCount: model.newSince ?? 0, pins: model.pins ?? [], paper: model.paper === true }) : []),
    [model.state, model.messages, model.events, model.firstNewId, model.newSince, model.pins, model.paper],
  )
  const today = dayOf(model.now)
  // pt-w1 W1.3: the list's behaviour, moved as it was (lib/record-thread/feed/use-feed-shell.ts) — open at the link, the band or the
  // newest; seen; older on scroll; live arrivals and the down count; the floating day; J / K; R answers the focused message its own way.
  const shell = useFeedShell(model, rows, actions, (message) => replyWay(message, model.context) !== null)

  // pt-w2 W2.2: the first read and a failed one, as both doors draw them (FeedShell).
  if (model.state === 'loading') return <FeedLoading />
  if (model.state === 'error') return <FeedFailed onRetry={actions?.onReload} />
  if (model.state === 'forbidden') {
    return (
      <div className="fw-rt-feedwrap">
        <div className="fw-rt-state is-center">
          <EmptyState icon={<Lock size={22} aria-hidden />} title={t('state.forbidden')} description={model.forbiddenWhy === 'stepUp' ? t('state.stepUp') : t('state.forbiddenBody', { right: rightWords(locale, 'threads.read') })} />
        </div>
      </div>
    )
  }

  return (
    <FeedShell
      shell={shell}
      model={model}
      top={
        model.offline && (
          <Banner tone="warning" className="fw-rt-offline" icon={<WifiOff size={16} aria-hidden />} title={t('state.offline', { time: timeOf(model.offline.since, locale) })}>
            {t('state.offlineBody')}
          </Banner>
        )
      }
      empty={
        model.messages.length === 0 && model.events.length === 0 ? (
          <>
            <FeedEmpty />
            {/* B-TH-255: a view that hides everything, or mail that waits, still says so under the empty state. */}
            <EndLines model={model} actions={actions} t={t} />
          </>
        ) : null
      }
      rows={rows.map((row) => (
        <Row
          key={row.key}
          row={row}
          t={t}
          locale={locale}
          today={today}
          context={listContext}
          actions={actions}
          paper={model.paper === true}
          flash={row.kind === 'message' ? shell.flashOf(row.message.id) : null}
          showChanges={shownChanges.has(row.key)}
          onToggleChanges={() =>
            setShownChanges((set) => {
              const next = new Set(set)
              if (next.has(row.key)) next.delete(row.key)
              else next.add(row.key)
              return next
            })
          }
        />
      ))}
      // B-TH-255: what the View hides and the mail that waits for a person, at the end where new messages arrive.
      end={<EndLines model={model} actions={actions} t={t} />}
    />
  )
}

function Row({
  row,
  t,
  locale,
  today,
  context,
  actions,
  paper,
  flash,
  showChanges,
  onToggleChanges,
}: {
  row: FeedRow
  t: Translate
  locale: Locale
  today: string
  context: CardContext
  actions?: FeedActions
  paper: boolean
  flash: { seq: number; onEnd: () => void } | null
  showChanges: boolean
  onToggleChanges: () => void
}) {
  const statusWords = useT('search') // tw- W2.4: the record types' status words (THREAD_NAMESPACES loads them)
  if (row.kind === 'day') return <DayRow words={dayText(row.day, today, locale, t)} />
  if (row.kind === 'new') return <UnreadRow count={row.count} t={t} />
  if (row.kind === 'message') {
    return (
      <div className="fw-rt-feed-item" data-day={dayText(dayOf(row.message.at), today, locale, t)}>
        <MessageCard message={row.message} context={context} actions={actions} run={row.run} flash={flash} paper={paper} />
      </div>
    )
  }
  if (row.kind === 'pin') {
    // tw- W1.3 (10-design §7): "Alex Demo pinned a message" — office only (the container hands office pins with who pinned them).
    return (
      <div className="fw-rt-pillrow">
        <p className="fw-rt-pill">
          <Pin size={13} aria-hidden />
          <span>{t('pinned.pill', { who: row.pin.by })}</span>
        </p>
      </div>
    )
  }
  if (row.kind === 'step') {
    const event = row.event
    const who = whoWords(event)
    const move = statusMove(event.status, t, statusWords)
    return (
      // F-SA-265: "Show in the thread" (a history row of the page) finds its step by its id.
      <div className="fw-rt-pillrow">
        <p className="fw-rt-pill fw-rt-event" data-event-ids={event.id} tabIndex={-1}>
          <span>
            {t('step.text', { who: 'text' in who ? who.text : t(who.key), verb: t(stepVerbKey(event)) /* F-OP-214 */ })}
            {/* tw- W2.4 (the lead's rule): the status in the record type's own words, never a code; no words: the step's label alone. */}
            {move ? ` · ${move}` : ''}
          </span>
          <time dateTime={event.at}>{timeOf(event.at, locale)}</time>
        </p>
      </div>
    )
  }
  // ---- F-OP-214 (11-dock §6.1): a run of steps of the same actor within an hour — one pill, "5 steps by Nexus Factory · Show"; Show
  // lists each step in place (its words and time). A status step is never in a run.
  if (row.kind === 'steps') {
    const first = row.events[0]!
    const who = whoWords(first)
    const words = stepsWordsOf(row.events)
    const listId = `steps-${first.id}`
    const last = row.events[row.events.length - 1]!
    return (
      <div className="fw-rt-pillrow">
        <div className={`fw-rt-pill fw-rt-event${showChanges ? ' is-open' : ''}`} data-event-ids={row.events.map((event) => event.id).join(' ')} tabIndex={-1}>
          <p className="fw-rt-pill-line">
            <span>
              {t(words.key, { count: words.count, who: 'text' in who ? who.text : t(who.key) })}
              {' · '}
              <Button size="sm" variant="link" aria-expanded={showChanges} aria-controls={listId} onClick={onToggleChanges}>
                {t(showChanges ? 'changes.hide' : 'changes.show')}
              </Button>
            </span>
            <time dateTime={last.at}>{timeOf(last.at, locale)}</time>
          </p>
          <ul id={listId} className="fw-rt-changes" hidden={!showChanges}>
            {row.events.map((event) => (
              <li key={event.id}>
                {t(stepVerbKey(event))} · {timeOf(event.at, locale)}
              </li>
            ))}
          </ul>
        </div>
      </div>
    )
  }
  // ---- end F-OP-214
  const first = row.events[0]
  const who = whoWords(first)
  const lines = row.events.flatMap((event) => (event.values.length > 0 ? event.values.map((value) => (value.field === 'status' ? (statusMove({ from: value.before, to: value.after }, t, statusWords) ?? value.field) : `${value.field}: ${value.before} → ${value.after}`)) : event.fields.length > 0 ? [t('changes.fields', { fields: event.fields.join(', ') })] : []))
  const count = row.events.reduce((sum, event) => sum + Math.max(1, event.values.length || event.fields.length), 0)
  const listId = `changes-${first.id}`
  return (
    <div className="fw-rt-pillrow">
      {/* F-SA-265: "Show in the thread" finds a grouped change by any of its steps' ids. */}
      <div className={`fw-rt-pill fw-rt-event${showChanges ? ' is-open' : ''}`} data-event-ids={row.events.map((event) => event.id).join(' ')} tabIndex={-1}>
        <p className="fw-rt-pill-line">
          <span>
            {t('changes.text', { count, who: 'text' in who ? who.text : t(who.key) })}
            {lines.length > 0 && (
              <>
                {' · '}
                <Button size="sm" variant="link" aria-expanded={showChanges} aria-controls={listId} onClick={onToggleChanges}>
                  {t(showChanges ? 'changes.hide' : 'changes.show')}
                </Button>
              </>
            )}
          </span>
          <time dateTime={row.events[row.events.length - 1].at}>{timeOf(row.events[row.events.length - 1].at, locale)}</time>
        </p>
        {lines.length > 0 && (
          <ul id={listId} className="fw-rt-changes" hidden={!showChanges}>
            {lines.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

// ── B-TH-255 (B-TH-079; T1-F05, T4-F10) ─────────────────────────────────────────────────────────────────────────────

/**
 * The quiet pills at the end of the feed: "1 new message hidden by this view · Show all" while the Head's View hides news (T1-F05),
 * then the mail for this conversation that waits for a person (T4-F10) — for a reader with email.triage how many, why and Review
 * (Home › Mail to sort); for anyone else "A reply waits for a colleague to check it", never the sender or why (W07, W08, W22, W34).
 */
function EndLines({ model, actions, t }: { model: FeedModel; actions?: FeedActions; t: Translate }) {
  const hidden = hiddenNewLine(model.hiddenNew)
  const waiting = waitingMailLine(model.waitingMail)
  if (!hidden && !waiting) return null
  return (
    <>
      {hidden && (
        <div className="fw-rt-pillrow">
          <p className="fw-rt-pill fw-rt-endline is-hidden-new" role="status">
            <EyeOff size={13} aria-hidden />
            <span>{t('hidden.line', { count: hidden.count })}</span>
            {actions?.onShowAll && (
              <>
                <span aria-hidden>·</span>
                <Button size="sm" variant="link" onClick={actions.onShowAll}>
                  {t('hidden.showAll')}
                </Button>
              </>
            )}
          </p>
        </div>
      )}
      {waiting && (
        <div className="fw-rt-pillrow">
          <p className="fw-rt-pill fw-rt-endline is-waiting" role="note">
            <MailWarning size={13} aria-hidden />
            <span>{waiting.reasons.length > 0 ? t(`${waiting.key}Why`, { count: waiting.count, why: waiting.reasons.map((key) => t(key)).join(', ') }) : t(waiting.key, { count: waiting.count })}</span>
            {waiting.href && (
              <>
                <span aria-hidden>·</span>
                <Link className="fw-rt-endline-link" href={waiting.href}>
                  {t('waiting.open')}
                </Link>
              </>
            )}
          </p>
        </div>
      )}
    </>
  )
}

/**
 * tw- W2.4 (the lead's rule for step and change pills): a status move in words — the record types' own status words (the search
 * catalogue's `status.<code>`, the words every list says them in); a code with no words is never shown: the step's own label says it.
 */
export function statusMove(status: { readonly from: string | null; readonly to: string | null } | null, t: Translate, statusWords: Translate): string | null {
  if (!status) return null
  const said = (code: string | null): string | null => {
    if (!code) return null
    const key = `status.${code}`
    const words = statusWords(key)
    return words === key ? null : words
  }
  const from = said(status.from)
  const to = said(status.to)
  if (!to) return null
  return from ? t('step.status', { from, to }) : to
}
