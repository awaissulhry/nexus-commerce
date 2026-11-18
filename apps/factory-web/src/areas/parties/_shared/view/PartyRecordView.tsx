'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { FolderKanban } from 'lucide-react'
import { Card, KeyValue, RecordLayout, SummaryTable, Tabs, type MenuItemDef, type Metric, type TabItem } from '@nexus/ui/components'
import { Button, Skeleton } from '@nexus/ui/primitives'
import { EditModeBar } from '../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import type { Party, PartyRow } from '../api'
import {
  countryName,
  identitiesOf,
  isReady,
  languageName,
  money,
  OPEN_PURCHASE_ORDERS,
  partyDraftOf,
  partyName,
  partyProblems,
  recordTabs,
  sideHref,
  SIDES,
  viesApplies,
  writable,
  type PartyDraft,
  type PartyRecordModel,
  type RecordTab,
} from '../model'
import { PartyFields } from './dialogs'
import { dash, Freshness, NoAccess, PartiesMessages, ReadState, RecordProblem, RecordSkeleton, RoleTags, StatusPill, ViesMark } from './parts'
// ---- B-TH-260: the party on RecordFrame (the band in the shell's row, the docked thread, one notice) ----
import { RecordFrame, type RecordBand } from '../../../_shared/record-frame/RecordFrame'
import { rightRef } from '../../../../lib/i18n/rights'
// F-SA-270: the parts both records draw moved to ./cards (same code); this file draws the supplier's record and the shared band.
import { AddressesCard, CardHead, ContactsCard, IdentityCard, PartyDialogs, PartyNotices, ShowThreadOnArrival, SidePanel, type TabProps } from './cards'

export interface PartyRecordActions {
  onRetry?: () => void
  /** Read the record again (someone else changed it). */
  onReload?: () => void
  onDialog?: (dialog: RecordDialog | null) => void
  onDismissNotice?: () => void
  /** Save the party's own fields (the customer's Edit dialog, the supplier's Overview form). Resolve true when saved. */
  onSaveParty?: (before: PartyDraft, after: PartyDraft) => Promise<boolean>
  /** The supplier's form holds unsaved changes (the live stream then asks before it reads the record again). */
  onDirty?: (dirty: boolean) => void
  onActivate?: () => void
  onBlock?: (reason: string) => void
  onUnblock?: () => void
  onArchive?: () => void
  onReactivate?: () => void
  onCheckVies?: () => void
  onSaveAddress?: (draft: AddressDraft, addressId?: string) => void
  onAddressStatus?: (addressId: string, status: 'ACTIVE' | 'ARCHIVED') => void
  /** Make an address the default invoice (delivery) address, or none (null). */
  onDefault?: (which: 'billTo' | 'shipTo', addressId: string | null) => void
  onSaveContact?: (draft: ContactDraft, contactId?: string) => void
  onContactStatus?: (contactId: string, status: 'ACTIVE' | 'ARCHIVED') => void
  /** A supplier contact receives POs (the ORDERS role), saved at once. */
  onReceivesOrders?: (contactId: string, on: boolean) => void
  onSaveIdentity?: (draft: IdentityDraft, mode: 'new' | 'correct') => void
  onDeals?: (filter: DealFilter) => void
  onCopyCode?: () => void
}

/**
 * B-W2a-81: what a side adds to the customer's Overview — tiles after Open quotes, Backlog and Ordered this year
 * (Customers: Overdue, Returns this year) and a part under Now (open returns and claims). The container reads them.
 */
export interface OverviewSlot {
  readonly numbers?: readonly Metric[]
  readonly now?: ReactNode
  /** F-SA-272: the Overdue tile alone (the customer's Overview shows it as a door to Money; Money shows every number). */
  readonly overdue?: Metric
  /** F-SA-273: the Returns in <year> tile alone (Money). */
  readonly returns?: Metric
}

/**
 * B-W2b-334: a supplier's W2b parts (areas/purchasing/suppliers/depth), drawn by Purchasing: kinds, status, origin and
 * closures under the supplier's form; the status since when and the next document to expire under Now; what each contact
 * receives under the contacts; the Documents & qualification, Quality & rating and Bank details tabs.
 */
export interface SupplierDepth {
  readonly overview?: ReactNode
  readonly now?: ReactNode
  readonly contacts?: ReactNode
  readonly documents?: ReactNode
  readonly quality?: ReactNode
  readonly bank?: ReactNode
  // B-W2b-324: a customer's W2b parts (areas/sales/customers/depth) in the same slot: `now` under the Overview's Now,
  // `contacts` under the contacts of Addresses & contacts (consent, lawful basis, personal-data actions), and these.
  /** Key numbers after the side's own (free credit, promises). */
  readonly numbers?: readonly Metric[]
  /** The side panel's status card, under the status pill (the hold and its reason). */
  readonly status?: ReactNode
  /** The side panel, after the status card (a rider's team, the requirements in force). */
  readonly aside?: ReactNode
  /** The Requirements tab. */
  readonly requirements?: ReactNode
  /** Tax & terms, after the side's own card (Hold, Customer PO number required). */
  readonly tax?: ReactNode
}

/**
 * SCR-033 Customer record and SCR-057 Supplier record (design sales.customers / purchasing.suppliers "records", 00 §2.2): one party
 * record, two sides, on RecordFrame (B-TH-260; the rule of picture 38, the tabs of picture 39 / 08-tabs O-SAL-CUST, O-PUR-SUP): the
 * band in the shell's band row — ‹ list, the name, ONE pill (its status), the code, identity, roles, VIES and freshness as its
 * details, "Projects (n)" opening this party's projects, the primary (Activate a prospect, else a customer's Check VIES), the Thread
 * button (⌘J) and ⋯ (Check VIES when Activate is the primary, Block / Unblock, Archive / Reactivate, Start a project, Copy code;
 * the frame's ONE Keyboard line lists the page's keys too). The party's thread is docked beside every tab (40 %): "Reply to
 * <this party>" only; Activity's tools are in its "⋯" (R-ACT), its files in its Files view. F-SA-270: the customer's record is its
 * own view (areas/sales/customers/record/view/CustomerRecordView.tsx); it shares the gate (PartyRecordGate), the band (usePartyBand)
 * and ./cards with this one, which draws the supplier's: Supplier 10 → 7: Overview & contacts, Items & prices, Documents &
 * questionnaire, Orders, Quality & rating, Bank details, Portal access. ONE notice in the body column. Fetches nothing:
 * PartyRecord.tsx reads and writes; the docked thread comes in as `thread`, its print form as `printThread`.
 */
export function PartyRecordView({ model, actions, thread, printThread, fields, items, portal, questionnaire, depth }: { model: PartyRecordModel; actions?: PartyRecordActions; thread?: ReactNode; printThread?: ReactNode; /* B-TH-280 */ fields?: ReactNode; items?: ReactNode; portal?: ReactNode; questionnaire?: ReactNode; depth?: SupplierDepth }) {
  return (
    <PartiesMessages>
      <PartyRecord model={model} actions={actions} thread={thread} printThread={printThread} fields={fields} items={items} portal={portal} questionnaire={questionnaire} depth={depth} />
    </PartiesMessages>
  )
}

/**
 * F-SA-270: the page's states before the party is read (no access, a failed read, loading), in the frame with no thread — the
 * same frame on both records. `children` draws the record once the party is read.
 */
export function PartyRecordGate({ model, actions, children }: { model: PartyRecordModel; actions?: PartyRecordActions | undefined; children: (party: Party) => ReactNode }) {
  const t = useT('parties')
  const side = model.side
  const config = SIDES[side]
  const listHref = sideHref(model.prefix, config)
  const backLink = <Link href={listHref}>{t(`${side}.title`)}</Link>
  const party = model.party
  const frameOf = (title: ReactNode, body: ReactNode) => (
    <RecordFrame recordType="Party" personId={model.personId ?? null} band={{ back: backLink, title, moreLabel: t('record.more') }} thread={null} threadLabel={t('record.dockLabel')}>
      {body}
    </RecordFrame>
  )

  // B-TH-260: the page's states before the party is read (no access, a failed read, loading) sit in the frame with no thread.
  if (!model.can.view) return frameOf(t(`${side}.noAccess.title`), <NoAccess title={t(`${side}.noAccess.title`)} body={t(`${side}.noAccess.body`)} />)
  if (model.problem && !party) {
    return frameOf(
      t(model.problem === 'problem.notFound' ? 'record.notFoundTitle' : model.problem === 'problem.forbidden' ? 'record.forbiddenTitle' : 'record.failedTitle'),
      <RecordProblem
        problem={model.problem}
        onRetry={actions?.onRetry}
        back={
          <Button size="sm" asChild>
            <Link href={listHref}>{t('record.backTo', { name: t(`${side}.title`) })}</Link>
          </Button>
        }
      />,
    )
  }
  if (!party) return frameOf(<Skeleton width={240} height={22} />, <RecordSkeleton />)
  return <>{children(party)}</>
}

/** F-SA-270: what a side changes in the shared band (the customer page's primary and extra ⋯ lines, F-SA-271). */
export interface PartyBandOptions {
  /** The band's primary in place of the shared rule's (null: none); absent: Activate a prospect, else a customer's Check VIES. */
  readonly primary?: ReactNode | null
  /** Lines added to ⋯ after Start a project (before Copy code). */
  readonly more?: readonly MenuItemDef[]
  /** Check VIES sits in ⋯ for every status (the primary is the side's own). */
  readonly viesInMore?: boolean
}

/**
 * F-SA-270: the band both records draw (one builder, rule 24) — ‹ list, the name, ONE status pill, the details line (code, country /
 * identity, roles, VIES, Projects (n), freshness), the primary, ⋯ and the page's keys — and what the cards need of it (`viesHeld`).
 */
export function usePartyBand(model: PartyRecordModel, party: Party, actions?: PartyRecordActions, options: PartyBandOptions = {}): { band: RecordBand; viesHeld: string | null } {
  const t = useT('parties')
  const locale = useLocale()
  const side = model.side
  const config = SIDES[side]
  const backLink = <Link href={sideHref(model.prefix, config)}>{t(`${side}.title`)}</Link>
  const open = (dialog: Parameters<NonNullable<PartyRecordActions['onDialog']>>[0]) => actions?.onDialog?.(dialog)
  const can = model.can
  const viesHeld = !can.vies ? t('held.vies') : party.status === 'ARCHIVED' ? t('held.archived') : model.viesRunning ? t('vies.checking') : null
  const viesLine = side === 'customers' && viesApplies(party)

  // The band's ONE primary: Activate a prospect, else a customer's Check VIES (then Check VIES goes into ⋯).
  const shared =
    party.status === 'PROSPECT' ? (
      <Button size="sm" variant="primary" onClick={() => actions?.onActivate?.()} heldReason={can.manage ? (model.busy ? t('common.saving') : null) : t('held.manage')}>
        {t(`${side}.activate`)}
      </Button>
    ) : viesLine ? (
      <Button size="sm" onClick={() => actions?.onCheckVies?.()} heldReason={viesHeld}>
        {t('vies.checkNow')}
      </Button>
    ) : null
  const primary = options.primary !== undefined ? options.primary : shared
  const viesInMenu = viesLine && (options.viesInMore === true || party.status === 'PROSPECT')

  const menu: MenuItemDef[] = [
    ...(viesInMenu ? [{ id: 'vies', label: t('vies.checkNow'), onSelect: () => actions?.onCheckVies?.(), disabled: !!viesHeld, description: viesHeld ?? undefined }] : []),
    ...(party.status === 'ACTIVE' ? [{ id: 'block', label: t('row.block'), onSelect: () => open({ kind: 'block' }), disabled: !can.block, description: can.block ? undefined : t('held.block') }] : []),
    ...(party.status === 'BLOCKED'
      ? [{ id: 'unblock', label: t('row.unblock'), onSelect: () => actions?.onUnblock?.(), disabled: !can.block, description: can.block ? undefined : t('held.block') }]
      : []),
    ...(party.status === 'ACTIVE' || party.status === 'PROSPECT'
      ? [{ id: 'archive', label: t('row.archive'), onSelect: () => open({ kind: 'archive' }), disabled: !can.manage, description: can.manage ? undefined : t('held.manage') }]
      : []),
    ...(party.status === 'BLOCKED' ? [{ id: 'archive-held', label: t('row.archive'), disabled: true, description: t('held.archiveBlocked') }] : []),
    ...(party.status === 'ARCHIVED'
      ? [{ id: 'reactivate', label: t('row.reactivate'), onSelect: () => actions?.onReactivate?.(), disabled: !can.manage, description: can.manage ? undefined : t('held.manage') }]
      : []),
    { id: 'sep', separator: true },
    // B-TH-260 (TH-5's Projects): a new project with this party as its outside company (`?party=`); held without projects.manage.
    ...(can.projects
      ? [
          {
            id: 'project',
            label: t('record.startProject'),
            href: can.projectsManage ? `${model.prefix}/products/projects?new=1&party=${encodeURIComponent(party.id)}` : undefined,
            disabled: !can.projectsManage,
            description: can.projectsManage ? undefined : t('held.projects', { right: rightRef('projects.manage') }),
          },
        ]
      : []),
    ...(options.more ?? []), // F-SA-270: the side's own lines (F-SA-271)
    { id: 'copy', label: t('record.copyCode', { code: party.code }), onSelect: () => actions?.onCopyCode?.() },
  ]
  // B-TH-260 (PR-14): the page's own keys, first in the band menu's ONE Keyboard line (⌘J, ⌘↵ and the thread's keys follow).
  const keys = [{ keys: ['←', '→'], label: t('keys.tabs') }, ...(side === 'suppliers' ? [{ keys: ['⌘', 'S'], label: t('keys.save') }] : [])]
  const meta =
    side === 'customers'
      ? [party.code, countryName(party.country, locale), party.taxMode ? t(`taxMode.${party.taxMode}`) : t('list.noIdentity')].join(' · ')
      : [party.code, party.vatNumber ?? party.fiscalCode ?? t('list.noIdentity'), countryName(party.country, locale)].join(' · ')
  const projects = model.projects ?? null
  const band: RecordBand = {
    back: backLink,
    title: partyName(party),
    status: <StatusPill status={party.status} />,
    meta: (
      <span className="fw-pty-tags">
        <span className="fw-pty-hint">{meta}</span>
        <RoleTags roles={party.roles} />
        {party.vies.state !== 'NOT_APPLICABLE' && <ViesMark standing={party.vies} />}
        {/* B-TH-260 (B-TH-070): this party's projects — the open ones counted, all of them behind the link. */}
        {can.projects && projects && (
          <Link className="fw-pty-link" href={`${model.prefix}/products/projects?party=${encodeURIComponent(party.id)}&view=all`}>
            <FolderKanban size={12} aria-hidden /> {t('record.projects', { count: projects.open })}
          </Link>
        )}
        <Freshness asOf={model.asOf} live={model.live} />
      </span>
    ),
    primary,
    more: menu,
    moreLabel: t('record.more'),
    keys,
  }
  return { band, viesHeld }
}

function PartyRecord({ model, actions, thread, printThread, fields, items, portal, questionnaire, depth }: { model: PartyRecordModel; actions?: PartyRecordActions; thread?: ReactNode; printThread?: ReactNode; /* B-TH-280 */ fields?: ReactNode; items?: ReactNode; portal?: ReactNode; questionnaire?: ReactNode; depth?: SupplierDepth }) {
  return <PartyRecordGate model={model} actions={actions}>{(party) => <PartyRecordBody model={model} party={party} actions={actions} thread={thread} printThread={printThread} fields={fields} items={items} portal={portal} questionnaire={questionnaire} depth={depth} />}</PartyRecordGate>
}

/** The supplier's record once read (F-SA-270: the customer's is areas/sales/customers/record/view/CustomerRecordView.tsx). */
function PartyRecordBody({ model, party, actions, thread, printThread, fields, items, portal, questionnaire, depth }: { model: PartyRecordModel; party: Party; actions?: PartyRecordActions | undefined; thread?: ReactNode; printThread?: ReactNode; fields?: ReactNode; items?: ReactNode; portal?: ReactNode; questionnaire?: ReactNode; depth?: SupplierDepth | undefined }) {
  const t = useT('parties')
  const side = model.side
  const config = SIDES[side]
  const can = model.can
  const editable = writable(party, can)
  const tabs = recordTabs(config, can)
  const tab: RecordTab = tabs.includes(model.tab) ? model.tab : 'overview'
  const recordPath = sideHref(model.prefix, config, `/${encodeURIComponent(party.id)}`)
  const activeContacts = party.contacts.filter((contact) => contact.status === 'ACTIVE')
  const ordersCount = model.purchaseOrders.items && !model.purchaseOrders.more ? model.purchaseOrders.items.length : null
  const tabItems: TabItem[] = tabs.map((id) => ({
    id,
    href: `${recordPath}${id === 'overview' ? '' : `?tab=${id}`}`,
    label: t(`${side}.tab.${id}`),
    // B-TH-260: a supplier's Overview & contacts counts its contacts (Contacts merged into it).
    count: id === 'overview' ? activeContacts.length : id === 'orders' ? ordersCount : undefined,
  }))
  const { band, viesHeld } = usePartyBand(model, party, actions)

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

          {tab === 'overview' && (
            // B-TH-260: Overview & contacts — the supplier's form and Now, then its contacts and what each receives (Purchasing's depth slot).
            <div className="fw-pty-stack">
              <SupplierOverview model={model} party={party} actions={actions} editable={editable} viesHeld={viesHeld} depth={depth} />
              <ContactsCard model={model} party={party} actions={actions} editable={editable} />
              {depth?.contacts}
            </div>
          )}
          {tab === 'orders' && <PurchaseOrdersTab model={model} />}
          {/* B-W2a-69: a supplier's Items & prices (Purchasing's Approved sources). */}
          {tab === 'items' && items}
          {/* B-W2b-180: Portal access (areas/sales/customers/portal, both sides; a refused invite keeps its real reason). */}
          {tab === 'portal' && portal}
          {tab === 'documents' && (
            // B-TH-260: Documents & questionnaire — B-W2b-334's documents, profile changes and qualifications, then B-W2b-172's
            // questionnaire (one onboarding place); the record's loose files are the docked thread's Files view.
            <div className="fw-pty-stack">
              {depth?.documents}
              {questionnaire && (
                <section id="supplier-questionnaire" className="fw-pty-anchor" aria-label={t('suppliers.questionnaireLabel')}>
                  {questionnaire}
                </section>
              )}
            </div>
          )}
          {tab === 'quality' && depth?.quality}
          {tab === 'bank' && depth?.bank}
        </div>
      </RecordFrame>
      <PartyDialogs model={model} party={party} actions={actions} />
    </>
  )
}

// ---- Overview ---------------------------------------------------------------------------------------------------------

/** The supplier's form (design suppliers.record.overview.main: EditModeBar ⌘S, leaving with changes asks). */
function SupplierForm({ model, party, actions, editable }: TabProps) {
  const t = useT('parties')
  const locale = useLocale()
  const read = useMemo(() => partyDraftOf(party), [party])
  const [draft, setDraft] = useState<PartyDraft>(model.draft ?? read)
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set())
  const [tried, setTried] = useState(false)
  useEffect(() => {
    setDraft(model.draft ?? read)
    setTouched(new Set())
    setTried(false)
  }, [read, model.draft])
  const problems = partyProblems(draft)
  const changed = (Object.keys(draft) as Array<keyof PartyDraft>).filter((field) => String(draft[field]) !== String(read[field]))
  const dirty = changed.length > 0
  const shown = (field: string) => {
    const problem = problems[field]
    if (problem && (tried || touched.has(field))) return t(problem.key, problem.params)
    return model.refused?.includes(field) ? t('form.refused') : undefined
  }
  useEffect(() => {
    actions?.onDirty?.(dirty)
  }, [actions, dirty])
  useEffect(() => {
    if (!dirty) return
    const onLeave = (event: BeforeUnloadEvent) => {
      event.preventDefault()
    }
    window.addEventListener('beforeunload', onLeave)
    return () => window.removeEventListener('beforeunload', onLeave)
  }, [dirty])
  const apply = async () => {
    setTried(true)
    if (!isReady(problems) || model.busy) return
    if (await actions?.onSaveParty?.(read, draft)) setTried(false)
  }
  const count = Object.keys(problems).length
  if (!editable) {
    return (
      <Card padded>
        <div className="fw-pty-card-body">
          <CardHead title={t('suppliers.overview.card')} />
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
              { label: t('field.paymentTerms'), value: dash(party.paymentTerms) },
              { label: t('field.internalNote'), value: dash(party.internalNote) },
            ]}
          />
        </div>
      </Card>
    )
  }
  return (
    <Card padded>
      <div className="fw-pty-card-body">
        <CardHead title={t('suppliers.overview.card')} />
        <PartyFields
          draft={draft}
          onChange={setDraft}
          shown={shown}
          leave={(field) => setTouched((current) => new Set(current).add(field))}
          side="suppliers"
          withTerms
          roles={['SUPPLIER', 'SUBCONTRACTOR', 'CARRIER', 'CUSTOMER', 'BRAND']}
        />
        {dirty && (
          <div className="fw-pty-bar">
            <EditModeBar
              message={t('form.unsaved', { count: changed.length })}
              count={changed.length}
              onDiscard={() => {
                setDraft(read)
                setTried(false)
              }}
              onApply={() => void apply()}
              applyLabel={t('common.save')}
              busy={model.busy}
              applyHeldReason={tried && count > 0 ? t('form.fixFirst', { count }) : null}
              saveShortcut
            />
          </div>
        )}
      </div>
    </Card>
  )
}

function SupplierOverview({ model, party, actions, editable, viesHeld, depth }: TabProps & { viesHeld: string | null; depth?: SupplierDepth | undefined }) {
  const t = useT('parties')
  const locale = useLocale()
  const { current } = identitiesOf(party)
  const pos = model.purchaseOrders
  const open = pos.items ? pos.items.filter((order) => OPEN_PURCHASE_ORDERS.has(order.status)) : null
  const currencies = open ? new Set(open.map((order) => order.currency)) : new Set<string>()
  const value =
    open && model.can.cost && currencies.size === 1 && open.every((order) => order.netAmount !== undefined)
      ? money(
          open.reduce((total, order) => total + (order.netAmount ?? 0), 0),
          [...currencies][0]!,
          locale,
        )
      : null
  const main = (
    <div className="fw-pty-stack">
      <SupplierForm model={model} party={party} actions={actions} editable={editable} />
      {/* B-W2b-334: kinds, status, origin and closures (Purchasing's depth slot). */}
      {depth?.overview}
      <IdentityCard model={model} party={party} current={current} actions={actions} editable={editable} compact viesHeld={viesHeld} />
      <AddressesCard model={model} party={party} actions={actions} editable={editable} />
    </div>
  )
  const orders = model.can.purchaseOrders ? (
    <Card padded>
      <div className="fw-pty-card-body">
        <CardHead title={t('suppliers.side.orders')} />
        {open === null ? (
          <p className="fw-pty-hint">{t(pos.problem ? 'tile.unknown' : 'numbers.reading')}</p>
        ) : (
          <KeyValue
            dense
            labelCase="sentence"
            items={[
              { label: t('suppliers.side.openOrders'), value: pos.more ? '—' : String(open.length) },
              ...(model.can.cost && value ? [{ label: t('suppliers.side.openValue'), value }] : []),
              { label: t('suppliers.side.waiting'), value: pos.more ? '—' : String(open.filter((order) => order.status === 'SENT').length) },
            ]}
          />
        )}
      </div>
    </Card>
  ) : null
  return (
    <RecordLayout
      main={main}
      aside={
        <SidePanel model={model} party={party} actions={actions} editable={editable} viesHeld={viesHeld}>
          {depth?.now}
          {orders}
        </SidePanel>
      }
      asideLabel={t('side.label')}
    />
  )
}

// ---- Orders -----------------------------------------------------------------------------------------------------------

function PurchaseOrdersTab({ model }: { model: PartyRecordModel }) {
  const t = useT('parties')
  const locale = useLocale()
  const loaded = model.purchaseOrders
  const cost = model.can.cost
  return (
    <Card padded>
      <div className="fw-pty-card-body">
        <CardHead title={t('suppliers.tab.orders')} />
        {loaded.problem ? (
          <ReadState problem={loaded.problem} loading={false} failedTitle={t('pos.failed')} />
        ) : loaded.items === null ? (
          <ReadState loading rows={4} />
        ) : loaded.items.length === 0 ? (
          <p className="fw-pty-hint">{t('pos.empty')}</p>
        ) : (
          <SummaryTable
            label={t('suppliers.tab.orders')}
            stackOnPhone
            columns={[t('pos.col.number'), t('pos.col.status'), t('pos.col.ordered'), t('pos.col.needed'), t('pos.col.confirmed'), t('pos.col.lines'), ...(cost ? [t('pos.col.value')] : [])]}
            align={Array.from({ length: cost ? 7 : 6 }, (_, index) => (index >= 5 ? 'right' : 'left'))}
            rows={loaded.items.map((order) => ({
              id: order.id,
              cells: [
                <span key="n" className="fw-pty-code">
                  {order.number}
                </span>,
                t(`poStatus.${order.status}`),
                formatDate(order.orderDate, { locale }),
                order.requestedDate ? formatDate(order.requestedDate, { locale }) : '—',
                order.latestConfirmedDate ? formatDate(order.latestConfirmedDate, { locale }) : order.confirmedAt ? formatDate(order.confirmedAt, { locale }) : '—',
                String(order.lineCount),
                ...(cost ? [dash(money(order.netAmount, order.currency, locale))] : []),
              ],
            }))}
          />
        )}
        {loaded.more && <p className="fw-pty-hint">{t('deals.more')}</p>}
      </div>
    </Card>
  )
}

export type { PartyRow }
