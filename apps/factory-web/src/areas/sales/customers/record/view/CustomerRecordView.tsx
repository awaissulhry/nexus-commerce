'use client'

import { useEffect, type ReactNode } from 'react'
import Link from 'next/link'
import { Table2 } from 'lucide-react'
import { Card, KeyValue, MetricStrip, RecordLayout, SummaryTable, Tabs, type MenuItemDef, type Metric, type TabItem } from '@nexus/ui/components'
import { Button, SegmentedControl } from '@nexus/ui/primitives'
import { WithMessages } from '../../../../../record-panels/i18n'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { Party } from '../../../../parties/_shared/api'
import { countryName, dealRows, identitiesOf, keyNumbers, languageName, money, partyName, recordTabs, sideHref, SIDES, writable, type DealFilter, type PartyRecordModel, type RecordTab } from '../../../../parties/_shared/model'
import { PartyRecordGate, usePartyBand, type OverviewSlot, type PartyRecordActions, type SupplierDepth } from '../../../../parties/_shared/view/PartyRecordView'
import { AddressesCard, CardHead, ContactsCard, IdentityCard, PartyDialogs, PartyNotices, ShowThreadOnArrival, SidePanel, ViesCard, type TabProps } from '../../../../parties/_shared/view/cards'
import { dash, PartiesMessages, ReadState, RoleTags } from '../../../../parties/_shared/view/parts'
import { RecordFrame } from '../../../../_shared/record-frame/RecordFrame'
import { rightRef } from '../../../../../lib/i18n/rights' // F-SA-271
import { CUSTOMER_MONEY_NAMESPACE } from '../../money/model'
import { useCustomerOverview, type CustomerMoneyModel } from '../../money/overview'

/**
 * SCR-033 Customer record (design sales.customers "records: Customer"; F-SA-270, sales page plan N5, picks P10, R5): the customer's
 * own view, split from the supplier's (areas/parties/_shared/view/PartyRecordView.tsx draws the supplier's record, unchanged). The
 * record's reads and writes are the shared hook's (usePartyRecord); the band, the notices, the cards and the dialogs are the shared
 * ones (PartyRecordView's usePartyBand and PartyRecordGate, ./cards). On RecordFrame with the customer's thread docked (B-TH-260).
 * Terms & requirements adds the customer's Commercial terms card (B-W2a-49, `terms`); the Overview's Overdue and Returns this year
 * tiles and the open returns and claims under Now come from `money` (B-W2a-81); the customer in depth from `depth` (B-W2b-324).
 * Fetches nothing: areas/sales/customers/record/CustomerRecord.tsx reads and writes; a design case passes made-up models.
 */
export function CustomerRecordView({
  model,
  actions,
  thread,
  printThread,
  fields,
  terms,
  portal,
  money: moneyModel,
  depth,
  onAddTask,
  taskDialog,
  supervisor,
}: {
  model: PartyRecordModel
  actions?: PartyRecordActions
  /** B-TH-260: the customer's docked thread (a design case's; the page mounts OfficeRecordThread). */
  thread?: ReactNode
  printThread?: ReactNode
  /** B-TH-280: the custom fields, on the Overview only. */
  fields?: ReactNode
  terms?: ReactNode
  /** B-W2b-180: Portal access (`?tab=portal`). */
  portal?: ReactNode
  money?: CustomerMoneyModel | null
  /** B-W2b-324: the customer in depth (the shared record's `depth` slot), drawn from made-up models in the design. */
  depth?: SupplierDepth
  /** F-SA-271: the band's ⋯ "Add task for <customer>…" (the record's New task dialog, drawn by the container). */
  onAddTask?: () => void
  taskDialog?: ReactNode
  /** F-SA-272: "Who looks after <customer>" on the Overview (CustomerSupervisorCard, drawn by the container or a design case). */
  supervisor?: ReactNode
}) {
  return (
    <WithMessages namespaces={[CUSTOMER_MONEY_NAMESPACE]}>
      <PartiesMessages>
        <Customer model={{ ...model, side: 'customers' }} actions={actions} thread={thread} printThread={printThread} fields={fields} terms={terms} portal={portal} money={moneyModel ?? null} depth={depth} onAddTask={onAddTask} taskDialog={taskDialog} supervisor={supervisor} />
      </PartiesMessages>
    </WithMessages>
  )
}

interface CustomerProps {
  model: PartyRecordModel
  actions?: PartyRecordActions | undefined
  thread?: ReactNode
  printThread?: ReactNode
  fields?: ReactNode
  terms?: ReactNode
  portal?: ReactNode
  money: CustomerMoneyModel | null
  depth?: SupplierDepth | undefined
  onAddTask?: (() => void) | undefined
  taskDialog?: ReactNode
  supervisor?: ReactNode
}

function Customer(props: CustomerProps) {
  const overview = useCustomerOverview(props.money)
  return (
    <PartyRecordGate model={props.model} actions={props.actions}>
      {(party) => <CustomerBody {...props} party={party} overview={overview} />}
    </PartyRecordGate>
  )
}

/** F-SA-271: the band's ⋯ lines of the customer (after Start a project), each held with why. */
function customerMore(model: PartyRecordModel, party: Party, t: ReturnType<typeof useT>, onAddTask?: () => void): MenuItemDef[] {
  const can = model.can
  const name = partyName(party)
  const id = encodeURIComponent(party.id)
  return [
    { id: 'task', label: t('customers.band.addTask', { customer: name }), onSelect: () => onAddTask?.(), disabled: !can.tasks || !onAddTask, description: can.tasks ? undefined : t('held.right', { right: rightRef('tasks.manage') }) },
    ...(can.orders
      ? [
          { id: 'import', label: t('customers.band.importOrders', { customer: name }), href: can.ordersManage ? `${model.prefix}/sales/orders?party=${id}&rows=all&import=1` : undefined, disabled: !can.ordersManage, description: can.ordersManage ? undefined : t('held.right', { right: rightRef('orders.manage') }) },
          { id: 'orders', label: t('customers.openSheet'), href: `${model.prefix}/sales/orders?party=${id}&rows=all` },
        ]
      : []),
    ...(can.workorders ? [{ id: 'workorders', label: t('customers.band.workOrders', { customer: name }), href: `${model.prefix}/production/work-orders?party=${id}` }] : []),
  ]
}

/** F-SA-271: an old address that asked for a part of a tab (Requirements) opens at it, once. */
function ScrollOnArrival({ id }: { id: string }) {
  useEffect(() => {
    document.getElementById(id)?.scrollIntoView({ block: 'start' })
    // Once, on arrival.
  }, [])
  return null
}

function CustomerBody({ model, party, actions, thread, printThread, fields, terms, portal, overview, depth, onAddTask, taskDialog, supervisor }: CustomerProps & { party: Party; overview?: OverviewSlot | undefined }) {
  const t = useT('parties')
  const side = model.side
  const config = SIDES[side]
  const can = model.can
  const editable = writable(party, can)
  const tabs = recordTabs(config, can)
  // F-SA-271: no tab asked (or one the reader may not see): the first tab the reader sees.
  const tab: RecordTab = tabs.includes(model.tab) ? model.tab : (tabs[0] ?? 'overview')
  const recordPath = sideHref(model.prefix, config, `/${encodeURIComponent(party.id)}`)
  const activeAddresses = party.addresses.filter((address) => address.status === 'ACTIVE')
  const activeContacts = party.contacts.filter((contact) => contact.status === 'ACTIVE')
  // Until the Work and Quotes & incoming lists are drawn (F-SA-276, F-SA-277), each keeps today's rows of its kind.
  const ordersCount = model.orders.items && !model.orders.more ? model.orders.items.length : null
  const quotesCount = model.quotes.items && !model.quotes.more ? model.quotes.items.length : null
  const tabItems: TabItem[] = tabs.map((id) => ({
    id,
    href: `${recordPath}?tab=${id}`,
    label: t(`${side}.tab.${id}`),
    count: id === 'people' ? activeAddresses.length + activeContacts.length : id === 'work' ? ordersCount : id === 'quotes' ? quotesCount : undefined,
  }))
  // F-SA-271: the primary — Activate a prospect, New order for an active customer (orders.manage), none when blocked or archived;
  // Check VIES goes into ⋯ (and stays in Terms › VIES).
  const primary =
    party.status === 'ACTIVE' ? (
      can.ordersManage ? (
        <Button size="sm" variant="primary" asChild>
          <Link href={`${model.prefix}/sales/orders?party=${encodeURIComponent(party.id)}&new=1`}>{t('customers.band.newOrder')}</Link>
        </Button>
      ) : (
        <Button size="sm" variant="primary" heldReason={t('held.right', { right: rightRef('orders.manage') })}>
          {t('customers.band.newOrder')}
        </Button>
      )
    ) : party.status === 'PROSPECT' ? undefined : null
  const { band, viesHeld } = usePartyBand(model, party, actions, { primary, viesInMore: true, more: customerMore(model, party, t, onAddTask) })
  const { current } = identitiesOf(party)

  return (
    <>
      <RecordFrame
        recordType="Party"
        personId={model.personId ?? null}
        threadLabel={t('record.dockLabelOf', { name: partyName(party) })}
        thread={thread ?? null}
        printThread={printThread}
        fields={fields /* B-TH-280: the custom fields, on the Overview only */}
        band={band}
      >
        <div className="fw-pty">
          {model.threadOnArrival && <ShowThreadOnArrival />}
          {model.anchorOnArrival && <ScrollOnArrival id={model.anchorOnArrival} />}
          <Tabs ariaLabel={t('record.tabsLabel')} tabs={tabItems} active={tab} size="sm" overflow="scroll" />
          <PartyNotices model={model} party={party} actions={actions} />

          {tab === 'work' && (
            // F-SA-271: the customer's orders (the Orders sheet locked to the customer comes with F-SA-276).
            <div className="fw-pty-stack">
              <p className="fw-pty-actions">
                <Link className="fw-pty-link" href={`${model.prefix}/sales/orders?party=${encodeURIComponent(party.id)}&rows=all`}>
                  <Table2 size={14} aria-hidden /> {t('customers.openSheet')}
                </Link>
              </p>
              <DealsTab model={model} actions={actions} only="order" />
            </div>
          )}
          {/* F-SA-271: the customer's quotes (the two lists of Quotes & incoming come with F-SA-277). */}
          {tab === 'quotes' && <DealsTab model={model} actions={actions} only="quote" />}
          {tab === 'overview' && <CustomerOverview model={model} party={party} actions={actions} editable={editable} viesHeld={viesHeld} overview={overview} depth={depth} supervisor={supervisor} />}
          {tab === 'money' && <div className="fw-pty-stack">{[...(overview?.numbers ?? []), ...(depth?.numbers ?? [])].length > 0 && <MetricStrip metrics={[...(overview?.numbers ?? []), ...(depth?.numbers ?? [])]} />}</div>}
          {tab === 'people' && (
            <div className="fw-pty-stack">
              <AddressesCard model={model} party={party} actions={actions} editable={editable} />
              <ContactsCard model={model} party={party} actions={actions} editable={editable} />
              {/* B-W2b-324: consent, lawful basis and the personal-data actions (Sales' depth slot). */}
              {depth?.contacts}
            </div>
          )}
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

// ---- Overview (moved from PartyRecordView.tsx, F-SA-270) ---------------------------------------------------------------

/** F-SA-272: the open orders' states the Overview counts (the record's newest 200 orders). */
const OPEN_ORDER_STATES: readonly string[] = ['CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED']

/**
 * F-SA-272 (11-customer-page §4): who they are, how they stand, who looks after them — Key numbers (at most 6, each a door: Open
 * orders · In production · Late → Work, Open quotes → Quotes & incoming, Overdue → Money), Identity, Also open (samples, repairs,
 * open returns and claims), the custom fields (the frame's, on this tab only); beside it Status, Who looks after <customer> (the
 * supervisor and backup, moved from Portal settings), Next steps, VIES, the team and the requirements in force, the main contacts.
 * Ordered in <year>, Returns in <year> and Free credit went to Money; the Now card to Work and Quotes & incoming.
 */
function CustomerOverview({ model, party, actions, editable, viesHeld, overview, depth, supervisor }: TabProps & { viesHeld: string | null; overview?: OverviewSlot | undefined; depth?: SupplierDepth | undefined; supervisor?: ReactNode }) {
  const t = useT('parties')
  const locale = useLocale()
  const can = model.can
  const year = String(new Date().getUTCFullYear())
  const numbers = keyNumbers(model.quotes, model.orders, year)
  const amount = (value: number | null | undefined, currency: string | null) => (can.price && value !== null && value !== undefined && currency ? money(value, currency, locale) : null)
  const tabHref = (tab: string) => `${sideHref(model.prefix, SIDES.customers, `/${encodeURIComponent(party.id)}`)}?tab=${tab}`
  const today = new Date().toISOString().slice(0, 10)
  const orders = model.orders.items && !model.orders.more ? model.orders.items : null
  const ordersHint = t(model.orders.problem ? 'tile.unknown' : 'numbers.reading')
  const metrics: Metric[] = [
    ...(can.orders
      ? [
          {
            label: t('numbers.backlog'),
            value: numbers.backlog ? String(numbers.backlog.count) : '—',
            hint: numbers.backlog ? [t('numbers.units', { count: numbers.backlog.units }), amount(numbers.backlog.amount, numbers.backlog.currency)].filter(Boolean).join(' · ') : ordersHint,
            href: tabHref('work'),
          },
          { label: t('numbers.inProduction'), value: orders ? String(orders.filter((order) => order.status === 'IN_PRODUCTION').length) : '—', hint: orders ? t('numbers.inProductionHint') : ordersHint, href: tabHref('work') },
          {
            label: t('numbers.late'),
            value: orders ? String(orders.filter((order) => OPEN_ORDER_STATES.includes(order.status) && order.promiseDate !== null && order.promiseDate < today).length) : '—',
            hint: orders ? t('numbers.lateHint') : ordersHint,
            href: tabHref('work'),
          },
        ]
      : []),
    ...(can.quotes
      ? [
          {
            label: t('numbers.openQuotes'),
            value: numbers.openQuotes ? String(numbers.openQuotes.count) : '—',
            hint: numbers.openQuotes ? (amount(numbers.openQuotes.amount, numbers.openQuotes.currency) ?? t('numbers.quotesHint')) : t(model.quotes.problem ? 'tile.unknown' : 'numbers.reading'),
            href: tabHref('quotes'),
          },
        ]
      : []),
    // B-W2a-81: what the customer owes that is overdue — its door is Money (F-SA-272).
    ...(overview?.overdue ? [{ ...overview.overdue, href: can.money ? tabHref('money') : overview.overdue.href }] : []),
  ].slice(0, 6)
  const main = (
    <div className="fw-pty-stack">
      {metrics.length > 0 && <MetricStrip metrics={metrics} />}
      <Card padded>
        <div className="fw-pty-card-body">
          <CardHead
            title={t('overview.identity')}
            action={
              <Button size="sm" onClick={() => actions?.onDialog?.({ kind: 'edit' })} heldReason={editable ? null : can.manage ? t('held.archived') : t('held.manage')}>
                {t('common.edit')}
              </Button>
            }
          />
          <KeyValue
            columns={2}
            labelCase="sentence"
            items={[
              { label: t('field.legalName'), value: party.legalName },
              { label: t('field.tradeName'), value: dash(party.tradeName) },
              { label: t('field.kind'), value: t(`kind.${party.kind}`) },
              { label: t('field.roles'), value: <RoleTags roles={party.roles} /> },
              { label: t('field.country'), value: countryName(party.country, locale) },
              { label: t('field.language'), value: languageName(party.language, locale) },
              { label: t('field.currency'), value: party.currency },
              { label: t('field.code'), value: <span className="fw-pty-code">{party.code}</span> },
              ...(party.paymentTerms ? [{ label: t('field.paymentTerms'), value: party.paymentTerms }] : []),
            ]}
          />
        </div>
      </Card>
      {/* F-SA-272: Also open — samples in progress, repairs and alterations (Sales' depth slot), open returns and claims (B-W2a-81). */}
      {(depth?.now || overview?.now) && (
        <section className="fw-pty-stack" aria-label={t('overview.alsoOpen')}>
          <h2 className="fw-pty-card-title">{t('overview.alsoOpen')}</h2>
          {depth?.now}
          {overview?.now}
        </section>
      )}
    </div>
  )
  return (
    <RecordLayout
      main={main}
      aside={
        <SidePanel model={model} party={party} actions={actions} editable={editable} viesHeld={viesHeld} status={depth?.status}>
          {/* F-SA-272: who looks after the customer (office only), moved from Portal settings › Production limits. */}
          {supervisor}
          {depth?.aside}
        </SidePanel>
      }
      asideLabel={t('side.label')}
    />
  )
}

// ---- Quotes & orders (moved from PartyRecordView.tsx, F-SA-270) --------------------------------------------------------

// F-SA-271: `only` — the rows of one kind (Work: the orders; Quotes & incoming: the quotes), until their own lists come.
function DealsTab({ model, actions, only }: { model: PartyRecordModel; actions?: PartyRecordActions | undefined; only: 'quote' | 'order' }) {
  const t = useT('parties')
  const locale = useLocale()
  const filter = model.deals ?? 'open'
  const quotes = only === 'quote'
  const problem = quotes ? model.quotes.problem : model.orders.problem
  const reading = quotes ? model.can.quotes && model.quotes.items === null && !model.quotes.problem : model.can.orders && model.orders.items === null && !model.orders.problem
  const rows = dealRows(quotes ? (model.quotes.items ?? []) : [], quotes ? [] : (model.orders.items ?? []), filter)
  const price = model.can.price
  return (
    <Card padded>
      <div className="fw-pty-card-body">
        <CardHead
          title={t(quotes ? 'deals.titleQuotes' : 'deals.titleOrders')}
          action={
            <SegmentedControl
              ariaLabel={t('deals.filter')}
              size="sm"
              value={filter}
              onChange={(value) => actions?.onDeals?.(value as DealFilter)}
              options={(['open', 'won', 'lost', 'all'] as const).map((value) => ({ value, label: t(`deals.${value}`) }))}
            />
          }
        />
        {quotes && !model.can.quotes && <p className="fw-pty-hint">{t('deals.noQuotesRight')}</p>}
        {problem ? (
          <ReadState problem={problem} loading={false} onRetry={actions?.onRetry} failedTitle={t('deals.failed')} />
        ) : reading ? (
          <ReadState loading rows={4} />
        ) : rows.length === 0 ? (
          <p className="fw-pty-hint">{t(filter === 'open' ? 'deals.emptyOpen' : 'deals.empty')}</p>
        ) : (
          <SummaryTable
            label={t(quotes ? 'deals.titleQuotes' : 'deals.titleOrders')}
            stackOnPhone
            columns={[
              t('deals.col.type'),
              t('deals.col.number'),
              t('deals.col.status'),
              t('deals.col.date'),
              ...(price ? [t('deals.col.value')] : []),
              t('deals.col.promise'),
              t('deals.col.validUntil'),
            ]}
            align={Array.from({ length: price ? 7 : 6 }, (_, index) => (price && index === 4 ? 'right' : 'left'))}
            rows={rows.map((row) => ({
              id: `${row.type}-${row.id}`,
              cells: [
                t(`deals.${row.type}`),
                <span key="n" className="fw-pty-code">
                  {row.number}
                </span>,
                t(row.type === 'quote' ? `quoteStatus.${row.status}` : `orderStatus.${row.status}`),
                formatDate(row.date, { locale }),
                ...(price ? [dash(money(row.amount, row.currency, locale))] : []),
                row.promiseDate ? formatDate(row.promiseDate, { locale }) : '—',
                row.validUntil ? formatDate(row.validUntil, { locale }) : '—',
              ],
            }))}
          />
        )}
        {(quotes ? model.quotes.more : model.orders.more) && <p className="fw-pty-hint">{t('deals.more')}</p>}
      </div>
    </Card>
  )
}
