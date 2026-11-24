'use client'

import { useEffect, type ReactNode } from 'react'
import Link from 'next/link'
import { CircleAlert } from 'lucide-react' // F-SA-276: the Work tab's mark (something waits on us)
import { Tabs, type MenuItemDef, type TabItem } from '@nexus/ui/components'
import { Button } from '@nexus/ui/primitives'
import { WithMessages } from '../../../../../record-panels/i18n'
import { useT } from '../../../../../lib/i18n/provider'
import type { Party } from '../../../../parties/_shared/api'
import { identitiesOf, partyName, recordTabs, sideHref, SIDES, writable, type PartyRecordModel, type RecordTab } from '../../../../parties/_shared/model'
import { shownTab } from '../../../../parties/_shared/model' // F-CQ-301 (P0-B2)
import { PartyRecordGate, usePartyBand, type PartyRecordActions, type SupplierDepth } from '../../../../parties/_shared/view/PartyRecordView'
import { IdentityCard, PartyDialogs, PartyNotices, ShowThreadOnArrival, ViesCard } from '../../../../parties/_shared/view/cards' // F-CA-119: the contacts and addresses cards stay the supplier's
import { PartiesMessages } from '../../../../parties/_shared/view/parts'
import { RecordFrame } from '../../../../_shared/record-frame/RecordFrame'
import { rightRef } from '../../../../../lib/i18n/rights' // F-SA-271
import { CUSTOMER_MONEY_NAMESPACE } from '../../money/model'
import type { CustomerMoneyModel } from '../../money/overview'
import { moneyBadgeOf, pagePartsOf } from '../money/balance' // F-CM-104: the tab's count (late invoices + late deposit requests)
import { romeToday } from '../../../../finance/costing/model' // F-CM-104
import { OverviewNotices } from './overview/Notices' // F-CO-103: the Overview's notices (no Blocked / Archived banner on that tab)

/**
 * SCR-033 Customer record (design sales.customers "records: Customer"; F-SA-270, sales page plan N5, picks P10, R5): the customer's
 * own view, split from the supplier's (areas/parties/_shared/view/PartyRecordView.tsx draws the supplier's record, unchanged). The
 * record's reads and writes are the shared hook's (usePartyRecord); the band, the notices, the cards and the dialogs are the shared
 * ones (PartyRecordView's usePartyBand and PartyRecordGate, ./cards). On RecordFrame with the customer's thread docked (B-TH-260).
 * Terms & requirements adds the customer's Commercial terms card (B-W2a-49, `terms`); the Money tab's numbers come from `money`
 * (B-W2a-81); the customer in depth from `depth` (B-W2b-324).
 * F-CO-103 (customer page › Overview): the Overview is its own tab body, built by the container from the shared overview kit's
 * parts (`overviewTab`: ./overview/CustomerOverviewView.tsx) — as Work and Quotes & incoming are; on that tab the thread docks a
 * third and the notice area leaves the Blocked / Archived banner to the tab's headline and first strip.
 * Fetches nothing: areas/sales/customers/record/CustomerRecord.tsx reads and writes; a design case passes made-up models.
 */
export function CustomerRecordView({
  model,
  actions,
  thread,
  printThread,
  overviewTab, // F-CO-103
  terms,
  portal,
  money: moneyModel,
  depth,
  onAddTask,
  taskDialog,
  peopleTab, // F-CA-119
  peopleBadge, // F-CA-119
  peopleNotice, // F-CA-119
  work,
  workCount,
  quotesIncoming,
  threadButton,
  onNewOrder,
  onImport,
  priceDiffer, // F-CP-141
  quotesBadge, // F-CQ-302
  quotesTabNote, // F-CQ-306
  moneyTab, // F-CM-104
  moneyTabNote, // F-CM-104
}: {
  model: PartyRecordModel
  actions?: PartyRecordActions
  /** B-TH-260: the customer's docked thread (a design case's; the page mounts OfficeRecordThread). */
  thread?: ReactNode
  printThread?: ReactNode
  /**
   * F-CO-103: the Overview tab (the customer's standing, the bigger picture, People, Next dates, Requests & changes, Linked records,
   * Customer facts with the custom fields beside them — drawn by the container or a design case from the shared overview kit).
   */
  overviewTab?: ReactNode
  terms?: ReactNode
  /** B-W2b-180: Portal access (`?tab=portal`). */
  portal?: ReactNode
  money?: CustomerMoneyModel | null
  /** B-W2b-324: the customer in depth (the shared record's `depth` slot), drawn from made-up models in the design. */
  depth?: SupplierDepth
  /** F-SA-271: the band's ⋯ "Add task for <customer>…" (the record's New task dialog, drawn by the container). */
  onAddTask?: () => void
  taskDialog?: ReactNode
  // F-CA-119 (customer page › People & addresses, lane ca-; 13-backend §5.4; Z4, Z15): the tab (drawn by the container or a design case),
  // its count (the addresses waiting for our check; null: none) and its notices in the record's ONE notice area.
  peopleTab?: ReactNode
  peopleBadge?: { readonly count: number; readonly attention: boolean } | null
  peopleNotice?: ReactNode
  // F-CA-119: end
  /** F-SA-276: the Work tab (the waiting strip and the Orders sheet locked to the customer, drawn by the container). */
  work?: ReactNode
  /** F-SA-276: the Work tab's count — what waits on us (requests to answer + replies waiting on us); null while read. */
  workCount?: { readonly count: number | null; readonly attention: boolean } | null
  /** F-SA-277: Quotes & incoming (the customer's quotes, then its incoming requests: each its own list, drawn by the container). */
  quotesIncoming?: ReactNode
  /** F-SA-279: below 1280 px the band's button names the record the dock holds ("Thread · SO-…"); null: "Thread". */
  threadButton?: string | null
  /** F-CP-104: the band's New order and ⋯ Import orders for <customer>… open on this page (the container asks the Work sheet); absent: the old doors. */
  onNewOrder?: () => void
  onImport?: () => void
  /** F-CP-141: how many of the customer's orders read Not equal (a price holder's only; null: none read, or no price grain). */
  priceDiffer?: number | null
  /** F-CQ-302 (13-backend R13; 10-design §2.5): Quotes & incoming's badge — what waits on us there (To answer + Accepted, order waits),
   *  from the page's ONE count read, marked when > 0; null while it is read; absent: the old count of the newest quotes. */
  quotesBadge?: { readonly count: number | null; readonly attention: boolean } | null
  /** F-CQ-306 (cq fx3 W2-1b): the reader asked for Quotes & incoming, a tab it may not open: the Work tab shows, with one line why. */
  quotesTabNote?: boolean
  /** F-CM-104 (cm-w1 W1.4): the Money tab (the answer line, Balance, To collect…, drawn by the container or a design case). */
  moneyTab?: ReactNode
  /** F-CM-104 (Z27): the reader asked for Money, a tab it may not open: the Work tab shows, with one line why. */
  moneyTabNote?: boolean
}) {
  return (
    <WithMessages namespaces={[CUSTOMER_MONEY_NAMESPACE]}>
      <PartiesMessages>
        <Customer model={{ ...model, side: 'customers' }} actions={actions} thread={thread} printThread={printThread} overviewTab={overviewTab /* F-CO-103 */} terms={terms} portal={portal} money={moneyModel ?? null} depth={depth} onAddTask={onAddTask} taskDialog={taskDialog} peopleTab={peopleTab /* F-CA-119 */} peopleBadge={peopleBadge /* F-CA-119 */} peopleNotice={peopleNotice /* F-CA-119 */} work={work} workCount={workCount} quotesIncoming={quotesIncoming} threadButton={threadButton ?? null} onNewOrder={onNewOrder} onImport={onImport} priceDiffer={priceDiffer ?? null /* F-CP-141 */} quotesBadge={quotesBadge /* F-CQ-302 */} quotesTabNote={quotesTabNote /* F-CQ-306 */} moneyTab={moneyTab /* F-CM-104 */} moneyTabNote={moneyTabNote /* F-CM-104 */} />
      </PartiesMessages>
    </WithMessages>
  )
}

interface CustomerProps {
  model: PartyRecordModel
  actions?: PartyRecordActions | undefined
  thread?: ReactNode
  printThread?: ReactNode
  overviewTab?: ReactNode // F-CO-103
  terms?: ReactNode
  portal?: ReactNode
  money: CustomerMoneyModel | null
  depth?: SupplierDepth | undefined
  onAddTask?: (() => void) | undefined
  taskDialog?: ReactNode
  peopleTab?: ReactNode // F-CA-119
  peopleBadge?: { readonly count: number; readonly attention: boolean } | null | undefined // F-CA-119
  peopleNotice?: ReactNode // F-CA-119
  work?: ReactNode // F-SA-276
  workCount?: { readonly count: number | null; readonly attention: boolean } | null | undefined
  quotesIncoming?: ReactNode // F-SA-277
  threadButton?: string | null // F-SA-279
  onNewOrder?: (() => void) | undefined // F-CP-104
  onImport?: (() => void) | undefined // F-CP-104
  priceDiffer?: number | null // F-CP-141
  quotesBadge?: { readonly count: number | null; readonly attention: boolean } | null | undefined // F-CQ-302
  quotesTabNote?: boolean // F-CQ-306: the reader asked for Quotes & incoming, a tab it may not open (the page shows Work)
  moneyTab?: ReactNode // F-CM-104
  moneyTabNote?: boolean // F-CM-104 (Z27)
}

function Customer(props: CustomerProps) {
  return (
    <PartyRecordGate model={props.model} actions={props.actions}>
      {(party) => <CustomerBody {...props} party={party} />}
    </PartyRecordGate>
  )
}

/** F-SA-271: the band's ⋯ lines of the customer (after Start a project), each held with why. */
// F-CP-104: + Import orders for <customer>… opens the sheet's import on this page (onImport), held without orders.manage.
function customerMore(model: PartyRecordModel, party: Party, t: ReturnType<typeof useT>, onAddTask?: () => void, onImport?: () => void): MenuItemDef[] {
  const can = model.can
  const name = partyName(party)
  const id = encodeURIComponent(party.id)
  return [
    { id: 'task', label: t('customers.band.addTask', { customer: name }), onSelect: () => onAddTask?.(), disabled: !can.tasks || !onAddTask, description: can.tasks ? undefined : t('held.right', { right: rightRef('tasks.manage') }) },
    ...(can.orders
      ? [
          onImport
            ? { id: 'import', label: t('customers.band.importOrders', { customer: name }), onSelect: onImport, disabled: !can.ordersManage, description: can.ordersManage ? undefined : t('held.right', { right: rightRef('orders.manage') }) } // F-CP-104: in place
            : { id: 'import', label: t('customers.band.importOrders', { customer: name }), href: can.ordersManage ? `${model.prefix}/sales/orders?party=${id}&rows=all&import=1` : undefined, disabled: !can.ordersManage, description: can.ordersManage ? undefined : t('held.right', { right: rightRef('orders.manage') }) },
          { id: 'orders', label: t('customers.openSheet'), href: `${model.prefix}/sales/orders?party=${id}&rows=all` },
        ]
      : []),
    ...(can.workorders ? [{ id: 'workorders', label: t('customers.band.workOrders', { customer: name }), href: `${model.prefix}/production/work-orders?party=${id}` }] : []),
  ]
}

// ---- F-CQ-306 (cq fx3 W2-1b): the one line that says why the Work tab shows instead of Quotes & incoming (before-order's words).
function QuotesTabNote() {
  return (
    <WithMessages namespaces={['before-order']}>
      <QuotesTabNoteLine />
    </WithMessages>
  )
}
function QuotesTabNoteLine() {
  const b = useT('before-order')
  return (
    <p className="fw-cw-line" role="status">
      {b('note.noTab')}
    </p>
  )
}
// ---- end F-CQ-306

// ---- F-CM-104 (cm-w1 W1.4; Z27): the one line that says why the Work tab shows instead of Money (the Quotes line's pattern).
function MoneyTabNote() {
  const t = useT(CUSTOMER_MONEY_NAMESPACE)
  return (
    <p className="fw-cw-line" role="status">
      {t('cm.note.noTab')}
    </p>
  )
}
// ---- end F-CM-104

/** F-SA-271: an old address that asked for a part of a tab (Requirements) opens at it, once. */
function ScrollOnArrival({ id }: { id: string }) {
  useEffect(() => {
    document.getElementById(id)?.scrollIntoView({ block: 'start' })
    // Once, on arrival.
  }, [])
  return null
}

function CustomerBody({ model, party, actions, thread, printThread, overviewTab /* F-CO-103 */, terms, portal, depth, onAddTask, taskDialog, money: moneyModel, peopleTab, peopleBadge, peopleNotice /* F-CA-119 */, work, workCount, quotesIncoming, threadButton /* F-SA-279 */, onNewOrder, onImport /* F-CP-104 */, quotesBadge /* F-CQ-302 */, quotesTabNote /* F-CQ-306 */, moneyTab /* F-CM-104 */, moneyTabNote /* F-CM-104 */ }: CustomerProps & { party: Party }) {
  const t = useT('parties')
  const side = model.side
  const config = SIDES[side]
  const can = model.can
  const editable = writable(party, can)
  const tabs = recordTabs(config, can)
  // F-SA-271: no tab asked (or one the reader may not see): the first tab the reader sees.
  // ---- F-CQ-301 (P0-B2): the same pure rule as the page's container (its slots are built for this tab).
  const tab: RecordTab = shownTab(tabs, model.tab)
  // ---- end F-CQ-301
  const recordPath = sideHref(model.prefix, config, `/${encodeURIComponent(party.id)}`)
  // F-SA-277: Quotes & incoming counts the customer's quotes (the record's newest quotes, when all were read).
  // ---- F-CQ-302: with the page's count read, what waits on us there (To answer + Accepted, order waits), marked when > 0.
  const quotesCount = quotesBadge !== undefined ? (quotesBadge?.count ?? null) : model.quotes.items && !model.quotes.more ? model.quotes.items.length : null
  // ---- end F-CQ-302
  // F-CM-104 (Z11): Money counts what is LATE — late invoices + late deposit requests (the page's ageing and open items); null while
  // read; no chip at all when nothing is late or nothing can be counted (never "0").
  const page = pagePartsOf(moneyModel)
  const moneyCount = moneyModel && (page.ageing || page.openItems) ? moneyBadgeOf({ can: { receivables: moneyModel.can.receivables, payments: !!moneyModel.can.payments, price: moneyModel.can.price }, today: romeToday(), ageing: page.ageing, openItems: page.openItems, currency: party.currency }) : undefined
  const tabItems: TabItem[] = tabs.map((id) => ({
    id,
    href: `${recordPath}?tab=${id}`,
    label: t(`${side}.tab.${id}`),
    // F-CM-104 (Z11): Money counts the late invoices and the late deposit requests (null while reading; none: no chip).
    // F-SA-276: Work counts what waits on us (requests to answer + replies waiting on us), marked when something does.
    // F-CA-119 (Z4): People counts the addresses waiting for our check only (from the party read), marked as Work is; none: no chip.
    count: id === 'people' ? (peopleBadge?.count ?? undefined) : id === 'work' ? (workCount?.count ?? null) : id === 'quotes' ? quotesCount : id === 'money' ? moneyCount : undefined,
    ...(id === 'work' && workCount?.attention ? { icon: <CircleAlert size={12} role="img" aria-label={t('customers.work.attention', { count: workCount.count ?? 0 })} /> } : {}),
    ...(id === 'people' && peopleBadge?.attention ? { icon: <CircleAlert size={12} role="img" aria-label={t('customers.work.attention', { count: peopleBadge.count })} /> } : {}), // F-CA-119
    // ---- F-CQ-302: Quotes & incoming marked as Work is, when something waits on us there.
    ...(id === 'quotes' && quotesBadge?.attention ? { icon: <CircleAlert size={12} role="img" aria-label={t('customers.work.attention', { count: quotesBadge.count ?? 0 })} /> } : {}),
    // ---- end F-CQ-302
  }))
  // F-SA-271: the primary — Activate a prospect, New order for an active customer (orders.manage), none when blocked or archived;
  // Check VIES goes into ⋯ (and stays in Terms › VIES).
  // F-CP-104 (C2a): New order opens the New order window on this page, the customer held (no Change), no trip to Sales › Orders.
  const primary =
    party.status === 'ACTIVE' ? (
      can.ordersManage ? (
        onNewOrder ? (
          <Button size="sm" variant="primary" onClick={onNewOrder}>
            {t('customers.band.newOrder')}
          </Button>
        ) : (
          <Button size="sm" variant="primary" asChild>
            <Link href={`${model.prefix}/sales/orders?party=${encodeURIComponent(party.id)}&new=1`}>{t('customers.band.newOrder')}</Link>
          </Button>
        )
      ) : (
        <Button size="sm" variant="primary" heldReason={t('held.right', { right: rightRef('orders.manage') })}>
          {t('customers.band.newOrder')}
        </Button>
      )
    ) : party.status === 'PROSPECT' ? undefined : null
  const { band, viesHeld } = usePartyBand(model, party, actions, { primary, viesInMore: true, more: customerMore(model, party, t, onAddTask, onImport /* F-CP-104 */) })
  const { current } = identitiesOf(party)

  return (
    <>
      <RecordFrame
        recordType="Party"
        record={{ type: 'Party', id: party.id } /* F-OP-212: every ask that names no record is this customer's */}
        personId={model.personId ?? null}
        threadLabel={t('record.dockLabelOf', { name: partyName(party) })}
        thread={thread ?? null}
        printThread={printThread}
        band={band}
        // F-SA-279 (11-customer-page §2.5, P11): Work's dock a third at every width, every other tab 40 %; a width the person picks is
        // kept for that tab, "hidden" for every customer (the record type is Party, even while the dock shows an order).
        // F-CQ-301 (10-design §1.2, L17): Quotes & incoming docks a third too (its body 863 px at 1440, as Work's).
        // F-CO-103 (customer Overview plan §6.1; lead settle S13): the Overview a third too (its tab 865 px at 1440, the room the
        // order's Overview has) — written for the Overview ONLY: Money, People, Terms and Portal stay 40 %.
        // F-CM-104 (customer Money plan D2, the Owner's pick): Money a third too (865 px at 1440, the order's Money room); People, Terms
        // and Portal stay 40 %.
        // F-CA-119 (customer People plan D2, the Owner's pick 2026-11-24): People a third too (865 px at 1440); Terms and Portal stay 40 %.
        defaultWidth={tab === 'work' || tab === 'quotes' || tab === 'overview' || tab === 'money' || tab === 'people' ? 'third' : undefined}
        dockTab={tab}
        threadButton={threadButton ?? null}
      >
        <div className="fw-pty">
          {model.threadOnArrival && <ShowThreadOnArrival />}
          {model.anchorOnArrival && <ScrollOnArrival id={model.anchorOnArrival} />}
          <Tabs ariaLabel={t('record.tabsLabel')} tabs={tabItems} active={tab} size="sm" overflow="scroll" />
          {/* F-CO-103 (plan §6.7): on the Overview the headline and the first strip say Blocked / Archived — its notice area keeps the
              receipt, "someone else changed" and "You can view, not change"; every other tab keeps the shared notice area whole. */}
          {/* F-CA-119 (Z15): People's own notices (an address checked, a portal act) in the same ONE notice area. */}
          {tab === 'overview' ? <OverviewNotices model={model} party={party} actions={actions} /> : <PartyNotices model={model} party={party} actions={actions}>{tab === 'people' ? peopleNotice : null}</PartyNotices>}

          {/* F-SA-276: Work — the waiting strip and the Orders sheet locked to the customer (no tabs inside the tab, R5). */}
          {/* F-CQ-306 (cq fx3 W2-1b; 10-design §10): asked for Quotes & incoming without its right, the page shows Work and says why once. */}
          {tab === 'work' && quotesTabNote && <QuotesTabNote />}
          {/* F-CM-104 (Z27): asked for Money without its right, the page shows Work and says why once. */}
          {tab === 'work' && moneyTabNote && <MoneyTabNote />}
          {tab === 'work' && work}
          {/* F-SA-277: Quotes & incoming — two lists stacked (Quotes, then Incoming requests), each its own list locked to the customer. */}
          {tab === 'quotes' && quotesIncoming}
          {/* F-CO-103: the Overview — the container's tab (the shared overview kit's parts; the custom fields are its last pair's). */}
          {tab === 'overview' && overviewTab}
          {/* F-CM-104 (cm-w1 W1.4): Money — the answer line, Balance, To collect… (the container's tab, cu/record/money/CustomerMoney.tsx). */}
          {tab === 'money' && moneyTab}
          {/* F-CA-119 (customer page › People & addresses, lane ca-): the container's tab — the answer line, People, Addresses (and, until
              ca-w2, today's riders / profiles and personal-data cards under them): cu/record/view/people/PeopleTab.tsx. */}
          {tab === 'people' && peopleTab}
          {tab === 'terms' && (
            // F-SA-272: Terms & requirements — an anchor line (in-page jumps, not tabs), then the Commercial terms first (the most used),
            // the hold and PO number required (B-W2b-324), the requirements in force, the tax identity and VIES.
            <div className="fw-pty-stack">
              <nav className="fw-pty-actions" aria-label={t('customers.anchor.label')}>
                {terms && <a className="fw-pty-link" href="#party-commercial">{t('customers.anchor.commercial')}</a>}
                {depth?.tax && <a className="fw-pty-link" href="#party-hold">{t('customers.anchor.hold')}</a>}
                {depth?.requirements && <a className="fw-pty-link" href="#party-requirements">{t('customers.requirementsLabel')}</a>}
                <a className="fw-pty-link" href="#party-identity">{t('customers.anchor.identity')}</a>
              </nav>
              {terms && (
                <section id="party-commercial" className="fw-pty-anchor" aria-label={t('customers.anchor.commercial')}>
                  {terms}
                </section>
              )}
              {depth?.tax && (
                <section id="party-hold" className="fw-pty-anchor" aria-label={t('customers.anchor.hold')}>
                  {depth.tax}
                </section>
              )}
              {depth?.requirements && (
                <section id="party-requirements" className="fw-pty-anchor" aria-label={t('customers.requirementsLabel')}>
                  {depth.requirements}
                </section>
              )}
              <section id="party-identity" className="fw-pty-anchor fw-pty-two-wide" aria-label={t('customers.anchor.identity')}>
                <IdentityCard model={model} party={party} current={current} actions={actions} editable={editable} />
                <ViesCard model={model} party={party} actions={actions} viesHeld={viesHeld} />
              </section>
            </div>
          )}
          {/* B-W2b-180: Portal settings (areas/sales/customers/portal; a refused invite keeps its real reason). */}
          {tab === 'portal' && portal}
        </div>
      </RecordFrame>
      <PartyDialogs model={model} party={party} actions={actions} />
      {taskDialog}
    </>
  )
}
