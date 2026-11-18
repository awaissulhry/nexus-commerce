'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { Table2 } from 'lucide-react'
import { Card, KeyValue, MetricStrip, RecordLayout, SummaryTable, Tabs, type TabItem } from '@nexus/ui/components'
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
}) {
  return (
    <WithMessages namespaces={[CUSTOMER_MONEY_NAMESPACE]}>
      <PartiesMessages>
        <Customer model={{ ...model, side: 'customers' }} actions={actions} thread={thread} printThread={printThread} fields={fields} terms={terms} portal={portal} money={moneyModel ?? null} depth={depth} />
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
}

function Customer(props: CustomerProps) {
  const overview = useCustomerOverview(props.money)
  return (
    <PartyRecordGate model={props.model} actions={props.actions}>
      {(party) => <CustomerBody {...props} party={party} overview={overview} />}
    </PartyRecordGate>
  )
}

function CustomerBody({ model, party, actions, thread, printThread, fields, terms, portal, overview, depth }: CustomerProps & { party: Party; overview?: OverviewSlot | undefined }) {
  const t = useT('parties')
  const side = model.side
  const config = SIDES[side]
  const can = model.can
  const editable = writable(party, can)
  const tabs = recordTabs(config, can)
  const tab: RecordTab = tabs.includes(model.tab) ? model.tab : 'overview'
  const recordPath = sideHref(model.prefix, config, `/${encodeURIComponent(party.id)}`)
  const activeAddresses = party.addresses.filter((address) => address.status === 'ACTIVE')
  const activeContacts = party.contacts.filter((contact) => contact.status === 'ACTIVE')
  const ordersCount = model.quotes.items && model.orders.items && !model.quotes.more && !model.orders.more ? model.quotes.items.length + model.orders.items.length : null
  const tabItems: TabItem[] = tabs.map((id) => ({
    id,
    href: `${recordPath}${id === 'overview' ? '' : `?tab=${id}`}`,
    label: t(`${side}.tab.${id}`),
    count: id === 'addresses' ? activeAddresses.length + activeContacts.length : id === 'orders' ? ordersCount : undefined,
  }))
  const { band, viesHeld } = usePartyBand(model, party, actions)
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
          <Tabs ariaLabel={t('record.tabsLabel')} tabs={tabItems} active={tab} size="sm" overflow="scroll" />
          <PartyNotices model={model} party={party} actions={actions} />

          {tab === 'overview' && <CustomerOverview model={model} party={party} actions={actions} editable={editable} viesHeld={viesHeld} overview={overview} depth={depth} />}
          {tab === 'addresses' && (
            <div className="fw-pty-stack">
              <AddressesCard model={model} party={party} actions={actions} editable={editable} />
              <ContactsCard model={model} party={party} actions={actions} editable={editable} />
              {/* B-W2b-324: consent, lawful basis and the personal-data actions (Sales' depth slot). */}
              {depth?.contacts}
            </div>
          )}
          {tab === 'terms' && (
            // B-TH-260: Terms & requirements — the tax identity and VIES, the side's own Commercial terms (B-W2a-49), the hold and PO
            // number required (B-W2b-324), then the packing, labelling and document rules in force (B-W2b-324's Requirements).
            <div className="fw-pty-stack">
              <div className="fw-pty-two-wide">
                <IdentityCard model={model} party={party} current={current} actions={actions} editable={editable} />
                <ViesCard model={model} party={party} actions={actions} viesHeld={viesHeld} />
              </div>
              {terms}
              {depth?.tax}
              {depth?.requirements && (
                <section id="party-requirements" className="fw-pty-anchor" aria-label={t('customers.requirementsLabel')}>
                  {depth.requirements}
                </section>
              )}
            </div>
          )}
          {tab === 'orders' && (
            <div className="fw-pty-stack">
              {/* B-TH-260 (SHEET-G12): one full sheet per customer — Sales › Orders with this customer and every row. */}
              {can.orders && (
                <p className="fw-pty-actions">
                  <Link className="fw-pty-link" href={`${model.prefix}/sales/orders?party=${encodeURIComponent(party.id)}&rows=all`}>
                    <Table2 size={14} aria-hidden /> {t('customers.openSheet')}
                  </Link>
                </p>
              )}
              <DealsTab model={model} actions={actions} />
            </div>
          )}
          {/* B-W2b-180: Portal access (areas/sales/customers/portal; a refused invite keeps its real reason). */}
          {tab === 'portal' && portal}
        </div>
      </RecordFrame>
      <PartyDialogs model={model} party={party} actions={actions} />
    </>
  )
}

// ---- Overview (moved from PartyRecordView.tsx, F-SA-270) ---------------------------------------------------------------

function CustomerOverview({ model, party, actions, editable, viesHeld, overview, depth }: TabProps & { viesHeld: string | null; overview?: OverviewSlot; depth?: SupplierDepth | undefined }) {
  const t = useT('parties')
  const locale = useLocale()
  const can = model.can
  const year = String(new Date().getUTCFullYear())
  const numbers = keyNumbers(model.quotes, model.orders, year)
  const amount = (value: number | null | undefined, currency: string | null) => (can.price && value !== null && value !== undefined && currency ? money(value, currency, locale) : null)
  const metrics = [
    ...(can.quotes
      ? [
          {
            label: t('numbers.openQuotes'),
            value: numbers.openQuotes ? String(numbers.openQuotes.count) : '—',
            hint: numbers.openQuotes ? (amount(numbers.openQuotes.amount, numbers.openQuotes.currency) ?? t('numbers.quotesHint')) : t(model.quotes.problem ? 'tile.unknown' : 'numbers.reading'),
          },
        ]
      : []),
    ...(can.orders
      ? [
          {
            label: t('numbers.backlog'),
            value: numbers.backlog ? String(numbers.backlog.count) : '—',
            hint: numbers.backlog
              ? [t('numbers.units', { count: numbers.backlog.units }), amount(numbers.backlog.amount, numbers.backlog.currency)].filter(Boolean).join(' · ')
              : t(model.orders.problem ? 'tile.unknown' : 'numbers.reading'),
          },
          {
            label: t('numbers.thisYear', { year }),
            value: numbers.orderedThisYear ? String(numbers.orderedThisYear.count) : '—',
            hint: numbers.orderedThisYear
              ? (amount(numbers.orderedThisYear.amount, numbers.orderedThisYear.currency) ?? t('numbers.ordersHint'))
              : t(model.orders.problem ? 'tile.unknown' : 'numbers.reading'),
          },
        ]
      : []),
    // B-W2a-81: the side's own key numbers (Customers: Overdue, Returns this year), after the design's first three.
    ...(overview?.numbers ?? []),
    // B-W2b-324: free credit and the promises (Sales' depth slot).
    ...(depth?.numbers ?? []),
  ]
  const openQuotes = (model.quotes.items ?? []).filter((quote) => ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT'].includes(quote.status))
  const openOrders = (model.orders.items ?? []).filter((order) => ['CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED'].includes(order.status))
  const main = (
    <div className="fw-pty-stack">
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
      {metrics.length > 0 && <MetricStrip metrics={metrics} />}
      {(can.quotes || can.orders) && (
        <Card padded>
          <div className="fw-pty-card-body">
            <CardHead title={t('overview.now')} />
            {model.quotes.items === null && model.orders.items === null && !model.quotes.problem && !model.orders.problem ? (
              <ReadState loading rows={3} />
            ) : openQuotes.length + openOrders.length === 0 ? (
              <p className="fw-pty-hint">{t('overview.nothingOpen')}</p>
            ) : (
              <SummaryTable
                label={t('overview.now')}
                columns={[t('deals.col.type'), t('deals.col.number'), t('deals.col.status'), t('deals.col.when')]}
                stackOnPhone
                align={['left', 'left', 'left', 'left']}
                rows={[
                  ...openQuotes.slice(0, 5).map((quote) => ({
                    id: quote.id,
                    cells: [
                      t('deals.quote'),
                      <span key="n" className="fw-pty-code">
                        {quote.number}
                      </span>,
                      t(`quoteStatus.${quote.status}`),
                      quote.validUntil ? t('deals.validUntil', { date: formatDate(quote.validUntil, { locale }) }) : '—',
                    ],
                  })),
                  ...openOrders.slice(0, 5).map((order) => ({
                    id: order.id,
                    cells: [
                      t('deals.order'),
                      <span key="n" className="fw-pty-code">
                        {order.number}
                      </span>,
                      t(`orderStatus.${order.status}`),
                      order.promiseDate ? t('deals.promise', { date: formatDate(order.promiseDate, { locale }) }) : '—',
                    ],
                  })),
                ]}
              />
            )}
            {(openQuotes.length > 5 || openOrders.length > 5) && (
              <Link className="fw-pty-name" href={`${sideHref(model.prefix, SIDES.customers, `/${encodeURIComponent(party.id)}`)}?tab=orders`}>
                {t('overview.seeAll', { count: openQuotes.length + openOrders.length })}
              </Link>
            )}
          </div>
        </Card>
      )}
      {/* B-W2a-81: the side's own part of Now (Customers: open returns and claims, Finance › Receivables). */}
      {overview?.now}
      {/* B-W2b-324: samples in progress, measurement profiles, riders, repairs (Sales' depth slot). */}
      {depth?.now}
    </div>
  )
  return (
    <RecordLayout
      main={main}
      aside={
        <SidePanel model={model} party={party} actions={actions} editable={editable} viesHeld={viesHeld} status={depth?.status}>
          {depth?.aside}
        </SidePanel>
      }
      asideLabel={t('side.label')}
    />
  )
}

// ---- Quotes & orders (moved from PartyRecordView.tsx, F-SA-270) --------------------------------------------------------

function DealsTab({ model, actions }: { model: PartyRecordModel; actions?: PartyRecordActions }) {
  const t = useT('parties')
  const locale = useLocale()
  const filter = model.deals ?? 'open'
  const problem = model.quotes.problem ?? model.orders.problem
  const reading = (model.can.quotes && model.quotes.items === null && !model.quotes.problem) || (model.can.orders && model.orders.items === null && !model.orders.problem)
  const rows = dealRows(model.quotes.items ?? [], model.orders.items ?? [], filter)
  const price = model.can.price
  return (
    <Card padded>
      <div className="fw-pty-card-body">
        <CardHead
          title={t('customers.tab.orders')}
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
        {!model.can.quotes && <p className="fw-pty-hint">{t('deals.noQuotesRight')}</p>}
        {!model.can.orders && <p className="fw-pty-hint">{t('deals.noOrdersRight')}</p>}
        {problem ? (
          <ReadState problem={problem} loading={false} onRetry={actions?.onRetry} failedTitle={t('deals.failed')} />
        ) : reading ? (
          <ReadState loading rows={4} />
        ) : rows.length === 0 ? (
          <p className="fw-pty-hint">{t(filter === 'open' ? 'deals.emptyOpen' : 'deals.empty')}</p>
        ) : (
          <SummaryTable
            label={t('customers.tab.orders')}
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
        {(model.quotes.more || model.orders.more) && <p className="fw-pty-hint">{t('deals.more')}</p>}
      </div>
    </Card>
  )
}
