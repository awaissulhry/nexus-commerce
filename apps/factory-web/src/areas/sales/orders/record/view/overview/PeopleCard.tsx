'use client'

import Link from 'next/link'
import { Button, Skeleton } from '@nexus/ui/primitives'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { formatDate } from '../../../../../../lib/i18n/format' // F-OO-134: a workshop's day
import { WithMessages } from '../../../../../../record-panels/i18n' // F-OO-133: the thread head's words (who answers, and why)
import type { Order } from '../../../api'
import { readOnlyOnPage } from '../../../model' // F-OO-131: Read-only sees no moves (the band's own rule)
import { dayInstant, isFinal } from '../../../model' // F-OO-134
import { planningHref } from '../../../../../../lib/production/work-order-acts/model' // F-OO-134: Open in Planning › (as the band's ⋯)
import { useRecordFrame } from '../../../../../_shared/record-frame/RecordFrame' // F-OP-104: the owner door
import { peopleViewOf, placeLinesOf, placeLineWords, planningWorkOrderOf } from '../../overview/people'
import { answererWordsOf, answerHeldOf, OWNER_WORDS_NS } from '../../overview/people' // F-OO-133
import type { OrderRecordActions, OrderRecordModel } from '../../record-model'
import { PartState } from '../OrderRecordView' // F-OO-131: a failed read says so (never an empty card)
// ---- F-SA-233: People (the production lane's SupervisorFact in place) ----
import { SupervisorFact } from '../../../../../_shared/production-supervisor/view/SupervisorFact'
import { supervisorHeldOf } from '../../../../../_shared/production-supervisor/model' // F-OO-132: why Change… waits
import { NOTES_NS, openHeld as noteHeld } from '../../../../../production/_shared/notes/model'
import { FollowersDoor } from '../Discuss' // F-SA-266
import { askPresetOf, askStarterOf } from '../../production/asks' // F-PT-103b: the ready ask
import { readOf } from '../../overview/model' // F-PT-103b: the promise the starter names
import './people.css' // F-OO-131: the supervisor's own doors (F-CO-K2: the list is the kit's)
import { OverviewCard } from '../../../../../../lib/record-overview/Overview' // F-CO-K1: the card's frame is the shared overview kit's
import { Row, RowList } from '../../../../../../lib/record-overview/Overview' // F-CO-K2: its rows are the kit's ONE list

/**
 * F-OO-100 (order overview lane: one file per card) — moved out of OverviewTab.tsx unchanged.
 *
 * O3 People (P3): the supervisor (SupervisorFact: Change… with production.brand.manage, Ask with threads.post), the customer's backup,
 * who answers the customer (the order thread's owner: there is no other sales owner), where it is made — places only (site · line ·
 * team, or an outside workshop). No operator, no team member, no per-person output (Statuto art. 4). The people part needs
 * workorders.view (its names stay inside this record); without it: held in words, never "Not set".
 *
 * F-OO-131 (10-design §3; review F15): one aligned list — the label on the left, the value, one door on the right — Supervisor,
 * Backup (a link: it is set for the whole customer, on its page), Answers the customer, Where it is made; "Followers ›" in the
 * head. "Made by" went to Order facts (F-OO-209) and "Told about changes" to the foot of Requests & changes (F-OO-205): one place
 * per fact. Read-only sees no moves; a failed read says so with Try again.
 * F-CO-K2: the list and its rows are the shared overview kit's ONE list (`RowList`, `Row`: the doors cell only where a row has a door).
 */
export function PeopleCard(props: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  // F-OO-133: "Answers the customer" says who and why in the thread head's words — its catalogue comes with the card (the design index
  // draws the card without the dock that loads it).
  return (
    <WithMessages namespaces={[OWNER_WORDS_NS]}>
      <PeopleBody {...props} />
    </WithMessages>
  )
}

function PeopleBody({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const notes = useT(NOTES_NS)
  const head = useT(OWNER_WORDS_NS) // F-OO-133
  const locale = useLocale() // F-OO-134
  const frame = useRecordFrame() // F-OP-104: "Answers the customer · Change…" is the conversation's owner door
  const customer = order.party?.legalName ?? ''
  const view = peopleViewOf(model.production)
  if (view.status === 'failed') return <PartState problem={view.problem} label={t('overview.people.title')} onRetry={() => actions?.onRetryProduction?.()} />
  // F-OO-131: Read-only (no acting right on the page) sees the facts and the links, never a door.
  const readOnly = readOnlyOnPage(model.can, { assignSupervisor: model.people?.mayAssign, qualityHold: model.workOrderActs?.can.qualityHold })
  const askWait = model.people ? noteHeld(model.people.mayNote, 1) : null
  // F-OO-133: Change… (the owner door) held where it cannot save: no conversation on this page (the frame offers its doors only with
  // one), or no right to write in it.
  const answerHeld = answerHeldOf({ thread: !!frame?.discuss && !!frame.openDoor, mayWrite: model.people ? model.people.mayNote : null })
  // F-OO-134: Planning's board at the first live work order (planning.view; not on a final order) — a link, so Read-only keeps it.
  const planning = planningWorkOrderOf(order.chain.workOrders, { plan: !!model.workOrderActs?.can.planning, final: isFinal(order) })
  const day = (value: string) => formatDate(dayInstant(value), { locale })
  return (
    // F-SA-265 / F-SA-266: who is told about this order — the thread's followers (the frame's door); F-OO-131: in the head.
    // F-OO-135: "Followers · 4 ›" — the count the dock reported to the frame; no conversation on the page: no door (the head row stays).
    <OverviewCard className="fw-so-people" title={t('overview.people.title')} aside={<FollowersDoor />}>
      {view.status === 'loading' ? (
        <Skeleton height={44} />
      ) : view.status === 'withheld' ? (
        <p className="fw-so-hint">{t('overview.people.held')}</p>
      ) : (
        <RowList>
          <Row label={t('people.supervisor')}>
            {/* F-OO-132: the row face — the value and the doors in this row's columns; Change… held in its own words (no right, the
                order waits for its yes, the order left production); Read-only gets no door. */}
            <SupervisorFact
              face="row"
              fact={view.people.supervisor ? { kind: 'person', name: view.people.supervisor.name, active: view.people.supervisor.active, from: view.people.supervisor.from, me: view.people.supervisor.me, muted: false } : { kind: 'notSet' }}
              held={supervisorHeldOf(!!model.people?.mayAssign, order.status)}
              {...(readOnly ? {} : { onChange: () => actions?.people?.onAssign?.() })}
              /* F-PT-103b (lead): one path per job — the SAME ready ask as Production now and the band ⋯ ("Ask for an update…"). */
              {...(model.people && !readOnly ? { ask: { label: notes('open.askFact'), held: askWait ? notes(askWait.key, askWait.params) : null, onAsk: () => actions?.people?.onAsk?.(askPresetOf(t, askStarterOf({ number: order.number, promise: readOf(model.production)?.headline?.promise.date ?? order.promiseDate }, day))) } } : {})}
            />
          </Row>
          {/* F-OP-104: the backup is the customer's own setting (for every order of it): read here, changed on its page.
              Walk #12: its link says where it goes ("Open the customer ›"), never "Change" to a reader who may not, and it wraps (never cut). */}
          <Row label={t('overview.people.backup')}>
            <span className="fw-so-stack-tight">
              <span>{view.people.backup ? `${view.people.backup.name} · ${t('doors.backupFor', { customer })}` : '—'}</span>
              <Link className="fw-so-link fw-so-hint" href={`${model.prefix}/sales/customers/${encodeURIComponent(order.partyId)}`}>
                {t('doors.backupElsewhere', { customer })}
              </Link>
            </span>
          </Row>
          {/* F-OP-104: who answers the customer is the order conversation's owner — its own dialog, opened from here (the frame's door).
              F-OO-133: the real answerer and why (the owner chain, B-OO-008: "Bea Esempio · the order's supervisor"); Change… held in
              words where the door cannot save. Once the dock changed the owner the page reads People again (no event: OrderRecord's
              onOwnerChanged). */}
          <Row
            label={t('overview.people.answers')}
            doors={
              readOnly ? undefined : (
                <Button size="sm" variant="quiet" heldReason={answerHeld ? (answerHeld.ns === 'orders' ? t(answerHeld.key) : head(answerHeld.key, answerHeld.params)) : null} onClick={() => frame?.openDoor?.('owner')}>
                  {t('doors.change')}
                </Button>
              )
            }
          >
            <span>{answererWordsOf(view.people.answersCustomer, head)}</span>
          </Row>
          {/* F-OO-134: one line per place — a plant line, or an outside workshop since the day its job went out; derived from the plan
              and never set here ("(from the plan)"); Open in Planning › where the line, the workshop and the start are planned. */}
          <Row
            label={t('overview.people.where')}
            doors={
              planning ? (
                <Link className="fw-so-link" href={planningHref(model.prefix, planning)}>
                  {t('wo.link.planning')}
                </Link>
              ) : undefined
            }
          >
            {view.people.places.length > 0 ? (
              <span className="fw-so-stack-tight">
                {placeLinesOf(view.people.places).map((line, index) => (
                  <span key={`${line.kind}-${index}`}>{placeLineWords(line, t, day)}</span>
                ))}
                <span className="fw-so-hint">{t('dates.fromPlan')}</span>
              </span>
            ) : (
              <span>{t('overview.people.notPlanned')}</span>
            )}
          </Row>
        </RowList>
      )}
    </OverviewCard>
  )
}
