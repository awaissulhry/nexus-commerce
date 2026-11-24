'use client'

import Link from 'next/link'
import { CalendarClock, Link2, Lock, Ruler, Users } from 'lucide-react'
import type { MenuItemDef } from '@nexus/ui/components'
import { Button, Tag } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../../lib/i18n/format'
import { useLocale } from '../../../../../../lib/i18n/provider'
import { recordHref, REVIEW_TONE } from '../../../../mtm/model'
import type { ProfileRow } from '../../../../mtm/api'
import { copyLinkTo } from '../../../../orders/record/shipments/view/hrefs'
import { LineMenuButton } from '../../../../orders/record/view/LineMenu'
import { PartFailed, PartReading, Section } from '../../../../orders/record/view/production/Kit'
import { peopleKitId, RIDER_ROWS, said, type Say } from '../../people/model'
import { riderAnchor, riderMenu, type RiderRow } from '../../people/riders'
import type { PeopleTabActions, PeopleTabModel } from '../../people/tab'
import { menuItemOf, sentenceOf, usePeopleSay } from './say'

/**
 * F-CA-207 (customer page › PEOPLE & ADDRESSES tab, lane ca- ca-w2 W2.2; 10-design §5.3; R-B10, R-B23) — section 3, Riders &
 * measurements (#riders): BOTH kinds of rider — kept here (each with its newest profile per garment: revision, closest size, measured on,
 * the factory's review, re-measure, by link, open orders, next fitting) and with their own page (a door to it, its profiles counted
 * there). A rider's own page: its team on top and its profiles as one row. Without the measurements right: the riders' names only, said
 * once in the answer. Head: New measurements · Send a measurement link… (Made-to-measure's own windows, in place) · ⋯ (Add rider… /
 * Change team…, Made-to-measure ›, Copy link) · ⓘ. Review, New revision and Book a fitting are doors to the profile (`?do=`). The
 * measurements themselves stay on each profile: never in a row or a tip. Draws its model; reads nothing.
 */

export function RidersSection({ model, actions }: { model: PeopleTabModel; actions?: PeopleTabActions | undefined }) {
  const say = usePeopleSay()
  const locale = useLocale()
  const riders = model.riders
  const head = riders.head
  const title = say(said('riders.title'))
  const buttons = [
    ...(head.newShown
      ? [
          <Button key="new" size="sm" heldReason={head.newHeld ? say(head.newHeld) : null} onClick={() => actions?.onNewMeasurements?.()}>
            <Ruler size={14} aria-hidden /> {say(said('sales-mtm:list.new'))}
          </Button>,
        ]
      : []),
    ...(head.linkShown
      ? [
          <Button key="link" size="sm" heldReason={head.linkHeld ? say(head.linkHeld) : null} onClick={() => actions?.onSendLink?.()}>
            <Link2 size={14} aria-hidden /> {say(said('sales-mtm:list.sendLink'))}
          </Button>,
        ]
      : []),
  ]
  const more: MenuItemDef[] = [
    ...(head.addRider ? [{ id: 'addRider', label: say(said('riders.addRider')), onSelect: () => actions?.onAddRider?.(), ...(head.held ? { disabled: true, description: say(head.held) } : {}) }] : []),
    ...(head.changeTeam ? [{ id: 'team', label: say(said('riders.row.team')), onSelect: () => actions?.onChangeTeam?.(null), ...(head.held ? { disabled: true, description: say(head.held) } : {}) }] : []),
    ...(riders.measurements ? [{ id: 'mtm', label: say(said('riders.mtm')), href: `${model.prefix}/sales/made-to-measure?party=${encodeURIComponent(model.partyId)}` }] : []),
    { id: 'link', label: say(said('linkTo', { params: { section: title } })), onSelect: () => copyLinkTo('riders') },
  ]
  const info = (
    <>
      <p>{say(said('riders.info'))}</p>
      <p>{say(said('riders.foot'))}</p>
      <p>{say(said('keys'))}</p>
    </>
  )
  const section = { id: peopleKitId('riders'), title, buttons, info, more: <LineMenuButton label={say(said('riders.more'))} items={more} /> }
  if (riders.reading)
    return (
      <Section {...section} answer={say(said('riders.reading'))}>
        <PartReading rows={3} height={40} />
      </Section>
    )
  const shownProfiles = riders.all.reduce((count, row) => count + row.profiles.length, 0)
  return (
    <Section {...section} answer={sentenceOf(riders.answer.map(say), locale)}>
      {riders.team ? (
        <div className="fw-ca-team">
          <Users size={15} aria-hidden />
          <Link className="fw-ca-lk" href={`${model.prefix}/sales/customers/${encodeURIComponent(riders.team.id)}?tab=people#riders`}>
            {say(said('riders.team', { params: { name: riders.team.name } }))}
          </Link>
          <span className="fw-ca-sub">{say(said('riders.teamLine', { params: { name: model.name, team: riders.team.name } }))}</span>
        </div>
      ) : null}
      {riders.profilesProblem ? <PartFailed part={say(said('part.profiles'))} problem={riders.profilesProblem} onRetry={actions?.onRetryProfiles} /> : null}
      {riders.ridersProblem ? <PartFailed part={say(said('part.riders'))} problem={riders.ridersProblem} onRetry={actions?.onRetryRiders} /> : null}
      {riders.rows.length > 0 ? (
        <div className={`fw-ca-ls${riders.measurements ? '' : ' no-meas'}`} role="list" aria-label={say(said('riders.listLabel', { params: { name: model.name } }))}>
          {riders.rows.map((row) => (
            <RiderRowView key={row.id} row={row} model={model} actions={actions} say={say} />
          ))}
        </div>
      ) : null}
      {riders.all.length > riders.rows.length ? (
        <Button size="sm" variant="quiet" className="fw-ca-more" onClick={() => actions?.onMore?.('riders', true)}>
          {say(said('riders.showMore', { params: { count: riders.all.length - riders.rows.length } }))}
        </Button>
      ) : null}
      {riders.more && riders.all.length > RIDER_ROWS ? (
        <Button size="sm" variant="quiet" className="fw-ca-more" onClick={() => actions?.onMore?.('riders', false)}>
          {say(said('showFewer'))}
        </Button>
      ) : null}
      {riders.measurements && (riders.kind === 'ORGANISATION' || shownProfiles > 0) ? (
        <p className="fw-ca-foot">
          <Lock size={13} aria-hidden />
          <span>
            {say(said('riders.foot'))}{' '}
            <Link className="fw-ca-lk" href={`${model.prefix}/sales/made-to-measure?party=${encodeURIComponent(model.partyId)}`}>
              {riders.matching !== null && riders.matching > shownProfiles ? say(said('riders.seeAllCount', { params: { count: riders.matching } })) : say(said('riders.seeAll'))}
            </Link>
          </span>
        </p>
      ) : null}
    </Section>
  )
}

function RiderRowView({ row, model, actions, say }: { row: RiderRow; model: PeopleTabModel; actions?: PeopleTabActions | undefined; say: Say }) {
  const riders = model.riders
  const items = riderMenu(row, riders.menu).map((item) => menuItemOf(item, say, () => (item.act ? actions?.onRiderAct?.(item.act, row, item.profile?.id) : undefined)))
  const own = row.kind === 'own' && row.party
  return (
    <div className="fw-ca-row is-r" id={riderAnchor(row.id)} role="listitem">
      <div className="fw-ca-rider">
        <span className="fw-ca-name">
          <b>{row.name}</b>
          {own ? (
            <Link className="fw-ca-lk" href={`${model.prefix}/sales/customers/${encodeURIComponent(row.party!.id)}?tab=people#riders`}>
              {say(said('riders.ownPage'))}
            </Link>
          ) : null}
        </span>
        <span className="fw-ca-sub">
          {own
            ? say(said('riders.kind.own', { params: { code: row.party!.code, status: say(said(`parties:status.${row.party!.status}`)) } }))
            : row.kind === 'self'
              ? say(said('riders.kind.self'))
              : say(said(row.contact ? 'riders.kind.contact' : 'riders.kind.name', { params: { customer: model.name } }))}
        </span>
      </div>
      {riders.measurements ? (
        <div className="fw-ca-prs">
          {own ? (
            row.party!.measurementProfiles !== null ? (
              <div className="fw-ca-pr is-own">
                <div>
                  <Link className="fw-ca-lk" href={`${model.prefix}/sales/customers/${encodeURIComponent(row.party!.id)}?tab=people#riders`}>
                    {say(said('riders.ownProfiles', { params: { count: row.party!.measurementProfiles } }))}
                  </Link>
                </div>
              </div>
            ) : null
          ) : row.profiles.length > 0 ? (
            row.profiles.map((profile) => <ProfileLine key={profile.id} profile={profile} model={model} say={say} />)
          ) : (
            <div className="fw-ca-pr">
              <div className="fw-ca-none">{say(said('riders.noMeasurements'))}</div>
            </div>
          )}
        </div>
      ) : null}
      <div className="fw-ca-o">
        <LineMenuButton label={say(said('riders.row.menu', { params: { name: row.name } }))} items={items} />
      </div>
    </div>
  )
}

/** One profile kept here: its record, its size and day, its state — never a measurement. */
function ProfileLine({ profile, model, say }: { profile: ProfileRow; model: PeopleTabModel; say: Say }) {
  const locale = useLocale()
  const day = (at: string) => formatDate(at, { locale })
  return (
    <div className="fw-ca-pr">
      <div>
        <Link className="fw-ca-lk" href={recordHref(model.prefix, profile.id)}>
          {say(said('riders.profile.rev', { params: { garment: profile.garmentType, revision: profile.revision } }))}
        </Link>
      </div>
      <div>
        {profile.baseSize ? <span>{say(said('riders.profile.size', { params: { size: profile.baseSize } }))}</span> : null}
        <span className="fw-ca-sub">{say(said('riders.profile.measured', { params: { date: day(profile.takenAt) } }))}</span>
      </div>
      <div>
        <Tag tone={REVIEW_TONE[profile.review.status]}>{say(said(`sales-mtm:review.${profile.review.status}`))}</Tag>
        {profile.old ? <Tag tone="warning">{say(said('sales-mtm:tile.old'))}</Tag> : null}
        {profile.byLink ? <Tag tone="neutral">{say(said('sales-mtm:row.byLink'))}</Tag> : null}
        {profile.openUnits > 0 && model.can.ordersView ? (
          <Link className="fw-ca-lk" href={`${model.prefix}/sales/orders?profile=${encodeURIComponent(profile.id)}`}>
            {say(said('riders.profile.openOrders', { params: { count: profile.openUnits } }))}
          </Link>
        ) : null}
        {profile.nextFittingAt ? (
          <span className="fw-ca-sub">
            <CalendarClock size={12} aria-hidden />
            {say(said('riders.profile.nextFitting', { params: { date: day(profile.nextFittingAt) } }))}
          </span>
        ) : null}
      </div>
    </div>
  )
}
