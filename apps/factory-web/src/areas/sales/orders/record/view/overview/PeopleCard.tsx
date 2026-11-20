'use client'

import Link from 'next/link'
import { Card } from '@nexus/ui/components'
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
import './people.css' // F-OO-131: the card's own rows

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
 */
export function PeopleCard(props: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  // F-OO-133: "Answers the customer" says who and why in the thread head's words — its catalogue comes with the card (the design index
  // draws the card without the dock that loads it).
  return (
    <WithMessages namespaces={[OWNER_WORDS_NS]}>
      <People {...props} />
    </WithMessages>
  )
}

function People({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
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
    <Card padded className="fw-so-people">
      <div className="fw-so-card-head">
        <h2 className="fw-so-h2">{t('overview.people.title')}</h2>
        {/* F-SA-265 / F-SA-266: who is told about this order — the thread's followers (the frame's door); F-OO-131: in the head. */}
        <FollowersDoor />
      </div>
      {view.status === 'loading' ? (
        <Skeleton height={44} />
      ) : view.status === 'withheld' ? (
        <p className="fw-so-hint">{t('overview.people.held')}</p>
      ) : (
        <ul className="fw-so-people-list">
          <li className="fw-so-ov-row">
            <span className="fw-so-people-label">{t('people.supervisor')}</span>
            {/* F-OO-132: the row face — the value and the doors in this row's columns; Change… held in its own words (no right, the
                order waits for its yes, the order left production); Read-only gets no door. */}
            <SupervisorFact
              face="row"
              fact={view.people.supervisor ? { kind: 'person', name: view.people.supervisor.name, active: view.people.supervisor.active, from: view.people.supervisor.from, me: view.people.supervisor.me, muted: false } : { kind: 'notSet' }}
              held={supervisorHeldOf(!!model.people?.mayAssign, order.status)}
              {...(readOnly ? {} : { onChange: () => actions?.people?.onAssign?.() })}
              {...(model.people && !readOnly ? { ask: { label: notes('open.askFact'), held: askWait ? notes(askWait.key, askWait.params) : null, onAsk: () => actions?.people?.onAsk?.() } } : {})}
            />
          </li>
          {/* F-OP-104: the backup is the customer's own setting (for every order of it): read here, changed on its page. */}
          <li className="fw-so-ov-row">
            <span className="fw-so-people-label">{t('overview.people.backup')}</span>
            <span className="fw-so-stack-tight">
              <span>{view.people.backup ? `${view.people.backup.name} · ${t('doors.backupFor', { customer })}` : '—'}</span>
              <Link className="fw-so-link fw-so-cell-sub" href={`${model.prefix}/sales/customers/${encodeURIComponent(order.partyId)}`}>
                {t('doors.backupElsewhere', { customer })}
              </Link>
            </span>
          </li>
          {/* F-OP-104: who answers the customer is the order conversation's owner — its own dialog, opened from here (the frame's door).
              F-OO-133: the real answerer and why (the owner chain, B-OO-008: "Bea Esempio · the order's supervisor"); Change… held in
              words where the door cannot save. Once the dock changed the owner the page reads People again (no event: OrderRecord's
              onOwnerChanged). */}
          <li className="fw-so-ov-row">
            <span className="fw-so-people-label">{t('overview.people.answers')}</span>
            <span>{answererWordsOf(view.people.answersCustomer, head)}</span>
            {!readOnly && (
              <span className="fw-so-ov-doors">
                <Button size="sm" variant="quiet" heldReason={answerHeld ? (answerHeld.ns === 'orders' ? t(answerHeld.key) : head(answerHeld.key, answerHeld.params)) : null} onClick={() => frame?.openDoor?.('owner')}>
                  {t('doors.change')}
                </Button>
              </span>
            )}
          </li>
          {/* F-OO-134: one line per place — a plant line, or an outside workshop since the day its job went out; derived from the plan
              and never set here ("(from the plan)"); Open in Planning › where the line, the workshop and the start are planned. */}
          <li className="fw-so-ov-row">
            <span className="fw-so-people-label">{t('overview.people.where')}</span>
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
            {planning && (
              <span className="fw-so-ov-doors">
                <Link className="fw-so-link" href={planningHref(model.prefix, planning)}>
                  {t('wo.link.planning')}
                </Link>
              </span>
            )}
          </li>
        </ul>
      )}
    </Card>
  )
}
