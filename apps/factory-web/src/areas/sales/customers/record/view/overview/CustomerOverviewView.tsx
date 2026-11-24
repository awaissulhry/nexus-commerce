'use client'

import { Fragment, useMemo, type ReactNode } from 'react'
import Link from 'next/link'
import { Ban, Banknote, Clock, FileCheck, Flag, Pause, Receipt, ShieldAlert } from 'lucide-react'
import { Button, Skeleton, Tag } from '@nexus/ui/primitives'
import { useLocale, useScopedT } from '../../../../../../lib/i18n/provider'
import { ageOf } from '../../../../../../lib/production/model'
import { useProductionWords } from '../../../../../../lib/production/words'
import { WithMessages } from '../../../../../../record-panels/i18n'
// The shared overview kit: every card, row, strip, fact and group below is ITS part — this file hands them data and doors only.
import { CardState, Door, Fact, FactCols, Group, GroupRow, Groups, Headline, Overview, OverviewCard, OverviewPair, QuietLine, Row, RowAge, RowList, Strip, Strips, StripSaid, useOverviewWords } from '../../../../../_shared/record-overview/Overview'
import type { BeforeLinePart } from '../../before-order'
import {
  OVERVIEW_NAMESPACES,
  sayOf,
  sayToolsOf,
  type CustomerOverviewModel,
  type FactRow,
  type LabelledDoor,
  type OverviewAct,
  type OverviewRow,
  type OverviewStrip,
  type OverviewWindow,
  type RequestsCard,
  type RowPart,
  type Say,
  type StripKind,
} from '../../overview/model'
import { WorkBand, type WorkBandActions, type WorkBandModel } from '../WorkBand'

/**
 * F-CO-103 (customer page › Overview; plan §1; 10-design; picture 20; lead settles S5, S6, S9, S10, S23, S24) — the customer's
 * Overview, drawn ONLY with the shared overview kit's parts (areas/_shared/record-overview), in the order's reading order:
 *
 *   1  Where <customer> stands      the headline (one sentence) · its quiet note · the strips (what stops the customer)
 *   2  All orders of <customer>     the Work tab's own band (WorkBand, no chips, no group pressed) INSIDE a card (S6) — a press is a
 *                                   door into Work; a customer with no order: one quiet line and the "Before an order" doors
 *   3 · 4  People · Next dates      a pair; no date at all: Next dates is left out and People takes the row (S24)
 *   (until its rows land in People: today's "Who looks after <customer>" card, as it is, full width)
 *   5 · 6  Requests & changes · Linked records   a pair; nothing waits: Requests is left out and Linked takes the row (S24)
 *   7 · 8  Customer facts · Custom fields        a pair; no field applies: Customer facts takes the row
 *
 * It has NO stylesheet of its own and restyles no kit class: a kit part has no look prop — this file hands it words, numbers and
 * doors. Every door is a real link or the page's own command; a button the reader has no right for is not in the model. It
 * fetches nothing: ../../overview/CustomerOverview.tsx builds the model from the reads the page already holds; a design case
 * hands made-up reads.
 */

export interface OverviewActions {
  /** The record's own commands and dialogs (Edit, the tax identity, Check VIES), and the glance's retry. */
  readonly onAct?: (act: OverviewAct) => void
  /** The Work tab's two windows (the page goes to Work and opens the window there). */
  readonly onWindow?: (window: OverviewWindow) => void
  /** Requests & changes could not be read: its reads again. */
  readonly onRetryRequests?: () => void
}

export interface CustomerOverviewViewProps {
  readonly model: CustomerOverviewModel
  /** Card 2: the Work tab's band as the page builds it (`chips: []`, `shown: null`); null: not drawn (no orders.view). */
  readonly band?: { readonly model: WorkBandModel; readonly actions?: WorkBandActions } | null
  /** The "Before an order" doors (a customer with no order at all says them under its one quiet line). */
  readonly before?: readonly BeforeLinePart[]
  readonly actions?: OverviewActions
  /** Until its rows land in People: today's "Who looks after <customer>" card, as it is, full width under the People pair. */
  readonly supervisor?: ReactNode
  /** The record's custom fields: the last pair's second card. */
  readonly fields?: ReactNode
}

export function CustomerOverviewView(props: CustomerOverviewViewProps) {
  return (
    <WithMessages namespaces={OVERVIEW_NAMESPACES}>
      <Overview>
        <Cards {...props} />
      </Overview>
    </WithMessages>
  )
}

/** Each strip's mark (told by word and place too, never the mark alone). */
const MARK: Readonly<Record<StripKind, ReactNode>> = {
  blocked: <Ban size={14} aria-hidden />,
  hold: <Pause size={14} aria-hidden />,
  credit: <Banknote size={14} aria-hidden />,
  invoice: <Receipt size={14} aria-hidden />,
  vies: <ShieldAlert size={14} aria-hidden />,
  overdue: <Clock size={14} aria-hidden />,
  orderWaits: <FileCheck size={14} aria-hidden />,
  urgency: <Flag size={14} aria-hidden />,
}

interface Words {
  readonly said: (words: Say) => string
  /** A door's words: "<label> ›" (the kit's own word, S31: its "›" never stands alone on a line) when it leaves the card. */
  readonly doorWords: (door: LabelledDoor) => string
}

function Cards({ model, band, before = [], actions, supervisor, fields }: CustomerOverviewViewProps) {
  const t = useScopedT('parties')
  const locale = useLocale()
  const kit = useOverviewWords()
  const production = useProductionWords()
  const tools = useMemo(() => sayToolsOf(locale, t), [locale, t])
  const words: Words = {
    said: (say) => sayOf(say, tools),
    doorWords: (door) => (door.arrow ? kit.door(sayOf(door.label, tools)) : sayOf(door.label, tools)),
  }
  const { said } = words
  const customer = model.customer
  const now = Date.now()
  /** An age against now ("8 d"), its day in the tip; null: no start, or it is still ahead. */
  const ageOfStart = (since: string | null): { readonly iso: string; readonly day: string; readonly words: string } | null => {
    const age = since ? ageOf(since, now) : null
    return since && age ? { iso: since, day: tools.day(since), words: production.say(age) } : null
  }
  const retryGlance = () => actions?.onAct?.('retryGlance')

  const { headline, strips, people, dates, requests, linked, facts } = model
  const stripsShown = strips.rows.length > 0 || strips.reading || strips.failed !== null
  const peopleTitle = t('customers.overview.people.title')
  const datesTitle = t('customers.overview.dates.title')
  const requestsTitle = t('customers.overview.requests.title')
  const linkedTitle = t('customers.overview.linked.title')
  const bandTitle = t('customers.work.band.all', { customer })

  return (
    <>
      {/* 1 — Where <customer> stands: the sentence, its quiet note, what stops the customer (no strip: nothing is drawn). */}
      <OverviewCard lead title={t('customers.overview.where', { customer })}>
        <Headline sentence={headline.sentence ? headline.sentence.map(said).join(' · ') : null} quiet={headline.quiet ? said(headline.quiet) : null} />
        {stripsShown && (
          <Strips
            label={t('customers.overview.strip.label', { customer })}
            rows={strips.rows.map((strip) => (
              <StripView key={strip.key} strip={strip} words={words} since={ageOfStart(strip.since)} actions={actions} />
            ))}
            reading={strips.reading}
            failed={strips.failed ? { words: said(strips.failed), onRetry: retryGlance } : null}
          />
        )}
      </OverviewCard>

      {/* 2 — All orders of <customer>: the Work tab's band INSIDE a card (S6: as a direct child of the kit's root its own size
          container would be renamed and its phone fold would die). */}
      {model.band !== 'off' && (
        <OverviewCard title={bandTitle}>
          {model.band === 'band' && band ? (
            <WorkBand model={band.model} actions={band.actions} />
          ) : (
            <div className="fw-ro-stack">
              <p className="fw-ro-hint">{t('customers.work.emptyAll', { customer })}</p>
              {before.length > 0 && (
                <p className="fw-ro-hint">
                  {t('customers.work.band.before.label')}{' '}
                  {before.map((part, index) => (
                    <Fragment key={part.part}>
                      {index > 0 && ' · '}
                      {part.href ? (
                        <Link className="fw-ro-link" href={part.href}>
                          {t(`customers.work.band.before.${part.part}`, { count: part.count })}
                        </Link>
                      ) : (
                        t(`customers.work.band.before.${part.part}`, { count: part.count })
                      )}
                    </Fragment>
                  ))}
                </p>
              )}
            </div>
          )}
        </OverviewCard>
      )}

      {/* 3 · 4 — People · Next dates. */}
      <OverviewPair>
        <OverviewCard
          title={peopleTitle}
          aside={
            people.head.door.kind === 'href' ? (
              <Link className="fw-ro-link fw-ro-hint" href={people.head.door.href}>
                {words.doorWords(people.head)}
              </Link>
            ) : null
          }
        >
          <RowList>
            {people.rows.map((row) => (
              <RowView key={row.key} row={row} words={words} unread={kit.unreadMany} actions={actions} />
            ))}
          </RowList>
        </OverviewCard>
        {dates && (
          <OverviewCard title={datesTitle}>
            {dates.reading ? (
              <Skeleton height={44} />
            ) : (
              <RowList label={datesTitle}>
                {dates.rows.map((row) => (
                  <RowView key={row.key} row={row} words={words} unread={kit.unreadMany} actions={actions} />
                ))}
                {dates.failed && (
                  <QuietLine>
                    {said(dates.failed)}{' '}
                    <Button size="sm" variant="quiet" onClick={retryGlance}>
                      {kit.retry}
                    </Button>
                  </QuietLine>
                )}
              </RowList>
            )}
          </OverviewCard>
        )}
      </OverviewPair>

      {/* Until its rows land in People (S10): today's "Who looks after <customer>" card, as it is. */}
      {supervisor}

      {/* 5 · 6 — Requests & changes · Linked records. */}
      <OverviewPair>
        {requests && <RequestsView card={requests} title={requestsTitle} problem={t('problem.unavailable')} words={words} ageOfStart={ageOfStart} actions={actions} />}
        <OverviewCard title={linkedTitle}>
          <RowList label={linkedTitle}>
            {linked.rows.map((row) => (
              <RowView key={row.key} row={row} words={words} unread={kit.unreadMany} actions={actions} />
            ))}
            {linked.none.length > 0 && <QuietLine>{kit.none(linked.none.map(said).join(' · '))}</QuietLine>}
            {linked.quiet.length > 0 && (
              <QuietLine>
                {linked.quiet.map((door, index) => (
                  <Fragment key={door.key}>
                    {index > 0 && ' · '}
                    {door.door.kind === 'href' ? (
                      <Link className="fw-ro-link" href={door.door.href}>
                        {words.doorWords(door)}
                      </Link>
                    ) : (
                      words.doorWords(door)
                    )}
                  </Fragment>
                ))}
              </QuietLine>
            )}
          </RowList>
        </OverviewCard>
      </OverviewPair>

      {/* 7 · 8 — Customer facts · Custom fields (no field applies: it draws nothing and Customer facts takes the row). */}
      <OverviewPair>
        <OverviewCard title={t('customers.overview.facts.title')} aside={facts.edit ? <DoorButton door={facts.edit} words={words} actions={actions} /> : undefined}>
          <FactCols>
            {facts.rows.map((row) => (
              <FactView key={row.key} row={row} words={words} actions={actions} />
            ))}
          </FactCols>
        </OverviewCard>
        {fields}
      </OverviewPair>
    </>
  )
}

/** A door or a button: a real link for an address, the page's own command for an act, the Work tab's window. */
function DoorButton({ door, words, actions, quiet = false, describedBy }: { door: LabelledDoor; words: Words; actions?: OverviewActions | undefined; quiet?: boolean; describedBy?: string }) {
  const label = words.doorWords(door)
  const held = door.held ? words.said(door.held) : null
  const target = door.door
  if (target.kind === 'href') {
    return (
      <Button size="sm" variant={quiet || door.arrow ? 'quiet' : 'secondary'} heldReason={held} aria-describedby={describedBy} asChild>
        <Link href={target.href}>{label}</Link>
      </Button>
    )
  }
  if (target.kind === 'window') {
    return (
      <Button size="sm" variant="quiet" heldReason={held} aria-haspopup="dialog" aria-describedby={describedBy} onClick={() => actions?.onWindow?.(target.window)}>
        {label}
      </Button>
    )
  }
  return (
    <Button size="sm" variant={quiet ? 'quiet' : 'secondary'} heldReason={held} aria-describedby={describedBy} onClick={() => actions?.onAct?.(target.act)}>
      {label}
    </Button>
  )
}

/** One strip: its mark, its words with the age (the day in its tip), its quiet lines, its ONE door or button. */
function StripView({ strip, words, since, actions }: { strip: OverviewStrip; words: Words; since: { readonly iso: string; readonly day: string; readonly words: string } | null; actions?: OverviewActions | undefined }) {
  const doors =
    strip.doors.length > 0 ? (
      <>
        {strip.doors.map((door) => (
          <DoorButton key={door.key} door={door} words={words} actions={actions} />
        ))}
      </>
    ) : undefined
  return (
    <Strip tone={strip.tone} mark={MARK[strip.kind]} doors={doors}>
      <StripSaid title={words.said(strip.title)} since={since} lines={strip.lines.map(words.said)} />
    </Strip>
  )
}

/** A part of a value: plain words, quiet words, or words that are the door ("<value> ›"). */
function PartView({ part, words, actions }: { part: RowPart; words: Words; actions?: OverviewActions | undefined }) {
  const said = words.said(part.say)
  const door = part.door
  if (!door) return part.quiet ? <span className="fw-ro-hint">{said}</span> : <>{said}</>
  const label = words.doorWords({ key: '', label: part.say, arrow: true, door, held: null })
  if (door.kind === 'href') {
    return (
      <Link className="fw-ro-link" href={door.href}>
        {label}
      </Link>
    )
  }
  if (door.kind === 'window') {
    return (
      <Button variant="link" inline aria-haspopup="dialog" onClick={() => actions?.onWindow?.(door.window)}>
        {label}
      </Button>
    )
  }
  return (
    <Button variant="link" inline onClick={() => actions?.onAct?.(door.act)}>
      {label}
    </Button>
  )
}

/** A value: its parts joined by " · ", its tag, then its quiet lines under it. */
function ValueView({ parts, tag, under, words, actions }: { parts: readonly RowPart[]; tag?: OverviewRow['tag']; under?: readonly Say[] | undefined; words: Words; actions?: OverviewActions | undefined }) {
  const line = (
    <span>
      {parts.map((part, index) => (
        <Fragment key={index}>
          {index > 0 && ' · '}
          <PartView part={part} words={words} actions={actions} />
        </Fragment>
      ))}
      {tag && (
        <>
          {' '}
          <Tag tone={tag.tone}>{words.said(tag.say)}</Tag>
        </>
      )}
    </span>
  )
  if (!under || under.length === 0) return line
  return (
    <span className="fw-ro-stack">
      {line}
      {under.map((say, index) => (
        <span key={index} className="fw-ro-hint">
          {words.said(say)}
        </span>
      ))}
    </span>
  )
}

/** One row of People, Next dates or Linked records: the kit's `Row` — label · value · its own buttons. */
function RowView({ row, words, unread, actions }: { row: OverviewRow; words: Words; unread: string; actions?: OverviewActions | undefined }) {
  const doors =
    row.doors && row.doors.length > 0 ? (
      <>
        {row.doors.map((door) => (
          <DoorButton key={door.key} door={door} words={words} actions={actions} quiet />
        ))}
      </>
    ) : undefined
  return (
    <Row label={words.said(row.label)} doors={doors}>
      {row.state === 'reading' ? <Skeleton height={16} width={64} /> : row.state === 'unread' ? <span className="fw-ro-hint">{unread}</span> : <ValueView parts={row.parts} tag={row.tag} under={row.under} words={words} actions={actions} />}
    </Row>
  )
}

/** Requests & changes: the kit's card state while read or failed; else its groups by who waits (words + count · age · door). */
function RequestsView({ card, title, problem, words, ageOfStart, actions }: { card: RequestsCard; title: string; problem: string; words: Words; ageOfStart: (since: string | null) => { readonly iso: string; readonly day: string; readonly words: string } | null; actions?: OverviewActions | undefined }) {
  if (card.state !== 'ready') return <CardState part={title} problem={card.state === 'failed' ? problem : null} onRetry={actions?.onRetryRequests} />
  return (
    <OverviewCard title={title}>
      <Groups>
        {card.groups.map((group) => (
          <Group key={group.key} title={`${words.said(group.title)} · ${group.count}`}>
            {group.rows.map((row) => {
              const age = ageOfStart(row.since)
              return (
                <GroupRow key={row.key} age={<RowAge since={age?.iso ?? null} words={age?.words ?? null} title={age?.day} />} doors={row.door ? <DoorButton door={row.door} words={words} actions={actions} quiet /> : undefined}>
                  {/* The kit wraps what waits in its ONE span (as the order's rows): words, then the count. */}
                  {words.said(row.words)} <b>{row.count}</b>
                </GroupRow>
              )
            })}
          </Group>
        ))}
      </Groups>
    </OverviewCard>
  )
}

/** One fact: the kit's `Fact` — its label (and tag), its value, its step's button (held by state with words). */
function FactView({ row, words, actions }: { row: FactRow; words: Words; actions?: OverviewActions | undefined }) {
  const label = row.labelTag ? (
    <>
      {words.said(row.label)} <Tag tone="neutral">{words.said(row.labelTag)}</Tag>
    </>
  ) : (
    words.said(row.label)
  )
  const value = row.empty ? <span className="fw-ro-hint">{row.parts.map((part) => words.said(part.say)).join(' · ')}</span> : <ValueView parts={row.parts} under={row.under} words={words} actions={actions} />
  const step = row.door
  return (
    <Fact
      wide={row.wide === true}
      label={label}
      value={value}
      door={
        step
          ? (describedBy) => {
              const target = step.door
              // An act of the page: the kit's own Door (held with words); an address (People & addresses): a link in the same place.
              return target.kind === 'act' ? (
                <Door label={words.doorWords(step)} held={step.held ? words.said(step.held) : null} describedBy={describedBy} onClick={() => actions?.onAct?.(target.act)} />
              ) : (
                <DoorButton door={step} words={words} actions={actions} quiet describedBy={describedBy} />
              )
            }
          : null
      }
    />
  )
}
