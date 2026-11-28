'use client'

import { Ban, Check, Clock, Eye, FileText, Info, Layers, Phone, Plus, TriangleAlert, Truck } from 'lucide-react'
import type { MenuItemDef } from '@nexus/ui/components'
import { Button, Tag } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../../lib/i18n/format'
import { useLocale } from '../../../../../../lib/i18n/provider'
import { countryName } from '../../../../../parties/_shared/model'
import { copyLinkTo } from '../../../../orders/record/shipments/view/hrefs'
import { LineMenuButton } from '../../../../orders/record/view/LineMenu'
import { Section } from '../../../../../../lib/record-sections/Kit'
import { addressFilterOf, filterWords } from '../../people/answer'
import { addressMenu, addressUsageWords, type AddressRow } from '../../people/addresses'
import { ADDRESS_ROWS, addressAnchor, peopleKitId, said, type Say } from '../../people/model'
import type { PeopleTabActions, PeopleTabModel } from '../../people/tab'
import { menuItemOf, sentenceOf, usePeopleSay } from './say'
import { UsageFailed } from './UsageFailed' // F-CA-fx4 (Z25)

/**
 * F-CA-111 (customer page › PEOPLE & ADDRESSES tab, lane ca-; 10-design §5.2; 18-lead-settles Z17) — section 2, Addresses (#addresses):
 * one row per address — the lines and the delivery notes, what it is for and its defaults as words, which one the e-invoices use, who
 * is there, what it is used on (D3, words: no list takes an address filter). An address the customer added in the portal waits for our
 * check: Approve (one click) and Refuse… (the reason the customer reads) right on the row, for a reader who manages orders; a refused
 * one stays in view 30 days. Head: Add address (Add the registered office when none) · ⋯ (Show archived, History ›, Copy link) · ⓘ.
 * The foot says that a change never changes what was sent. Draws its model; reads nothing.
 */

export function AddressesSection({ model, actions }: { model: PeopleTabModel; actions?: PeopleTabActions | undefined }) {
  const say = usePeopleSay()
  const locale = useLocale()
  const addresses = model.addresses
  const title = say(said('parties:address.title'))
  const none = addresses.all.every((row) => row.address.status !== 'ACTIVE')
  const archivedHeld = model.can.manage && !model.editable ? say(said('parties:held.archived')) : null
  const buttons = model.can.manage
    ? [
        <Button key="add" size="sm" heldReason={archivedHeld} onClick={() => actions?.onAddAddress?.()}>
          <Plus size={14} aria-hidden /> {say(said(none ? 'parties:address.addRegistered' : 'parties:address.add'))}
        </Button>,
      ]
    : []
  const more: MenuItemDef[] = [
    ...(addresses.archivedHidden > 0 || addresses.showArchived ? [{ id: 'archived', label: say(said(addresses.showArchived ? 'addresses.hideArchived' : 'addresses.showArchived', { params: { count: addresses.archivedHidden } })), onSelect: () => actions?.onShowArchivedAddresses?.(!addresses.showArchived) }] : []),
    ...(model.can.audit ? [{ id: 'history', label: say(said('addresses.history')), href: `${model.prefix}/admin/audit?${new URLSearchParams({ type: 'Party', record: model.partyId }).toString()}` }] : []),
    { id: 'link', label: say(said('linkTo', { params: { section: title } })), onSelect: () => copyLinkTo('addresses') },
  ]
  const info = (
    <>
      <p>{say(said('addresses.info'))}</p>
      <p>{say(said('addresses.infoCheck'))}</p>
      <p>{say(said('keys'))}</p>
    </>
  )
  const head = { id: peopleKitId('addresses'), title, buttons, info, more: <LineMenuButton label={say(said('addresses.more'))} items={more} />, answer: sentenceOf(addresses.answer.map(say), locale) }
  const filter = addressFilterOf(model.filter)
  if (addresses.all.length === 0) return <Section {...head}>{null}</Section>
  return (
    <Section {...head}>
      {filter ? (
        <p className="fw-ca-filt" role="status">
          <Eye size={13} aria-hidden />
          <span>{say(filterWords(model.filter!, addresses.listed))}</span>
          <button type="button" className="fw-pt-link" onClick={() => actions?.onChip?.(null)}>
            {say(said('filter.showAllAddresses', { params: { count: addresses.unfiltered } }))}
          </button>
        </p>
      ) : null}
      {addresses.rows.length > 0 ? (
        <div className="fw-ca-ls" role="list" aria-label={say(said('addresses.listLabel', { params: { name: model.name } }))}>
          <div className="fw-ca-hd is-a" aria-hidden="true">
            <div className="fw-ca-addr">{say(said('parties:address.col.address'))}</div>
            <div className="fw-ca-for">{say(said('parties:address.col.kinds'))}</div>
            <div className="fw-ca-at">{say(said('parties:address.col.contact'))}</div>
            <div className="fw-ca-used">{say(said('addresses.col.used'))}</div>
            <div className="fw-ca-o" />
          </div>
          {addresses.rows.map((row) => (
            <AddressRowView key={row.id} row={row} model={model} actions={actions} say={say} />
          ))}
        </div>
      ) : null}
      {addresses.usageProblem && addresses.rows.length > 0 ? <UsageFailed problem={addresses.usageProblem} onRetry={actions?.onRetryUsage} /> : null}
      {!filter && addresses.listed > addresses.rows.length ? (
        <Button size="sm" variant="quiet" className="fw-ca-more" onClick={() => actions?.onMore?.('addresses', true)}>
          {say(said('addresses.showMore', { params: { count: addresses.listed - addresses.rows.length } }))}
        </Button>
      ) : null}
      {!filter && addresses.more && addresses.listed > ADDRESS_ROWS ? (
        <Button size="sm" variant="quiet" className="fw-ca-more" onClick={() => actions?.onMore?.('addresses', false)}>
          {say(said('showFewer'))}
        </Button>
      ) : null}
      <p className="fw-ca-foot">
        <Info size={13} aria-hidden />
        <span>{say(said('parties:address.sentKeepCopy'))}</span>
      </p>
    </Section>
  )
}

function AddressRowView({ row, model, actions, say }: { row: AddressRow; model: PeopleTabModel; actions?: PeopleTabActions | undefined; say: Say }) {
  const locale = useLocale()
  const address = row.address
  const label = address.name ?? address.line1
  const day = (at: string | null | undefined) => (at ? formatDate(at, { locale }) : '')
  const items = addressMenu(row, model.addresses.menu).map((item) => menuItemOf(item, say, () => (item.act ? actions?.onAddressAct?.(item.act, row) : undefined)))
  const used = addressUsageWords(row.usage).map(say)
  const approval = address.approval ?? null
  const added = approval ? (approval.requestedBy ? say(said('check.added', { params: { name: approval.requestedBy, date: day(approval.requestedAt) } })) : say(said('check.addedNoName', { params: { date: day(approval.requestedAt) } }))) : ''
  const approving = model.addresses.approving === row.id
  const mayDecide = row.waiting && model.can.ordersManage
  // The customer is archived: a decision waits until it is reactivated (held by state, never by a right).
  const archivedHeld = model.addresses.menu.archivedCustomer ? say(said('parties:held.archived')) : null
  return (
    <div className={`fw-ca-row is-a${address.status === 'ARCHIVED' ? ' is-off' : ''}`} id={addressAnchor(row.id)} role="listitem">
      <div className="fw-ca-addr">
        <span className="fw-ca-name">
          <b>{label}</b>
        </span>
        <span className="fw-ca-lines">
          {address.name ? address.line1 : null}
          {address.name && address.line2 ? <br /> : null}
          {address.line2 ?? null}
          {address.name || address.line2 ? <br /> : null}
          {[address.postalCode, address.city, address.province].filter(Boolean).join(' ')} · {countryName(address.country, locale)}
        </span>
        {address.deliveryNotes ? (
          <span className="fw-ca-sub">
            <Truck size={12} aria-hidden />
            {address.deliveryNotes}
          </span>
        ) : null}
      </div>
      <div className="fw-ca-for">
        <span className="fw-ca-tags">
          {row.archived ? <Tag tone="neutral">{say(said('parties:master.ARCHIVED'))}</Tag> : null}
          {address.kinds.map((kind) => (
            <Tag key={kind} tone="neutral">
              {say(said(`parties:addressKind.${kind}`))}
            </Tag>
          ))}
          {address.isDefaultBillTo && address.status === 'ACTIVE' ? (
            <Tag tone="info">
              <Check size={12} aria-hidden /> {say(said('addresses.defaultBillTo'))}
            </Tag>
          ) : null}
          {address.isDefaultShipTo && address.status === 'ACTIVE' ? (
            <Tag tone="info">
              <Check size={12} aria-hidden /> {say(said('addresses.defaultShipTo'))}
            </Tag>
          ) : null}
        </span>
        {row.einvoice ? (
          <span className="fw-ca-tags">
            <Tag tone="success">
              <FileText size={12} aria-hidden /> {say(said('addresses.einvoice'))}
            </Tag>
          </span>
        ) : null}
        {row.otherRegistered ? (
          <span className="fw-ca-sub is-warning">
            <TriangleAlert size={12} aria-hidden />
            {say(said('addresses.otherRegistered', { params: { city: row.otherRegistered } }))}
          </span>
        ) : null}
      </div>
      <div className="fw-ca-at">
        {address.contactName ? <span>{address.contactName}</span> : <span className="fw-ca-none">{say(said('addresses.nobodyAt'))}</span>}
        {address.phone ? (
          <a className="fw-ca-ln" href={`tel:${address.phone.replace(/\s/g, '')}`}>
            <Phone size={13} aria-hidden />
            <span>{address.phone}</span>
          </a>
        ) : null}
      </div>
      <div className="fw-ca-used">
        {used.length > 0 ? (
          <span>
            <Layers size={13} aria-hidden /> {say(said('used.on', { params: { what: used.join(' · ') } }))}
          </span>
        ) : model.addresses.usageIn ? (
          <span className="fw-ca-none">{say(said('used.notOnWork'))}</span>
        ) : null}
      </div>
      <div className="fw-ca-o">
        <LineMenuButton label={say(said('parties:address.menu', { params: { name: label } }))} items={items} />
      </div>
      {row.waiting ? (
        <div className="fw-ca-chk">
          <div className="fw-ca-chkb" role="group" aria-label={say(said('check.label', { params: { name: label } }))}>
            <span className="fw-ca-chkb-t">
              <b>
                <Clock size={13} aria-hidden /> {say(said('check.waits'))}
                {added ? ` · ${added}` : ''}
              </b>
              <span>
                {say(said('check.notUsed'))}
                {model.can.ordersManage ? '' : ` ${say(said('check.colleague'))}`}
              </span>
            </span>
            {mayDecide ? (
              <span className="fw-ca-chkb-a">
                <Button size="sm" variant="primary" heldReason={archivedHeld} disabled={approving} onClick={() => actions?.onAddressAct?.('approve', row)}>
                  <Check size={14} aria-hidden /> {say(said(approving ? 'check.approving' : 'check.approve'))}
                </Button>
                <Button size="sm" heldReason={archivedHeld} disabled={approving} onClick={() => actions?.onAddressAct?.('refuse', row)}>
                  {say(said('check.refuse'))}
                </Button>
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
      {row.refused ? (
        <div className="fw-ca-chk">
          <div className="fw-ca-chkb is-refused">
            <span className="fw-ca-chkb-t">
              <b>
                <Ban size={13} aria-hidden /> {approval?.decidedBy ? say(said('check.refusedOn', { params: { date: day(approval.decidedAt), name: approval.decidedBy } })) : say(said('check.refusedOnNoName', { params: { date: day(approval?.decidedAt) } }))}
                {added ? ` · ${added}` : ''}
              </b>
              <span>{say(said('check.reason', { params: { reason: approval?.refuseReason ?? '' } }))}</span>
            </span>
          </div>
        </div>
      ) : null}
    </div>
  )
}
