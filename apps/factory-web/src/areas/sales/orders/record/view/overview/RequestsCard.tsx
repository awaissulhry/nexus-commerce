'use client'

import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import type { Order } from '../../../api'
import { readOnlyOnPage } from '../../../model' // F-OO-205: Read-only sees no moves (the band's own rule)
import type { OrderRecordActions, OrderRecordModel } from '../../record-model'
import { PartState } from '../OrderRecordView'
// F-OP-103: the ONE waiting list — each row with its one door. F-OO-204: the rows, their age and the ONE Still to do door.
import { RowAge, StillDoorView, WaitingRowItem } from '../RequestsSection'
import { changesBadgeOf, readOf, type WaitingState } from '../../overview/model' // F-OP-301 (walk #1–#3): the ONE call of the waiting list (made by OverviewTab)
import type { StillRowOf } from '../../changes/model'
import { stillWordsOf } from '../../changes/waiting' // fx6 (walk 7)
import { said } from '../../../../../home/approvals/requests/model'
import { TEAM_WORDS, type ApplyTeam } from '@nexus/factory-domain/sales/change-requests/apply-plan'
import { useSearchParams } from 'next/navigation'
import { tabHref } from '../../../../../_shared/record-frame/address'
import { TabLink } from '../../../../../../lib/tab-link/TabLink'
import { OverviewCard } from '../../../../../../lib/record-overview/Overview' // F-CO-K1: the card's frame is the shared overview kit's
// ---- F-CO-K2: the groups and their rows are the kit's parts (their look comes with them: the card has no stylesheet of its own) ----
import { Group, GroupRow, Groups } from '../../../../../../lib/record-overview/Overview'
import { GROUP_ROWS_SHOWN } from '../../../../../../lib/record-overview/model'
// ---- end F-CO-K2

/** F-OO-205 (11-design §5.2, Q10): the rows a customer's or a Still to do group shows before "N more on Changes ›"; every row waiting on us shows. F-CO-K2: the kit's cap. */
export const REQUESTS_SHOWN = GROUP_ROWS_SHOWN

/**
 * F-OO-100 (order overview lane: one file per card) — moved out of OverviewTab.tsx.
 *
 * O5 Requests & changes — F-OO-205 (11-design §5.2; review F15): a to-do list grouped by who waits, from the ONE waiting list (its
 * requests only: the holds are Where it is now's, the dates Next dates'):
 *
 *   Waiting on us · N            every row, each `words | age | door` (Answer…, Reply in the thread, the yes)
 *   Waiting on <customer> · N    the first 3 (our counter-offer: Open…; what we asked: Their turn), then "N more on Changes ›"
 *   Still to do · N              the first 3 (the ONE Still to do door), then "N more on Changes ›"
 *
 * "Changes (N) ›" in the head is the Changes badge's own number. Nothing to answer: "No request or change waits", and where the
 * order's holds and dates are when it has some (never "Nothing waits" while one does). The foot's quiet line: "Told about changes:
 * N people" (F-SA-244's count, moved from People). Read-only sees the words and the ages, no door. No "Latest change" (Changes ›
 * History tells it).
 * F-CO-K2: the groups, each group and each row are the shared overview kit's `Groups`, `Group`, `GroupRow` (the order's age stays
 * RequestsSection's `RowAge`, its words over the kit's).
 */
export function RequestsCard({ order, model, actions, waiting }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions; waiting: WaitingState }) {
  const t = useT('orders')
  const search = useSearchParams()?.toString() ?? '' // F-OP-210: the tab links keep the dock's scope
  const changes = tabHref(`${model.prefix}/sales/orders/${order.id}`, 'changes', search)
  const customer = order.party?.legalName ?? ''
  // F-OP-301 (walk #3): while the production read is out the card says it reads (never "Nothing waits" before it); failed: so said.
  if (waiting.status !== 'ready') return <PartState problem={waiting.status === 'failed' ? waiting.problem : null} label={t('overview.requests.title')} onRetry={() => actions?.onRetryProduction?.()} />
  const card = waiting.card
  const readOnly = readOnlyOnPage(model.can, { assignSupervisor: model.people?.mayAssign, qualityHold: model.workOrderActs?.can.qualityHold })
  const asOf = readOf(model.production)?.asOf ?? null
  // F-SA-244 (P8, R2): how many office people were told about this order's changes (each once) — never who read anything.
  const told = model.told?.value && model.told.value.changes.length > 0 ? model.told.value.people : null
  const more = (left: number, href: string) =>
    left > 0 ? (
      <TabLink className="fw-so-link fw-so-hint fw-so-rq-more" href={href}>
        {t('requests.more', { count: left })}
      </TabLink>
    ) : null
  return (
    <OverviewCard
      className="fw-so-rq"
      title={t('overview.requests.title')}
      aside={
        <TabLink className="fw-so-link fw-so-hint" href={changes}>
          {t('requests.changesCount', { count: changesBadgeOf(card) })}
        </TabLink>
      }
    >
      {card.nothing ? (
        <div className="fw-so-stack-tight">
          <p className="fw-so-hint">{t('overview.requests.nothing')}</p>
          {/* F-OO-205: the order's holds and dates are not requests — said where they are, so nothing reads as "nothing waits". */}
          {(waiting.holds.length > 0 || waiting.dates.length > 0) && (
            <p className="fw-so-hint">{[waiting.holds.length > 0 ? t('requests.seeHolds') : null, waiting.dates.length > 0 ? t('requests.seeDates') : null].filter(Boolean).join(' · ')}</p>
          )}
        </div>
      ) : (
        <Groups>
          {card.onUs.length > 0 && (
            <Group title={t('waiting.onUs', { count: card.onUs.length })}>
              {card.onUs.map((row) => (
                <WaitingRowItem key={row.key} row={row} order={order} model={model} actions={actions} readOnly={readOnly} />
              ))}
            </Group>
          )}
          {card.onCustomer.length > 0 && (
            <Group title={t('waiting.onCustomer', { count: card.onCustomer.length, customer })} more={more(card.onCustomer.length - REQUESTS_SHOWN, changes)}>
              {card.onCustomer.slice(0, REQUESTS_SHOWN).map((row) => (
                <WaitingRowItem key={row.key} row={row} order={order} model={model} actions={actions} readOnly={readOnly} />
              ))}
            </Group>
          )}
          {card.still.length > 0 && (
            <Group title={t('overview.requests.still', { count: card.still.length })} more={more(card.still.length - REQUESTS_SHOWN, `${changes}#still-to-do`)}>
              {card.still.slice(0, REQUESTS_SHOWN).map((row, index) => (
                <StillItem key={`${row.kind}:${row.ref?.id ?? index}`} row={row} order={order} model={model} actions={actions} asOf={asOf} readOnly={readOnly} />
              ))}
            </Group>
          )}
        </Groups>
      )}
      {told !== null && <p className="fw-so-hint fw-so-rq-foot">{t('told.aboutChanges', { count: told })}</p>}
    </OverviewCard>
  )
}

/**
 * A Still to do row on the card: the step and who does it, its age, its door (the ONE StillDoorView, held in its own words). The
 * state pill is Changes' own: the held words already say whose turn it is.
 */
function StillItem({ row, order, model, actions, asOf, readOnly }: { row: StillRowOf; order: Order; model: OrderRecordModel; actions?: OrderRecordActions; asOf: string | null; readOnly: boolean }) {
  const t = useT('orders')
  const locale = useLocale()
  const team = TEAM_WORDS[row.waitingOn as ApplyTeam]
  // F-CO-K2: the kit's GroupRow — the words in one span, the age, the doors cell (empty for Read-only).
  return (
    <GroupRow age={<RowAge since={row.since} asOf={asOf} />} doors={readOnly ? null : <StillDoorView row={row} order={order} model={model} actions={actions} />}>
      {stillWordsOf(row, model.orderChanges?.list?.value, order.lines, t, locale) /* fx6 (walk 7): the ONE sentence, as Changes */}
      {team && row.kind !== 'WORK_ORDER_CHANGE' ? <span className="fw-so-hint">{` · ${said(team, locale)}`}</span> : null}
    </GroupRow>
  )
}
