'use client'

import { Eye, Mail, Phone, Plus, TriangleAlert, UserPlus } from 'lucide-react'
import type { MenuItemDef } from '@nexus/ui/components'
import { Button, Checkbox, Pill, Tag } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../../lib/i18n/format'
import { useLocale } from '../../../../../../lib/i18n/provider'
import { languageName } from '../../../../../parties/_shared/model'
import { partnerCan, personReach, STATUS_TONE, type RowAction } from '../../../../../admin/users/partners/model'
import { copyLinkTo } from '../../../../orders/record/shipments/view/hrefs'
import { LineMenuButton } from '../../../../orders/record/view/LineMenu'
import { PartFailed, PartReading, Section } from '../../../../orders/record/view/production/Kit'
import { filterWords, personFilterOf } from '../../people/answer'
import { PEOPLE_ROWS, peopleKitId, personAnchor, said, type Say } from '../../people/model'
import { personMenu, portalStateOf, tickable, type PersonRow } from '../../people/people'
import type { PeopleTabActions, PeopleTabModel } from '../../people/tab'
import { menuItemOf, sentenceOf, usePeopleSay } from './say'
import { UsageFailed } from './UsageFailed' // F-CA-fx4 (Z25)

/**
 * F-CA-110 (customer page › PEOPLE & ADDRESSES tab, lane ca-; 10-design §5.1; 18-lead-settles Z1, Z6, Z7, Z17) — section 1, People
 * (#people): ONE row per person — who they are and what they deal with, how to reach them (e-mail and phone are links), what they get by
 * e-mail (the mail rule) and what they are used on (D3), their portal access (partners.view), their personal data's state. Columns join
 * one at a time by the LIST's room (people.css), never the screen. Head: Add contact · Invite (held only by state) · ⋯ (Show archived,
 * Show people who left, Tick portal people to act on many…, Portal settings ›, History ›, Copy link) · ⓘ. Each row's ⋯ holds the acts
 * the reader has the right for; ticks and the bulk bar keep the portal's four acts on many. Draws its model; reads nothing.
 */

const BULK: readonly RowAction[] = ['resend', 'suspend', 'reactivate', 'deactivate']

export function PeopleSection({ model, actions, recordHref }: { model: PeopleTabModel; actions?: PeopleTabActions | undefined; recordHref: string }) {
  const say = usePeopleSay()
  const locale = useLocale()
  const people = model.people
  const title = say(said('people.title'))
  const archivedHeld = model.can.manage && !model.editable ? say(said('parties:held.archived')) : null
  const buttons = [
    ...(model.can.manage
      ? [
          <Button key="add" size="sm" heldReason={archivedHeld} onClick={() => actions?.onAddContact?.()}>
            <Plus size={14} aria-hidden /> {say(said('parties:contact.add'))}
          </Button>,
        ]
      : []),
    ...(people.invite.shown
      ? [
          <Button key="invite" size="sm" heldReason={people.invite.held ? say(people.invite.held) : null} onClick={() => actions?.onInvite?.()}>
            <UserPlus size={14} aria-hidden /> {say(said('portal-access:people.invite'))}
          </Button>,
        ]
      : []),
  ]
  const more: MenuItemDef[] = [
    ...(people.hidden.archived > 0 || people.showArchived ? [{ id: 'archived', label: say(said(people.showArchived ? 'people.hideArchived' : 'people.showArchived', { params: { count: people.hidden.archived } })), onSelect: () => actions?.onShowArchivedContacts?.(!people.showArchived) }] : []),
    ...(people.portalColumn && (people.hidden.left > 0 || people.showLeft) ? [{ id: 'left', label: say(said(people.showLeft ? 'people.hideLeft' : 'portal-access:people.showLeft')), onSelect: () => actions?.onShowLeft?.(!people.showLeft) }] : []),
    ...(people.mayTick && !people.ticking ? [{ id: 'tick', label: say(said('people.tick')), onSelect: () => actions?.onTicking?.(true) }] : []),
    ...(model.can.portal ? [{ id: 'portal', label: say(said('people.portalSettings')), href: `${recordHref}?tab=portal` }] : []),
    ...(model.can.audit ? [{ id: 'history', label: say(said('people.history')), href: `${model.prefix}/admin/audit?${new URLSearchParams({ type: 'Party', record: model.partyId }).toString()}` }] : []),
    { id: 'link', label: say(said('linkTo', { params: { section: title } })), onSelect: () => copyLinkTo('people') },
  ]
  const info = (
    <>
      <p>{say(said('people.info'))}</p>
      <p>{say(said('people.infoQuote'))}</p>
      <p>{say(said('keys'))}</p>
    </>
  )
  const head = { id: peopleKitId('people'), title, buttons, info, more: <LineMenuButton label={say(said('people.more'))} items={more} />, answer: sentenceOf(people.answer.map(say), locale) }
  const filter = personFilterOf(model.filter)
  const list = people.rows
  return (
    <Section {...head}>
      {people.portalProblem ? <PartFailed part={say(said('part.portal'))} problem={people.portalProblem} onRetry={actions?.onRetryPortal} /> : null}
      {people.ticking ? <BulkBar model={model} actions={actions} say={say} /> : null}
      {filter ? (
        <p className="fw-ca-filt" role="status">
          <Eye size={13} aria-hidden />
          <span>{say(filterWords(model.filter!, people.listed))}</span>
          <button type="button" className="fw-pt-link" onClick={() => actions?.onChip?.(null)}>
            {say(said('filter.showAllPeople', { params: { count: people.unfiltered } }))}
          </button>
        </p>
      ) : null}
      {list.length > 0 ? (
        <div className={`fw-ca-ls${people.portalColumn ? '' : ' no-portal'}`} role="list" aria-label={say(said('people.listLabel', { params: { name: model.name } }))}>
          <div className={`fw-ca-hd is-p${people.ticking ? ' has-ck' : ''}`} aria-hidden="true">
            {people.ticking ? <div className="fw-ca-ckc" /> : null}
            <div className="fw-ca-who">{say(said('people.col.person'))}</div>
            <div className="fw-ca-reach">{say(said('people.col.reach'))}</div>
            <div className="fw-ca-gets">{say(said('people.col.gets'))}</div>
            {people.portalColumn ? <div className="fw-ca-portal">{say(said('people.col.portal'))}</div> : null}
            <div className="fw-ca-pd">{say(said('people.col.privacy'))}</div>
            <div className="fw-ca-o" />
          </div>
          {list.map((row) => (
            <PersonRowView key={row.id} row={row} model={model} actions={actions} say={say} />
          ))}
        </div>
      ) : null}
      {people.portalReading ? <PartReading rows={1} height={18} /> : null}
      {people.usageProblem && list.length > 0 ? <UsageFailed problem={people.usageProblem} onRetry={actions?.onRetryUsage} /> : null}
      {!filter && people.listed > list.length ? (
        <Button size="sm" variant="quiet" className="fw-ca-more" onClick={() => actions?.onMore?.('people', true)}>
          {say(said('people.showMore', { params: { count: people.listed - list.length } }))}
        </Button>
      ) : null}
      {!filter && people.more && people.listed > PEOPLE_ROWS ? (
        <Button size="sm" variant="quiet" className="fw-ca-more" onClick={() => actions?.onMore?.('people', false)}>
          {say(said('showFewer'))}
        </Button>
      ) : null}
    </Section>
  )
}

/** One person: who · how to reach them · what they get · the portal · personal data · ⋯. */
function PersonRowView({ row, model, actions, say }: { row: PersonRow; model: PeopleTabModel; actions?: PeopleTabActions | undefined; say: Say }) {
  const locale = useLocale()
  const people = model.people
  const contact = row.contact
  const person = portalStateOf(row, people.showLeft)
  const name = row.erased ? say(said('sales-customers-depth:privacy.erasedName')) : (contact?.name ?? row.portal?.displayName ?? '')
  const off = row.archived || row.erased || (contact === null && row.left)
  const items = personMenu(row, people.menu).map((item) => menuItemOf(item, say, () => (item.act ? actions?.onPersonAct?.(item.act, row) : undefined)))
  const email = contact ? contact.email : (row.portal?.email ?? null)
  const phone = contact?.phone ?? null
  const day = (at: string) => formatDate(at, { locale })
  return (
    <div className={`fw-ca-row is-p${people.ticking ? ' has-ck' : ''}${off ? ' is-off' : ''}`} id={personAnchor(row.id)} role="listitem">
      {people.ticking ? (
        <div className="fw-ca-ckc">
          {tickable(row) && row.portal ? <Checkbox aria-label={say(said('bulk.tick', { params: { name } }))} checked={people.ticked.includes(row.portal.id)} onChange={(event) => actions?.onTick?.(row.portal!.id, event.target.checked)} /> : null}
        </div>
      ) : null}
      <div className="fw-ca-who">
        <span className="fw-ca-name">
          <b className={row.erased ? 'is-erased' : undefined}>{name}</b>
          {row.erased ? <Tag tone="neutral">{say(said('sales-customers-depth:privacy.erased'))}</Tag> : null}
          {row.archived ? <Tag tone="neutral">{say(said('parties:master.ARCHIVED'))}</Tag> : null}
          {contact === null ? <Tag tone="info">{say(said('people.portalOnly'))}</Tag> : null}
          {contact && !row.erased ? contact.roles.map((role) => <Tag key={role}>{say(said(`parties:contactRole.${role}`))}</Tag>) : null}
        </span>
        {row.sameName ? (
          <span className="fw-ca-sub is-warning">
            <TriangleAlert size={12} aria-hidden />
            {say(said('people.sameName', { params: { name: row.sameName } }))}
          </span>
        ) : null}
      </div>
      <div className="fw-ca-reach">
        {row.erased ? (
          <span className="fw-ca-none">{say(said('people.blanked'))}</span>
        ) : (
          <>
            {email ? (
              <a className="fw-ca-ln" href={`mailto:${email}`}>
                <Mail size={13} aria-hidden />
                <span>{email}</span>
              </a>
            ) : (
              <span className="fw-ca-none">{say(said('people.noEmail'))}</span>
            )}
            <span className="fw-ca-ph">
              {phone ? (
                <a className="fw-ca-ln" href={`tel:${phone.replace(/\s/g, '')}`}>
                  <Phone size={13} aria-hidden />
                  <span>{phone}</span>
                </a>
              ) : null}
              {contact ? <span className="fw-ca-sub">{say(said('people.writesIn', { params: { language: languageName(contact.language ?? model.language, locale) } }))}</span> : null}
            </span>
          </>
        )}
      </div>
      <div className="fw-ca-gets">
        <Gets row={row} say={say} />
        <UsageLine row={row} say={say} day={day} />
      </div>
      {people.portalColumn ? (
        <div className="fw-ca-portal">
          {person ? (
            <>
              <span className="fw-ca-tags">
                <Pill tone={STATUS_TONE[person.status]}>{say(said(`portal-access:status.${person.status}`))}</Pill>
                <Tag tone="neutral">{say(said(person.roleKey ? `portal-access:role.${person.roleKey}` : 'portal-access:people.noRole'))}</Tag>
                {row.approver ? <Tag tone="info">{say(said('portal.approver'))}</Tag> : null}
                {row.expired ? <Tag tone="warning">{say(said('portal.expired'))}</Tag> : null}
                {row.endsIn !== null && person.accessUntil ? <Tag tone="warning">{say(said('portal.endsIn', { days: { date: person.accessUntil }, params: { count: row.endsIn } }))}</Tag> : null}
              </span>
              <span className="fw-ca-sub">
                {[
                  person.status === 'INVITED' && person.invitation ? say(said('portal-access:people.invitationEnds', { days: { date: person.invitation.expiresAt } })) : '',
                  person.status !== 'INVITED' ? (person.lastSignInAt ? say(said('portal.lastSignIn', { days: { date: person.lastSignInAt } })) : say(said('portal.never'))) : '',
                  say(said(person.seesPrices ? 'portal.prices' : 'portal.noPrices')),
                ]
                  .filter((part) => part !== '')
                  .join(' · ')}
              </span>
            </>
          ) : (
            <span className="fw-ca-none">{row.erased ? '—' : say(said('portal.none'))}</span>
          )}
        </div>
      ) : null}
      <div className="fw-ca-pd">
        <Privacy row={row} say={say} day={day} />
      </div>
      <div className="fw-ca-o">
        <LineMenuButton label={say(said('row.menu', { params: { name } }))} items={items} />
      </div>
    </div>
  )
}

/** What the person gets by e-mail (the mail rule), or why nothing. */
function Gets({ row, say }: { row: PersonRow; say: Say }) {
  if (row.erased) return <span className="fw-ca-none">—</span>
  if (!row.contact) return <span className="fw-ca-sub">{say(said('gets.portalOnly'))}</span>
  if (row.archived) return <span className="fw-ca-none">{say(said('gets.archived'))}</span>
  if (row.noMail)
    return (
      <span className="fw-ca-sub is-warning">
        <TriangleAlert size={12} aria-hidden />
        {say(said('gets.noEmail'))}
      </span>
    )
  if (row.mails.length === 0) return <span className="fw-ca-none">{say(said('gets.none'))}</span>
  return (
    <span className="fw-ca-tags">
      {row.mails.map((mail) => (
        <Tag key={mail} tone="neutral">
          {say(said(`gets.${mail}`))}
        </Tag>
      ))}
    </span>
  )
}

/** "2 open quotes · 1 open complaint · last mail in 21/11/2026" — only the parts above 0 (D3); left out while read or failed. */
function UsageLine({ row, say, day }: { row: PersonRow; say: Say; day: (at: string) => string }) {
  const usage = row.usage
  if (!usage || row.erased) return null
  const parts = [
    usage.openQuotes > 0 ? say(said('used.quotes', { params: { count: usage.openQuotes } })) : '',
    usage.openComplaints > 0 ? say(said('used.complaints', { params: { count: usage.openComplaints } })) : '',
    usage.openReturns > 0 ? say(said('used.returns', { params: { count: usage.openReturns } })) : '',
    usage.openServiceCases > 0 ? say(said('used.service', { params: { count: usage.openServiceCases } })) : '',
    usage.lastMailInAt ? say(said('used.mailIn', { params: { date: day(usage.lastMailInAt) } })) : '',
  ].filter((part) => part !== '')
  if (parts.length === 0) return null
  const text = parts.join(' · ')
  return <span className="fw-ca-sub">{text.charAt(0).toUpperCase() + text.slice(1)}</span>
}

/** The person's personal data: only what needs a look (the usual basis only where its column exists, ≥ 1240 px of the list). */
function Privacy({ row, say, day }: { row: PersonRow; say: Say; day: (at: string) => string }) {
  if (!row.contact) return <span className="fw-ca-none fw-ca-pd-ok">{say(said('privacy.onlyPortal'))}</span>
  const privacy = row.privacy
  if (!privacy) return null
  if (row.erased)
    return (
      <>
        <span className="fw-ca-tags">
          <Tag tone="neutral">{say(said('sales-customers-depth:privacy.erased'))}</Tag>
        </span>
        {privacy.erasedAt ? <span className="fw-ca-sub">{say(said('sales-customers-depth:privacy.erasedOn', { params: { date: day(privacy.erasedAt), by: privacy.erasedBy ?? say(said('sales-customers-depth:hold.system')) } }))}</span> : null}
      </>
    )
  const flags = [
    row.basisMissing ? (
      <Tag key="basis" tone="warning">
        {say(said('privacy.basisMissing')) /* F-CA-226: the tab's own word (10-design §10); the depth's says "Not recorded" */}
      </Tag>
    ) : null,
    privacy.objectedAt ? (
      <Tag key="objected" tone="warning">
        {say(said('sales-customers-depth:privacy.objectedOn', { params: { date: day(privacy.objectedAt) } }))}
      </Tag>
    ) : null,
  ].filter((flag) => flag !== null)
  return (
    <>
      {flags.length > 0 ? <span className="fw-ca-tags">{flags}</span> : null}
      {privacy.lawfulBasis ? (
        <span className={`fw-ca-sub${privacy.objectedAt ? '' : ' fw-ca-pd-ok'}`}>
          {[say(said(`sales-customers-depth:basis.${privacy.lawfulBasis}`)), privacy.consentAt ? day(privacy.consentAt) : ''].filter((part) => part !== '').join(' · ')}
        </span>
      ) : null}
    </>
  )
}

/** The bulk bar of the ticked portal people: the portal's own four acts (each its window with its fresh code), and Done. */
function BulkBar({ model, actions, say }: { model: PeopleTabModel; actions?: PeopleTabActions | undefined; say: Say }) {
  const people = model.people
  const ticked = (people.access?.people ?? []).filter((person) => people.ticked.includes(person.id))
  const can = partnerCan([...(model.can.portal ? ['partners.view'] : []), ...(model.can.invite ? ['partners.invite'] : []), ...(model.can.portalManage ? ['partners.manage'] : [])])
  return (
    <div className="fw-ca-bulk" role="toolbar" aria-label={say(said('bulk.label'))}>
      <b>{ticked.length > 0 ? say(said('bulk.ticked', { params: { count: ticked.length } })) : say(said('bulk.none'))}</b>
      {BULK.map((action) => {
        const reach = personReach(action, ticked, can)
        if (reach.held !== null || reach.items.length === 0) return null
        return (
          <Button key={action} size="sm" variant={action === 'suspend' || action === 'deactivate' ? 'danger-outline' : 'secondary'} onClick={() => actions?.onBulk?.(action)}>
            {say(said(`portal-access:bulk.${action}`, { params: { count: reach.items.length } }))}
          </Button>
        )
      })}
      <span className="fw-ca-sp" />
      <Button size="sm" variant="quiet" onClick={() => actions?.onTicking?.(false)}>
        {say(said('bulk.done'))}
      </Button>
    </div>
  )
}
