'use client'

import { useEffect, type ReactNode } from 'react'
import { MapPin, MoreHorizontal, Plus, Users } from 'lucide-react'
import { Banner, Card, KeyValue, Menu, SummaryTable, type MenuItemDef } from '@nexus/ui/components'
import { Button, Checkbox, Tag, Toggle } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import type { Address, Contact, Party, TaxIdentity } from '../api'
import {
  addressDraftOf,
  blankIdentity,
  contactDraftOf,
  countryName,
  identitiesOf,
  identityDraftOf,
  languageName,
  mainContacts,
  nextSteps,
  partyDraftOf,
  partyName,
  RESULT_TONE,
  viesApplies,
  WARNING_ACTION,
  type PartyRecordModel,
  type RecordDialog,
} from '../model'
import { AddressModal, ArchiveModal, BlockModal, ContactModal, EditPartyModal, IdentityModal } from './dialogs'
import { dash, NoticeBanner, ReadState, StatusPill, ViesMark } from './parts'
import { useRecordFrame } from '../../../_shared/record-frame/RecordFrame'
import { RecordNotices } from '../../../_shared/record-frame/RecordNotices'
import type { PartyRecordActions } from './PartyRecordView'

/**
 * F-SA-270 (sales page plan N5, picks P10, R5; 11-customer-page §1): the parts BOTH party records draw — the customer view
 * (areas/sales/customers/record/view/CustomerRecordView.tsx) and the supplier's (./PartyRecordView.tsx) — moved here from
 * PartyRecordView.tsx as they were (same code, one component each, rule 24): the record's ONE notice area, the dialogs of the party,
 * the side panel (status, next steps, VIES, main contacts), the Addresses, Contacts, Tax identity and VIES cards, and the thread shown
 * once on arrival.
 */

/** B-TH-260: an old address that asked for the gone Documents tab shows the thread once (its files are the thread's Files view). */
export function ShowThreadOnArrival() {
  const frame = useRecordFrame()
  const show = frame?.showThread
  useEffect(() => {
    show?.()
    // Once, on arrival.
  }, [])
  return null
}

/** B-TH-260: ONE notice in the body column, the most serious first; the rest behind "N more notices". */
export function PartyNotices({ model, party, actions }: { model: PartyRecordModel; party: Party; actions?: PartyRecordActions | undefined }) {
  const t = useT('parties')
  const locale = useLocale()
  const side = model.side
  const can = model.can
  return (
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
  )
}

/** The party's dialogs (edit, block, archive, an address, a contact, a tax identity), one set for both sides. */
export function PartyDialogs({ model, party, actions }: { model: PartyRecordModel; party: Party; actions?: PartyRecordActions | undefined }) {
  const side = model.side
  const open = (dialog: RecordDialog | null) => actions?.onDialog?.(dialog)
  const dialog = model.dialog ?? null
  const activeAddresses = party.addresses.filter((address) => address.status === 'ACTIVE')
  const editingAddress = dialog?.kind === 'address' && dialog.addressId ? party.addresses.find((address) => address.id === dialog.addressId) : undefined
  const editingContact = dialog?.kind === 'contact' && dialog.contactId ? party.contacts.find((contact) => contact.id === dialog.contactId) : undefined
  const { current } = identitiesOf(party)
  return (
    <>
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

export type TabProps = { model: PartyRecordModel; party: Party; actions?: PartyRecordActions; editable: boolean }

export function CardHead({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="fw-pty-card-head">
      <h2 className="fw-pty-card-title">{title}</h2>
      {action}
    </div>
  )
}

/** What the record still lacks, most serious first, each with the step that fixes it (the side panel). */
export function NextSteps({ model, party, actions, editable, viesHeld }: TabProps & { viesHeld: string | null }) {
  const t = useT('parties')
  const steps = nextSteps(party.warnings)
  const side = model.side
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
    // F-CO-203 (customer Overview co-w2 W2.3): the customer's branch (Add address / contact as links to People & addresses) went —
    // the side panel is the supplier's only (its one mount: PartyRecordView, always `side: 'suppliers'`); the customer's Overview
    // says what is to complete in its own facts (areas/sales/customers/record/overview/rows.ts factsOf).
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

export function SidePanel({ model, party, actions, editable, viesHeld, children }: TabProps & { viesHeld: string | null; children?: ReactNode }) {
  const t = useT('parties')
  const locale = useLocale()
  const lastCheck = party.viesChecks[0] ?? null
  const role = 'ORDERS' as const
  const receivers = mainContacts(party, role)
  return (
    <div className="fw-pty-side">
      <Card padded>
        <div className="fw-pty-card-body">
          <CardHead title={t('side.status')} />
          <span className="fw-pty-tags">
            <StatusPill status={party.status} />
          </span>
          <p className="fw-pty-hint">
            {party.status === 'BLOCKED' && party.blocked
              ? t('side.blockedSince', { date: formatDate(party.blocked.at, { locale }) })
              : t('side.createdOn', { date: formatDate(party.createdAt, { locale }) })}
          </p>
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
          {/* F-CO-203: the supplier's side panel only (the customer's invoice contacts went with the customer's old Overview). */}
          {receivers.length === 0 ? (
            <p className="fw-pty-hint">{t(`${model.side}.side.noContacts`)}</p>
          ) : (
            <ul className="fw-pty-list">
              {receivers.map((contact) => ({ contact, role: 'ORDERS' as const })).map(
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

// ---- Addresses and contacts -------------------------------------------------------------------------------------------

export function AddressesCard({ model, party, actions, editable }: TabProps) {
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

/**
 * F-SA-274 (a customer's People & addresses): `portalEmails` — the e-mails of its people with portal access: a contact with the same
 * e-mail is tagged "Has portal access" (a hint from two reads: the data holds no link between the two); `inviteHref` — a contact's
 * ⋯ "Invite to the portal…" (the invitation with its e-mail filled in; null: none offered).
 */
export function ContactsCard({ model, party, actions, editable, portalEmails, inviteHref }: TabProps & { portalEmails?: ReadonlySet<string> | undefined; inviteHref?: ((contact: Contact) => string | null) | undefined }) {
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
    // F-SA-274: an active contact with an e-mail and no portal access yet.
    ...(inviteHref && contact.status === 'ACTIVE' && contact.email && !portalEmails?.has(contact.email.trim().toLowerCase()) && inviteHref(contact)
      ? [{ id: 'invite', label: t('contact.invite'), href: inviteHref(contact) ?? undefined }]
      : []),
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
                // F-SA-274: "Has portal access" on an exact e-mail match.
                contact.email && portalEmails?.has(contact.email.trim().toLowerCase()) ? (
                  <span key="e" className="fw-pty-tags">
                    <span>{contact.email}</span>
                    <Tag tone="info">{t('contact.hasPortal')}</Tag>
                  </span>
                ) : (
                  dash(contact.email)
                ),
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

export function IdentityCard({ model, party, current, actions, editable, compact = false, viesHeld }: TabProps & { current: TaxIdentity | null; compact?: boolean; viesHeld?: string | null }) {
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

export function ViesCard({ model, party, actions, viesHeld }: Omit<TabProps, 'editable'> & { viesHeld: string | null }) {
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
