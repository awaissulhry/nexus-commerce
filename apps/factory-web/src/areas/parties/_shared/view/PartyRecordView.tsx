'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { FolderKanban, MapPin, MoreHorizontal, Plus, Table2, Users } from 'lucide-react'
import { Banner, Card, KeyValue, Menu, MetricStrip, RecordLayout, SummaryTable, Tabs, type MenuItemDef, type Metric, type TabItem } from '@nexus/ui/components'
import { Button, Checkbox, SegmentedControl, Skeleton, Tag, Toggle } from '@nexus/ui/primitives'
import { EditModeBar } from '../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import type { Address, Contact, Party, PartyRow, TaxIdentity } from '../api'
import {
  addressDraftOf,
  blankIdentity,
  contactDraftOf,
  countryName,
  dealRows,
  identitiesOf,
  identityDraftOf,
  isReady,
  keyNumbers,
  languageName,
  mainContacts,
  money,
  nextSteps,
  OPEN_PURCHASE_ORDERS,
  partyDraftOf,
  partyName,
  partyProblems,
  RESULT_TONE,
  recordTabs,
  sideHref,
  SIDES,
  viesApplies,
  WARNING_ACTION,
  writable,
  type AddressDraft,
  type ContactDraft,
  type DealFilter,
  type IdentityDraft,
  type PartyDraft,
  type PartyRecordModel,
  type RecordDialog,
  type RecordTab,
} from '../model'
import { AddressModal, ArchiveModal, BlockModal, ContactModal, EditPartyModal, IdentityModal, PartyFields } from './dialogs'
import { dash, Freshness, NoAccess, NoticeBanner, PartiesMessages, ReadState, RecordProblem, RecordSkeleton, RoleTags, StatusPill, ViesMark } from './parts'
// ---- B-TH-260: the party on RecordFrame (the band in the shell's row, the docked thread, one notice) ----
import { RecordFrame, useRecordFrame } from '../../../_shared/record-frame/RecordFrame'
import { RecordNotices } from '../../../_shared/record-frame/RecordNotices'
import { rightRef } from '../../../../lib/i18n/rights'

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
 * <this party>" only; Activity's tools are in its "⋯" (R-ACT), its files in its Files view. Customer 8 → 5: Overview, Addresses &
 * contacts, Terms & requirements, Quotes & orders ("Open this customer's sheet"), Portal access (a refused invite keeps its real
 * reason here). Supplier 10 → 7: Overview & contacts, Items & prices, Documents & questionnaire, Orders, Quality & rating, Bank
 * details, Portal access. ONE notice in the body column. Fetches nothing: PartyRecord.tsx reads and writes; the docked thread comes
 * in as `thread`, its print form as `printThread`.
 */
export function PartyRecordView({ model, actions, thread, printThread, fields, terms, items, overview, portal, questionnaire, depth }: { model: PartyRecordModel; actions?: PartyRecordActions; thread?: ReactNode; printThread?: ReactNode; /* B-TH-280 */ fields?: ReactNode; terms?: ReactNode; items?: ReactNode; overview?: OverviewSlot; portal?: ReactNode; questionnaire?: ReactNode; depth?: SupplierDepth }) {
  return (
    <PartiesMessages>
      <PartyRecord model={model} actions={actions} thread={thread} printThread={printThread} fields={fields} terms={terms} items={items} overview={overview} portal={portal} questionnaire={questionnaire} depth={depth} />
    </PartiesMessages>
  )
}

/** B-TH-260: an old address that asked for the gone Documents tab shows the thread once (its files are the thread's Files view). */
function ShowThreadOnArrival() {
  const frame = useRecordFrame()
  const show = frame?.showThread
  useEffect(() => {
    show?.()
    // Once, on arrival.
  }, [])
  return null
}

function PartyRecord({ model, actions, thread, printThread, fields, terms, items, overview, portal, questionnaire, depth }: { model: PartyRecordModel; actions?: PartyRecordActions; thread?: ReactNode; printThread?: ReactNode; /* B-TH-280 */ fields?: ReactNode; terms?: ReactNode; items?: ReactNode; overview?: OverviewSlot; portal?: ReactNode; questionnaire?: ReactNode; depth?: SupplierDepth }) {
  const t = useT('parties')
  const locale = useLocale()
  const side = model.side
  const config = SIDES[side]
  const listHref = sideHref(model.prefix, config)
  const backLink = <Link href={listHref}>{t(`${side}.title`)}</Link>
  const party = model.party
  const open = (dialog: RecordDialog | null) => actions?.onDialog?.(dialog)
  const frameOf = (title: ReactNode, children: ReactNode) => (
    <RecordFrame recordType="Party" personId={model.personId ?? null} band={{ back: backLink, title, moreLabel: t('record.more') }} thread={null} threadLabel={t('record.dockLabel')}>
      {children}
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

  const can = model.can
  const editable = writable(party, can)
  const tabs = recordTabs(config, can)
  const tab: RecordTab = tabs.includes(model.tab) ? model.tab : 'overview'
  const recordPath = sideHref(model.prefix, config, `/${encodeURIComponent(party.id)}`)
  const activeAddresses = party.addresses.filter((address) => address.status === 'ACTIVE')
  const activeContacts = party.contacts.filter((contact) => contact.status === 'ACTIVE')
  const ordersCount =
    side === 'customers'
      ? model.quotes.items && model.orders.items && !model.quotes.more && !model.orders.more
        ? model.quotes.items.length + model.orders.items.length
        : null
      : model.purchaseOrders.items && !model.purchaseOrders.more
        ? model.purchaseOrders.items.length
        : null
  const tabItems: TabItem[] = tabs.map((id) => ({
    id,
    href: `${recordPath}${id === 'overview' ? '' : `?tab=${id}`}`,
    label: t(`${side}.tab.${id}`),
    // B-TH-260: a supplier's Overview & contacts counts its contacts (Contacts merged into it).
    count: id === 'addresses' ? activeAddresses.length + activeContacts.length : id === 'overview' && side === 'suppliers' ? activeContacts.length : id === 'orders' ? ordersCount : undefined,
  }))
  const viesHeld = !can.vies ? t('held.vies') : party.status === 'ARCHIVED' ? t('held.archived') : model.viesRunning ? t('vies.checking') : null
  const viesLine = side === 'customers' && viesApplies(party)

  // The band's ONE primary: Activate a prospect, else a customer's Check VIES (then Check VIES goes into ⋯).
  const primary =
    party.status === 'PROSPECT' ? (
      <Button size="sm" variant="primary" onClick={() => actions?.onActivate?.()} heldReason={can.manage ? (model.busy ? t('common.saving') : null) : t('held.manage')}>
        {t(`${side}.activate`)}
      </Button>
    ) : viesLine ? (
      <Button size="sm" onClick={() => actions?.onCheckVies?.()} heldReason={viesHeld}>
        {t('vies.checkNow')}
      </Button>
    ) : null

  const menu: MenuItemDef[] = [
    ...(party.status === 'PROSPECT' && viesLine ? [{ id: 'vies', label: t('vies.checkNow'), onSelect: () => actions?.onCheckVies?.(), disabled: !!viesHeld, description: viesHeld ?? undefined }] : []),
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
    { id: 'copy', label: t('record.copyCode', { code: party.code }), onSelect: () => actions?.onCopyCode?.() },
  ]
  // B-TH-260 (PR-14): the page's own keys, first in the band menu's ONE Keyboard line (⌘J, ⌘↵ and the thread's keys follow).
  const keys = [{ keys: ['←', '→'], label: t('keys.tabs') }, ...(side === 'suppliers' ? [{ keys: ['⌘', 'S'], label: t('keys.save') }] : [])]
  const { current } = identitiesOf(party)
  const meta =
    side === 'customers'
      ? [party.code, countryName(party.country, locale), party.taxMode ? t(`taxMode.${party.taxMode}`) : t('list.noIdentity')].join(' · ')
      : [party.code, party.vatNumber ?? party.fiscalCode ?? t('list.noIdentity'), countryName(party.country, locale)].join(' · ')
  const projects = model.projects ?? null
  const dialog = model.dialog ?? null
  const editingAddress = dialog?.kind === 'address' && dialog.addressId ? party.addresses.find((address) => address.id === dialog.addressId) : undefined
  const editingContact = dialog?.kind === 'contact' && dialog.contactId ? party.contacts.find((contact) => contact.id === dialog.contactId) : undefined

  return (
    <>
      <RecordFrame
        recordType="Party"
        personId={model.personId ?? null}
        threadLabel={t('record.dockLabelOf', { name: partyName(party) })}
        thread={thread ?? null}
        printThread={printThread}
        fields={fields /* B-TH-280: the custom fields, on the Overview only */}
        band={{
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
        }}
      >
        <div className="fw-pty">
          {model.threadOnArrival && <ShowThreadOnArrival />}
          <Tabs ariaLabel={t('record.tabsLabel')} tabs={tabItems} active={tab} size="sm" overflow="scroll" />
          {/* B-TH-260: ONE notice in the body column, the most serious first; the rest behind "N more notices". */}
          <RecordNotices>
            {party.status === 'BLOCKED' && (
              <Banner tone="danger" title={t(`${side}.blockedBanner`, { date: party.blocked ? formatDate(party.blocked.at, { locale }) : '—' })}>
                {party.blocked?.reason ? <p className="fw-pty-hint">{t('record.blockedReason', { reason: party.blocked.reason })}</p> : null}
              </Banner>
            )}
            {model.notice ? <NoticeBanner notice={model.notice} onDismiss={actions?.onDismissNotice} /> : null}
            {model.changedAt && (
              <Banner
                tone="warning"
                title={t('record.changed', { time: formatDateTime(model.changedAt, { locale }) })}
                action={
                  <Button size="sm" onClick={() => actions?.onReload?.()}>
                    {t('record.reload')}
                  </Button>
                }
              />
            )}
            {party.status === 'ARCHIVED' && <Banner tone="info" title={t('record.archivedBanner')} />}
            {!can.manage && party.status !== 'ARCHIVED' && <Banner tone="info" title={t('record.readOnly')} />}
          </RecordNotices>

          {tab === 'overview' && side === 'customers' && <CustomerOverview model={model} party={party} actions={actions} editable={editable} viesHeld={viesHeld} overview={overview} depth={depth} />}
          {tab === 'overview' && side === 'suppliers' && (
            // B-TH-260: Overview & contacts — the supplier's form and Now, then its contacts and what each receives (Purchasing's depth slot).
            <div className="fw-pty-stack">
              <SupplierOverview model={model} party={party} actions={actions} editable={editable} viesHeld={viesHeld} depth={depth} />
              <ContactsCard model={model} party={party} actions={actions} editable={editable} />
              {depth?.contacts}
            </div>
          )}
          {tab === 'addresses' && (
            <div className="fw-pty-stack">
              <AddressesCard model={model} party={party} actions={actions} editable={editable} />
              <ContactsCard model={model} party={party} actions={actions} editable={editable} />
              {/* B-W2b-324: consent, lawful basis and the personal-data actions (Sales' depth slot). */}
              {side === 'customers' && depth?.contacts}
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
              {side === 'customers' && depth?.tax}
              {side === 'customers' && depth?.requirements && (
                <section id="party-requirements" className="fw-pty-anchor" aria-label={t('customers.requirementsLabel')}>
                  {depth.requirements}
                </section>
              )}
            </div>
          )}
          {tab === 'orders' && side === 'customers' && (
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
          {tab === 'orders' && side === 'suppliers' && <PurchaseOrdersTab model={model} />}
          {/* B-W2a-69: a supplier's Items & prices (Purchasing's Approved sources). */}
          {tab === 'items' && side === 'suppliers' && items}
          {/* B-W2b-180: Portal access (areas/sales/customers/portal, both sides; a refused invite keeps its real reason). */}
          {tab === 'portal' && portal}
          {tab === 'documents' && side === 'suppliers' && (
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
          {tab === 'quality' && side === 'suppliers' && depth?.quality}
          {tab === 'bank' && side === 'suppliers' && depth?.bank}
        </div>
      </RecordFrame>

      <EditPartyModal
        side={side}
        open={dialog?.kind === 'edit'}
        busy={model.busy}
        problem={model.dialogProblem}
        refused={model.refused}
        initial={partyDraftOf(party)}
        onSave={(after) => void actions?.onSaveParty?.(partyDraftOf(party), after)}
        onClose={() => open(null)}
      />
      <BlockModal
        side={side}
        open={dialog?.kind === 'block'}
        names={[partyName(party)]}
        busy={model.busy}
        problem={model.dialogProblem}
        onBlock={(reason) => actions?.onBlock?.(reason)}
        onClose={() => open(null)}
      />
      <ArchiveModal
        side={side}
        open={dialog?.kind === 'archive'}
        names={[partyName(party)]}
        busy={model.busy}
        problem={model.dialogProblem}
        onArchive={() => actions?.onArchive?.()}
        onClose={() => open(null)}
      />
      <AddressModal
        open={dialog?.kind === 'address'}
        editing={!!editingAddress}
        busy={model.busy}
        problem={model.dialogProblem}
        refused={model.refused}
        initial={model.addressDraft ?? (editingAddress ? addressDraftOf(editingAddress) : undefined)}
        partyCountry={party.country}
        first={activeAddresses.length === 0}
        onSave={(draft) => actions?.onSaveAddress?.(draft, editingAddress?.id)}
        onClose={() => open(null)}
      />
      <ContactModal
        side={side}
        open={dialog?.kind === 'contact'}
        editing={!!editingContact}
        busy={model.busy}
        problem={model.dialogProblem}
        refused={model.refused}
        initial={model.contactDraft ?? (editingContact ? contactDraftOf(editingContact) : undefined)}
        others={party.contacts.filter((contact) => contact.id !== editingContact?.id)}
        onSave={(draft) => actions?.onSaveContact?.(draft, editingContact?.id)}
        onClose={() => open(null)}
      />
      <IdentityModal
        open={dialog?.kind === 'identity'}
        mode={dialog?.kind === 'identity' ? dialog.mode : 'new'}
        busy={model.busy}
        problem={model.dialogProblem}
        refused={model.refused}
        initial={
          model.identityDraft ??
          (dialog?.kind === 'identity' && dialog.mode === 'correct' && current ? identityDraftOf(current) : { ...(current ? identityDraftOf(current) : blankIdentity(party.country)), validFrom: '' })
        }
        first={!current}
        onSave={(draft) => actions?.onSaveIdentity?.(draft, dialog?.kind === 'identity' ? dialog.mode : 'new')}
        onClose={() => open(null)}
      />
    </>
  )
}

// ---- Overview ---------------------------------------------------------------------------------------------------------

type TabProps = { model: PartyRecordModel; party: Party; actions?: PartyRecordActions; editable: boolean }

function CardHead({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="fw-pty-card-head">
      <h2 className="fw-pty-card-title">{title}</h2>
      {action}
    </div>
  )
}

/** What the record still lacks, most serious first, each with the step that fixes it (the side panel). */
function NextSteps({ model, party, actions, editable, viesHeld }: TabProps & { viesHeld: string | null }) {
  const t = useT('parties')
  const steps = nextSteps(party.warnings)
  const side = model.side
  const tabHref = (tab: RecordTab) => `${sideHref(model.prefix, SIDES[side], `/${encodeURIComponent(party.id)}`)}?tab=${tab}`
  const button = (code: (typeof steps)[number]['code']) => {
    const action = WARNING_ACTION[code]
    const held = action === 'vies' ? viesHeld : editable ? null : t('held.manage')
    const onClick =
      action === 'vies'
        ? () => actions?.onCheckVies?.()
        : action === 'identity'
          ? () => actions?.onDialog?.({ kind: 'identity', mode: 'new' })
          : action === 'correctIdentity'
            ? () => actions?.onDialog?.({ kind: 'identity', mode: 'correct' })
            : action === 'address'
              ? () => actions?.onDialog?.({ kind: 'address' })
              : action === 'contact'
                ? () => actions?.onDialog?.({ kind: 'contact' })
                : () => actions?.onDialog?.({ kind: 'edit' })
    if (action === 'edit' && side === 'suppliers') return null
    if ((action === 'address' || action === 'contact') && side === 'customers') {
      return (
        <Button size="sm" asChild>
          <Link href={tabHref('addresses')}>{t(`step.action.${action}`)}</Link>
        </Button>
      )
    }
    return (
      <Button size="sm" onClick={onClick} heldReason={held}>
        {t(`step.action.${action}`)}
      </Button>
    )
  }
  if (steps.length === 0) return <p className="fw-pty-hint">{t(`${side}.step.none`)}</p>
  return (
    <ul className="fw-pty-steps">
      {steps.map((step, index) => (
        <li key={step.code} className="fw-pty-step">
          <span className="fw-pty-cell-row">
            {step.blocksInvoice && <Tag tone="danger">{t('step.blocksInvoice')}</Tag>}
            <span>{t(`warning.${step.code}`)}</span>
          </span>
          {/* One button per kind of step: three address warnings get one "Add address". */}
          {steps.findIndex((other) => WARNING_ACTION[other.code] === WARNING_ACTION[step.code]) === index && button(step.code)}
        </li>
      ))}
    </ul>
  )
}

function SidePanel({ model, party, actions, editable, viesHeld, children, status }: TabProps & { viesHeld: string | null; children?: ReactNode; status?: ReactNode }) {
  const t = useT('parties')
  const locale = useLocale()
  const lastCheck = party.viesChecks[0] ?? null
  const role = 'ORDERS' as const
  const receivers = mainContacts(party, role)
  const invoices = mainContacts(party, 'INVOICES')
  return (
    <div className="fw-pty-side">
      <Card padded>
        <div className="fw-pty-card-body">
          <CardHead title={t('side.status')} />
          <span className="fw-pty-tags">
            <StatusPill status={party.status} />
            {party.invoiceBlocked && model.side === 'customers' && <Tag tone="danger">{t('list.cannotInvoice')}</Tag>}
          </span>
          <p className="fw-pty-hint">
            {party.status === 'BLOCKED' && party.blocked
              ? t('side.blockedSince', { date: formatDate(party.blocked.at, { locale }) })
              : t('side.createdOn', { date: formatDate(party.createdAt, { locale }) })}
          </p>
          {/* B-W2b-324: the hold and its reason (a customer's depth slot). */}
          {status}
        </div>
      </Card>
      <Card padded>
        <div className="fw-pty-card-body">
          <CardHead title={t('side.next')} />
          <NextSteps model={model} party={party} actions={actions} editable={editable} viesHeld={viesHeld} />
        </div>
      </Card>
      {viesApplies(party) && (
        <Card padded>
          <div className="fw-pty-card-body">
            <CardHead title={t('side.vies')} />
            <ViesMark standing={party.vies} check={lastCheck} onCheck={() => actions?.onCheckVies?.()} checkHeld={viesHeld} busy={model.viesRunning} />
            <p className="fw-pty-hint">{t(`vies.meaning.${party.vies.state}`, { days: party.vies.maxAgeDays })}</p>
          </div>
        </Card>
      )}
      {children}
      <Card padded>
        <div className="fw-pty-card-body">
          <CardHead title={t(`${model.side}.side.contacts`)} />
          {receivers.length === 0 && (model.side === 'suppliers' || invoices.length === 0) ? (
            <p className="fw-pty-hint">{t(`${model.side}.side.noContacts`)}</p>
          ) : (
            <ul className="fw-pty-list">
              {[...receivers.map((contact) => ({ contact, role: 'ORDERS' as const })), ...(model.side === 'customers' ? invoices.map((contact) => ({ contact, role: 'INVOICES' as const })) : [])].map(
                ({ contact, role: held }) => (
                  <li key={`${contact.id}-${held}`}>
                    <span className="fw-pty-cell">
                      <span className="fw-pty-name">{contact.name}</span>
                      <span className="fw-pty-hint">{dash(contact.email)}</span>
                    </span>
                    <Tag>{t(`contactRole.${held}`)}</Tag>
                  </li>
                ),
              )}
            </ul>
          )}
        </div>
      </Card>
    </div>
  )
}

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

// ---- Addresses and contacts -------------------------------------------------------------------------------------------

function AddressesCard({ model, party, actions, editable }: TabProps) {
  const t = useT('parties')
  const locale = useLocale()
  const held = editable ? null : model.can.manage ? t('held.archived') : t('held.manage')
  const rows = party.addresses
  const toggle = (address: Address, which: 'billTo' | 'shipTo') => {
    const on = which === 'billTo' ? address.isDefaultBillTo : address.isDefaultShipTo
    const kind = which === 'billTo' ? 'BILL_TO' : 'SHIP_TO'
    // A default needs its use; an archived address is no default; without the right the value is text, not a greyed switch.
    if (!address.kinds.includes(kind) || address.status !== 'ACTIVE') return <span className="fw-pty-hint">—</span>
    if (!editable) return t(on ? 'common.yes' : 'common.no')
    return (
      <span className="fw-pty-cell-row">
        <Toggle
          size="sm"
          checked={on}
          aria-label={t(`address.default.${which}`, { name: address.name ?? address.line1 })}
          onChange={(next) => {
            if (!model.saving) actions?.onDefault?.(which, next ? address.id : null)
          }}
        />
        {model.saving === `${which}:${address.id}` && <span className="fw-pty-hint">{t('common.saving')}</span>}
      </span>
    )
  }
  const menu = (address: Address): MenuItemDef[] => [
    { id: 'edit', label: t('common.edit'), onSelect: () => actions?.onDialog?.({ kind: 'address', addressId: address.id }), disabled: !editable, description: held ?? undefined },
    address.status === 'ACTIVE'
      ? { id: 'archive', label: t('address.archive'), onSelect: () => actions?.onAddressStatus?.(address.id, 'ARCHIVED'), disabled: !editable, description: held ?? t('address.archiveHint') }
      : { id: 'restore', label: t('address.restore'), onSelect: () => actions?.onAddressStatus?.(address.id, 'ACTIVE'), disabled: !editable, description: held ?? undefined },
  ]
  const isCustomer = model.side === 'customers'
  return (
    <Card padded>
      <div className="fw-pty-card-body">
        <CardHead
          title={t('address.title')}
          action={
            <Button size="sm" onClick={() => actions?.onDialog?.({ kind: 'address' })} heldReason={held}>
              <Plus size={14} aria-hidden /> {t('address.add')}
            </Button>
          }
        />
        {rows.length === 0 ? (
          <ReadState
            loading={false}
            empty={{
              icon: <MapPin size={22} aria-hidden />,
              title: t('address.empty'),
              body: t(`${model.side}.address.emptyBody`),
              action: (
                <Button size="sm" variant="primary" onClick={() => actions?.onDialog?.({ kind: 'address' })} heldReason={held}>
                  {t('address.addRegistered')}
                </Button>
              ),
            }}
          />
        ) : (
          <>
            <SummaryTable
              label={t('address.title')}
              stackOnPhone
              density="roomy"
              columns={[
                t('address.col.kinds'),
                t('address.col.address'),
                t('address.col.contact'),
                ...(isCustomer ? [t('address.col.billTo'), t('address.col.shipTo')] : []),
                t('address.col.status'),
                t('list.col.actions'),
              ]}
              widths={isCustomer ? ['17%', '29%', '16%', '9%', '9%', '10%', '80px'] : ['22%', '34%', '20%', '12%', '80px']}
              align={Array.from({ length: isCustomer ? 7 : 5 }, () => 'left' as const)}
              rows={rows.map((address) => ({
                id: address.id,
                cells: [
                  <span key="k" className="fw-pty-tags">
                    {address.kinds.map((kind) => (
                      <Tag key={kind}>{t(`addressKind.${kind}`)}</Tag>
                    ))}
                  </span>,
                  <span key="a" className="fw-pty-cell">
                    {address.name && <span className="fw-pty-name">{address.name}</span>}
                    <span>{[address.line1, address.line2].filter(Boolean).join(', ')}</span>
                    <span className="fw-pty-hint">{[address.postalCode, address.city, address.province, countryName(address.country, locale)].filter(Boolean).join(' · ')}</span>
                    {address.deliveryNotes && <span className="fw-pty-hint">{address.deliveryNotes}</span>}
                  </span>,
                  <span key="c" className="fw-pty-cell">
                    <span>{dash(address.contactName)}</span>
                    {address.phone && <span className="fw-pty-hint">{address.phone}</span>}
                  </span>,
                  ...(isCustomer ? [toggle(address, 'billTo'), toggle(address, 'shipTo')] : []),
                  address.status === 'ACTIVE' ? (
                    <Tag key="s" tone="success">
                      {t('master.ACTIVE')}
                    </Tag>
                  ) : (
                    <Tag key="s">{t('master.ARCHIVED')}</Tag>
                  ),
                  <Menu
                    key="m"
                    align="right"
                    label={<MoreHorizontal size={16} aria-hidden />}
                    triggerProps={{ 'aria-label': t('address.menu', { name: address.name ?? address.line1 }) }}
                    items={menu(address)}
                  />,
                ],
              }))}
            />
            <p className="fw-pty-hint">{t('address.sentKeepCopy')}</p>
          </>
        )}
      </div>
    </Card>
  )
}

function ContactsCard({ model, party, actions, editable }: TabProps) {
  const t = useT('parties')
  const locale = useLocale()
  const held = editable ? null : model.can.manage ? t('held.archived') : t('held.manage')
  const supplier = model.side === 'suppliers'
  const rows = party.contacts
  const menu = (contact: Contact): MenuItemDef[] => [
    { id: 'edit', label: t('common.edit'), onSelect: () => actions?.onDialog?.({ kind: 'contact', contactId: contact.id }), disabled: !editable, description: held ?? undefined },
    contact.status === 'ACTIVE'
      ? { id: 'archive', label: t('contact.archive'), onSelect: () => actions?.onContactStatus?.(contact.id, 'ARCHIVED'), disabled: !editable, description: held ?? t('contact.archiveHint') }
      : { id: 'restore', label: t('contact.restore'), onSelect: () => actions?.onContactStatus?.(contact.id, 'ACTIVE'), disabled: !editable, description: held ?? undefined },
  ]
  const receives = (contact: Contact) => {
    const on = contact.roles.includes('ORDERS')
    if (contact.status !== 'ACTIVE') return <span className="fw-pty-hint">—</span>
    if (!editable) return t(on ? 'common.yes' : 'common.no')
    if (!contact.email && !on) return <span className="fw-pty-hint">{t('held.noEmail')}</span>
    return (
      <span className="fw-pty-cell-row">
        <Checkbox
          aria-label={t('contact.receivesPosOf', { name: contact.name })}
          checked={on}
          onChange={(event) => {
            if (!model.saving) actions?.onReceivesOrders?.(contact.id, event.target.checked)
          }}
        />
        {model.saving === `orders:${contact.id}` && <span className="fw-pty-hint">{t('common.saving')}</span>}
      </span>
    )
  }
  return (
    <Card padded>
      <div className="fw-pty-card-body">
        <CardHead
          title={t(supplier ? 'suppliers.contacts.title' : 'contact.title')}
          action={
            <Button size="sm" onClick={() => actions?.onDialog?.({ kind: 'contact' })} heldReason={held}>
              <Plus size={14} aria-hidden /> {t('contact.add')}
            </Button>
          }
        />
        {rows.length === 0 ? (
          <ReadState
            loading={false}
            empty={{
              icon: <Users size={22} aria-hidden />,
              title: t(`${model.side}.contacts.empty`),
              body: t(`${model.side}.contacts.emptyBody`),
              action: (
                <Button size="sm" variant="primary" onClick={() => actions?.onDialog?.({ kind: 'contact' })} heldReason={held}>
                  {t(`${model.side}.contacts.addFirst`)}
                </Button>
              ),
            }}
          />
        ) : (
          <SummaryTable
            label={t(supplier ? 'suppliers.contacts.title' : 'contact.title')}
            stackOnPhone
            density="roomy"
            columns={[
              t('contact.col.name'),
              t('contact.col.email'),
              t('contact.col.phone'),
              ...(supplier ? [t('contact.col.receivesPos')] : []),
              t('contact.col.roles'),
              t('contact.col.language'),
              t('contact.col.status'),
              t('list.col.actions'),
            ]}
            widths={supplier ? ['17%', '20%', '12%', '14%', '14%', '8%', '8%', '80px'] : ['20%', '24%', '13%', '17%', '10%', '8%', '80px']}
            align={Array.from({ length: supplier ? 8 : 7 }, () => 'left' as const)}
            rows={rows.map((contact) => ({
              id: contact.id,
              cells: [
                <span key="n" className="fw-pty-name">
                  {contact.name}
                </span>,
                dash(contact.email),
                dash(contact.phone),
                ...(supplier ? [receives(contact)] : []),
                contact.roles.length === 0 ? (
                  <span key="r" className="fw-pty-hint">
                    {t('contact.noRole')}
                  </span>
                ) : (
                  <span key="r" className="fw-pty-tags">
                    {contact.roles.map((role) => (
                      <Tag key={role}>{t(`contactRole.${role}`)}</Tag>
                    ))}
                  </span>
                ),
                contact.language ? (
                  languageName(contact.language, locale)
                ) : (
                  <span key="l" className="fw-pty-hint">
                    {t('field.partyLanguage')}
                  </span>
                ),
                contact.status === 'ACTIVE' ? (
                  <Tag key="s" tone="success">
                    {t('master.ACTIVE')}
                  </Tag>
                ) : (
                  <Tag key="s">{t('master.ARCHIVED')}</Tag>
                ),
                <Menu key="m" align="right" label={<MoreHorizontal size={16} aria-hidden />} triggerProps={{ 'aria-label': t('contact.menu', { name: contact.name }) }} items={menu(contact)} />,
              ],
            }))}
          />
        )}
      </div>
    </Card>
  )
}

// ---- Tax & terms ------------------------------------------------------------------------------------------------------

function IdentityCard({ model, party, current, actions, editable, compact = false, viesHeld }: TabProps & { current: TaxIdentity | null; compact?: boolean; viesHeld?: string | null }) {
  const t = useT('parties')
  const locale = useLocale()
  const held = editable ? null : model.can.manage ? t('held.archived') : t('held.manage')
  const others = party.taxIdentities.filter((identity) => identity !== current)
  const items = current
    ? [
        { label: t('field.taxCountry'), value: countryName(current.country, locale) },
        { label: t('field.taxMode'), value: t(`taxMode.${current.taxMode}`) },
        { label: t(current.taxMode === 'EXTRA_EU' ? 'field.foreignTaxId' : 'field.vatNumber'), value: <span className="fw-pty-code">{dash(current.vatNumber)}</span> },
        ...(current.taxMode === 'IT_B2B' || current.taxMode === 'IT_B2C'
          ? [
              { label: t('field.fiscalCode'), value: <span className="fw-pty-code">{dash(current.fiscalCode)}</span> },
              { label: t('field.sdi'), value: <span className="fw-pty-code">{dash(current.sdiRecipientCode)}</span> },
              { label: t('field.pec'), value: dash(current.pec) },
            ]
          : []),
        { label: t('field.validFrom'), value: formatDate(current.validFrom, { locale }) },
        ...(compact && viesApplies(party)
          ? [
              {
                label: t('side.vies'),
                value: <ViesMark standing={party.vies} check={party.viesChecks[0] ?? null} onCheck={() => actions?.onCheckVies?.()} checkHeld={viesHeld} busy={model.viesRunning} />,
              },
            ]
          : []),
      ]
    : []
  return (
    <Card padded>
      <div className="fw-pty-card-body">
        <CardHead
          title={t('identity.title')}
          action={
            <span className="fw-pty-actions">
              {current && (
                <Button size="sm" onClick={() => actions?.onDialog?.({ kind: 'identity', mode: 'correct' })} heldReason={held}>
                  {t('identity.correct')}
                </Button>
              )}
              <Button size="sm" onClick={() => actions?.onDialog?.({ kind: 'identity', mode: 'new' })} heldReason={held}>
                {t(current ? 'identity.newFromDate' : 'identity.addFirst')}
              </Button>
            </span>
          }
        />
        {!current ? <p className="fw-pty-hint">{t(`${model.side}.identity.none`)}</p> : <KeyValue columns={compact ? 2 : 3} labelCase="sentence" items={items} />}
        {others.length > 0 && (
          <>
            <p className="fw-pty-pop-title">{t('identity.others')}</p>
            <SummaryTable
              label={t('identity.others')}
              stackOnPhone
              columns={[t('field.validFrom'), t('field.taxMode'), t('field.vatNumber'), t('field.sdi')]}
              align={['left', 'left', 'left', 'left']}
              rows={others.map((identity) => ({
                id: identity.id,
                cells: [
                  formatDate(identity.validFrom, { locale }),
                  t(`taxMode.${identity.taxMode}`),
                  <span key="v" className="fw-pty-code">
                    {dash(identity.vatNumber ?? identity.fiscalCode)}
                  </span>,
                  dash(identity.sdiRecipientCode ?? identity.pec),
                ],
              }))}
            />
          </>
        )}
      </div>
    </Card>
  )
}

function ViesCard({ model, party, actions, viesHeld }: Omit<TabProps, 'editable'> & { viesHeld: string | null }) {
  const t = useT('parties')
  const locale = useLocale()
  const last = party.viesChecks[0] ?? null
  if (!viesApplies(party)) {
    return (
      <Card padded>
        <div className="fw-pty-card-body">
          <CardHead title={t('vies.title')} />
          <p className="fw-pty-hint">{t('vies.notApplicable')}</p>
        </div>
      </Card>
    )
  }
  const history = model.history.items ?? party.viesChecks
  return (
    <Card padded>
      <div className="fw-pty-card-body">
        <CardHead
          title={t('vies.title')}
          action={
            <Button size="sm" variant="primary" onClick={() => actions?.onCheckVies?.()} heldReason={viesHeld}>
              {t('step.action.vies')}
            </Button>
          }
        />
        <p className="fw-pty-hint">{t(`vies.meaning.${party.vies.state}`, { days: party.vies.maxAgeDays })}</p>
        {!last ? (
          <p className="fw-pty-hint">{t('vies.notYet')}</p>
        ) : (
          <>
            {last.result === 'ERROR' && <Banner tone="warning" title={t('vies.noAnswer')} />}
            <KeyValue
              columns={2}
              labelCase="sentence"
              items={[
                { label: t('vies.resultLabel'), value: <Tag tone={RESULT_TONE[last.result]}>{t(`vies.result.${last.result}`)}</Tag> },
                { label: t('vies.checkedAt'), value: formatDateTime(last.requestedAt, { locale }) },
                { label: t('vies.consultation'), value: <span className="fw-pty-code">{dash(last.consultationNumber)}</span> },
                { label: t('vies.number'), value: <span className="fw-pty-code">{`${last.countryCode}${last.vatNumber}`}</span> },
                { label: t('vies.traderName'), value: dash(last.traderName) },
                { label: t('vies.traderAddress'), value: dash(last.traderAddress) },
                ...(party.vies.validUntil ? [{ label: t('vies.validUntil'), value: formatDate(party.vies.validUntil, { locale }) }] : []),
              ]}
            />
          </>
        )}
        <p className="fw-pty-hint">{t('vies.recheck', { days: party.vies.maxAgeDays })}</p>
        {history.length > 0 && (
          <>
            <p className="fw-pty-pop-title">{t('vies.history')}</p>
            {model.history.problem ? (
              <p className="fw-pty-hint">{t(model.history.problem)}</p>
            ) : (
              <SummaryTable
                label={t('vies.history')}
                stackOnPhone
                columns={[t('vies.checkedAt'), t('vies.number'), t('vies.resultLabel'), t('vies.consultation')]}
                align={['left', 'left', 'left', 'left']}
                rows={history.map((check) => ({
                  id: check.id,
                  cells: [
                    formatDateTime(check.requestedAt, { locale }),
                    <span key="n" className="fw-pty-code">{`${check.countryCode}${check.vatNumber}`}</span>,
                    <Tag key="r" tone={RESULT_TONE[check.result]}>
                      {t(`vies.result.${check.result}`)}
                    </Tag>,
                    <span key="c" className="fw-pty-code">
                      {dash(check.consultationNumber)}
                    </span>,
                  ],
                }))}
              />
            )}
          </>
        )}
      </div>
    </Card>
  )
}

// ---- Quotes & orders, Orders ------------------------------------------------------------------------------------------

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
