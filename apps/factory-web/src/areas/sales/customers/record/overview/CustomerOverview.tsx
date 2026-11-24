'use client'

import { useMemo, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { withheldParts } from '@nexus/factory-domain/sales/customer-360/glance'
import { useOfficeSession } from '../../../../../lib/session/context'
import { romeToday } from '../../../../finance/costing/model'
import type { Party } from '../../../../parties/_shared/api'
import type { PartyRecordModel } from '../../../../parties/_shared/model'
import type { PartyRecordActions } from '../../../../parties/_shared/view/PartyRecordView'
import { useCustomerGlance } from '../../depth/CustomerDepth'
import type { CustomersWorkModel } from '../../list/model'
import type { CustomerMoneyModel } from '../../money/overview'
import { useWhoLooksAfter } from '../../portal/CustomerSupervisor' // F-CO-201: who looks after, read ONCE (People + the urgency strip)
import { DesignerWindow, SupervisorWindow } from '../../portal/view/CustomerSupervisorCard' // F-CO-201: People's two Change… windows
import { beforeLineOf, type BeforeOrderCounts } from '../before-order'
import type { PageCounts } from '../quotes-tab/use-before-order-counts'
import type { WorkReads } from '../use-customer-work'
import { CustomerOverviewView, type OverviewActions } from '../view/overview/CustomerOverviewView'
import type { WorkBandActions, WorkBandModel } from '../view/WorkBand'
import { bandOf, whysOf } from '../work-band'
import { customerHref, groupDoor, tabDoor, workOrdersDoor } from './doors'
import { standingOf, urgencyOf, type LooksAfter, type OverviewAct, type OverviewCan, type OverviewInput } from './model'
import { overviewOf } from './rows'

/**
 * F-CO-102 (customer page › Overview; 13-backend §3.1–§3.3; lead settles S6, S10, S11) — the Overview tab's container: it builds
 * the tab's model from the reads the page ALREADY holds and hands down the page's own commands. It makes no read of its own:
 *
 *   the party, its rights, the acts      the record's (Edit, the tax identity dialogs, Check VIES)
 *   the five work reads                  the Work tab's (`work.reads`): the board, requests, replies, our asks, tasks
 *   the before-order counts              the page's ONE count read
 *   the money reads                      the record's (ageing, returns, complaints, the open orders' deposits)
 *   the glance                           the depth provider's ONE read (`useCustomerGlance`)
 *   the standing                         THIS customer's row of the joined read (the page asks it only on this tab, only with
 *                                        orders.view): the next promise over every company, the last order, Priority Top / High,
 *                                        the customer-urgent count
 *
 * Card 2 is the Work tab's band (`bandOf`, `whysOf`, `beforeLineOf`: no chips, no group pressed): a group's press is a door into
 * Work on exactly its orders. The two windows open ON the Work tab (`onWindow`: the page goes there first).
 * F-CO-201 (co-w2 W2.1; S10): "Who looks after" is read here ONCE (`useWhoLooksAfter`, partners.view): People's rows, and the
 * customer's urgency for its strip. People's two Change… open the page's own windows, mounted here: the supervisor's form
 * (`SupervisorWindow`) and the factory designer's (`DesignerWindow`, today's own window).
 */
export interface CustomerOverviewProps {
  readonly party: Party
  readonly model: PartyRecordModel
  readonly actions?: PartyRecordActions | undefined
  readonly reads: WorkReads
  readonly counts: PageCounts
  /** The band's "Before an order" parts (the page's own mapping of the count read: none for a reader without Quotes & incoming). */
  readonly before: BeforeOrderCounts
  readonly money: CustomerMoneyModel
  readonly standing: CustomersWorkModel
  readonly onWindow: (window: 'customer' | 'tasks') => void
  /** The work reads again (a failed band, a failed Requests & changes). */
  readonly onRetry: () => void
  readonly fields?: ReactNode
}

export function CustomerOverview({ party, model, actions, reads, counts, before, money, standing, onWindow, onRetry, fields }: CustomerOverviewProps) {
  const router = useRouter()
  const glance = useCustomerGlance()
  const looksAfter = useWhoLooksAfter(party.id)
  const [supervisorOpen, setSupervisorOpen] = useState(false)
  const session = useOfficeSession()
  // The glance's parts this reader may read — the API's own rule (the domain's PART_PERMISSIONS), so a failed glance still knows them.
  const withheld = useMemo(() => withheldParts((permission) => session.permissions.includes(permission)), [session.permissions])
  const today = useMemo(() => romeToday(), [])
  const { prefix } = model
  const id = party.id
  // Each part and each act reads its OWN right (the record's and the money reads' own).
  const can: OverviewCan = {
    orders: model.can.orders,
    quotesTab: model.can.quotes || model.can.inquiries === true,
    moneyTab: model.can.money === true,
    receivables: money.can.receivables,
    price: model.can.price,
    returns: money.can.returns,
    complaints: money.can.complaints,
    partners: model.can.partners === true,
    manage: model.can.manage,
    block: model.can.block,
    vies: model.can.vies,
    workorders: model.can.workorders === true,
    samples: !withheld.includes('samples'),
    repairs: !withheld.includes('repairs'),
    credit: !withheld.includes('credit'),
  }
  // F-CO-201: who looks after, as its hooks hold it (null without partners.view: never read).
  const looks: LooksAfter | null = looksAfter.supervisor ? { supervisor: looksAfter.supervisor.model, designer: looksAfter.designer?.model ?? null } : null
  const input: OverviewInput = {
    prefix,
    party,
    can,
    today,
    reads,
    counts: { counts: counts.counts, failed: counts.failed },
    glance: glance.read,
    money: { ageing: money.ageing, returns: money.returns, complaints: money.complaints, orders: money.orders ?? null, returnsHref: money.returnsHref },
    standing: standingOf(can.orders, standing, id),
    // F-CO-201: the customer's own urgency — the SAME production read as People's supervisor (partners.view; off without).
    urgency: urgencyOf(looks),
    looksAfter: looks,
    projects: model.can.projects ? (model.projects ?? null) : null,
    viesRunning: model.viesRunning === true,
  }
  const overview = overviewOf(input)

  // Card 2: the Work tab's band, as the Work tab builds it — no chips, no group pressed; a press is a door into Work.
  const recordHref = customerHref(prefix, id)
  const beforeLine = beforeLineOf(before, recordHref)
  const band: WorkBandModel = { customer: overview.customer, picture: bandOf(reads.board), shown: null, whys: whysOf(reads.board), before: beforeLine, chips: [], workOrdersHref: can.workorders ? workOrdersDoor(prefix, id) : null }
  const bandActions: WorkBandActions = {
    onGroup: (group) => {
      const address = groupDoor(prefix, id, group.door)
      if (address) router.push(address)
    },
    onAll: () => router.push(tabDoor(prefix, id, 'work')),
    onRetry: () => onRetry(),
  }

  const onAct = (act: OverviewAct) => {
    if (act === 'edit') actions?.onDialog?.({ kind: 'edit' })
    else if (act === 'identity') actions?.onDialog?.({ kind: 'identity', mode: 'new' })
    else if (act === 'correctIdentity') actions?.onDialog?.({ kind: 'identity', mode: 'correct' })
    else if (act === 'checkVies') actions?.onCheckVies?.()
    else if (act === 'changeSupervisor') setSupervisorOpen(true) // F-CO-201
    else if (act === 'changeDesigner') looksAfter.designer?.actions.onChange?.()
    else if (act === 'retryPeople') looksAfter.supervisor?.actions.onRetry?.()
    else if (act === 'retryDesigner') looksAfter.designer?.actions.onRetry?.()
    else glance.onRetry()
  }
  const overviewActions: OverviewActions = {
    onAct,
    onWindow,
    onRetryRequests: () => {
      onRetry()
      counts.onRetry()
    },
  }
  return (
    <>
      <CustomerOverviewView model={overview} band={can.orders ? { model: band, actions: bandActions } : null} before={beforeLine} actions={overviewActions} fields={fields} />
      {/* F-CO-201: People's two Change… windows — the page's own, mounted while open. */}
      {supervisorOpen && looksAfter.supervisor && <SupervisorWindow model={looksAfter.supervisor.model} actions={looksAfter.supervisor.actions} name={overview.customer} onClose={() => setSupervisorOpen(false)} />}
      {looksAfter.designer && <DesignerWindow model={looksAfter.designer.model} actions={looksAfter.designer.actions} name={overview.customer} />}
    </>
  )
}
