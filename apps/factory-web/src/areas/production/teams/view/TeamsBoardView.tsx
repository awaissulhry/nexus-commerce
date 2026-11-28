'use client'

import type { ReactElement } from 'react'
import Link from 'next/link'
import { Info, Plus, Users } from 'lucide-react'
import { Banner, DetailPopover } from '@nexus/ui/components'
import { Button, InfoTip, Select, Skeleton, Tag } from '@nexus/ui/primitives'
import { formatDate } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { useRoomWidth } from '../../../../lib/order-cells/use-room-width'
import { sourceOfPicture } from '../../../../lib/people-picture/schema'
import { PeoplePicture } from '../../../../lib/people-picture/view/PeoplePicture'
import { roomOf } from '../../../../lib/window-shell/model'
import { BOARD_NS, filterColumns, loadWordsOf, markToneOf, markWordsOf, NO_TEAM_KEY, orderHref, type BoardModel, type CardModel, type ColumnModel, type MemberModel, type TeamsRights, type Words } from '../model'
import '../teams.css'

/**
 * owb-ss7 (7.1; design § 5za "a new page Production › Teams: one column a team, one for No team yet"; prototype teams.js teamsPage) — the
 * Teams page. Each column: the team's picture, name and leader, its load "9 of 12 baskets", its marks (Over its limit · Takes no new
 * order · n missing today · late), its people (tap a person: lend), and its orders as cards (number, customer CODE, baskets, due, In
 * charge); "No team yet" first. A card opens the order's Production tab; "Give to a team… / Change…" opens the window. Never a figure
 * for a small team: "—" with the ⓘ words "Small teams show no numbers". On a phone (a narrow room) the columns are one list with a team
 * filter; on a PC they fill the width (no dead space). Sales reads the page. Draws one model; fetches nothing.
 */

export interface TeamsBoardViewModel {
  readonly prefix: string
  readonly rights: TeamsRights
  readonly state: 'reading' | 'failed' | 'ready' | 'site'
  /** The read's failure (a key of `teams-board`). */
  readonly problem: string | null
  readonly board: BoardModel | null
  /** "All sites" with several: the sites to choose from (a team works on one site). */
  readonly sites: readonly { readonly id: string; readonly name: string }[]
  /** The phone's filter: 'all', 'none' or a team id. */
  readonly filter: string
  /** A done loan or save, in words. */
  readonly notice: Words | null
  /** Where "New team…" goes (People › Factory structure). */
  readonly newTeamHref: string
}

export interface TeamsBoardViewActions {
  readonly onRetry: () => void
  readonly onSite: (siteId: string) => void
  readonly onFilter: (filter: string) => void
  readonly onGive: (card: CardModel) => void
  readonly onLend: (member: MemberModel, teamId: string) => void
  readonly onDismissNotice: () => void
}

export function TeamsBoardView({ model, actions }: { model: TeamsBoardViewModel; actions?: TeamsBoardViewActions }): ReactElement {
  const t = useT(BOARD_NS)
  const room = useRoomWidth(roomOf, 'wide')
  const board = model.board
  const narrow = room.value === 'narrow'
  const columns = board ? (narrow ? filterColumns(board.columns, model.filter) : board.columns) : []
  return (
    <div className="fw-tm" ref={room.ref}>
      <div className="fw-tm-head">
        <p className="fw-tm-sum-line" role="status">
          {board ? [t('head.teams', { count: board.teams }), t('head.withTeam', { count: board.withTeam }), t('head.noTeam', { count: board.noTeam })].join(' · ') : null}
        </p>
        <span className="fw-tm-head-r">
          {model.rights.newTeam ? (
            <Button size="sm" asChild>
              <Link href={model.newTeamHref}>
                <Plus size={14} aria-hidden />
                {t('head.newTeam')}
              </Link>
            </Button>
          ) : null}
          {model.rights.give ? null : <Tag tone="neutral">{t('head.readOnly')}</Tag>}
          <DetailPopover trigger={<Info size={16} aria-hidden />} triggerLabel={t('head.infoLabel')} triggerClassName="nds-btn icon" label={t('head.infoLabel')} hoverDelay={0}>
            <p className="fw-tm-info">{t('head.info')}</p>
          </DetailPopover>
        </span>
      </div>

      {model.rights.give ? null : <Banner tone="info">{t('head.readNote')}</Banner>}
      {model.notice ? (
        <Banner
          tone="success"
          title={t(model.notice.key, model.notice.params)}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice()}>
              {t('notice.dismiss')}
            </Button>
          }
        />
      ) : null}

      {model.state === 'site' ? (
        <div className="fw-tm-sites">
          <span>{t('site.choose')}</span>
          {model.sites.map((site) => (
            <Button key={site.id} size="sm" onClick={() => actions?.onSite(site.id)}>
              {site.name}
            </Button>
          ))}
        </div>
      ) : model.state === 'reading' ? (
        <div className="fw-tm-board" aria-busy="true">
          {[0, 1, 2].map((index) => (
            <div key={index} className="fw-tm-col">
              <Skeleton height={40} />
              <Skeleton height={72} />
              <Skeleton height={72} />
            </div>
          ))}
        </div>
      ) : model.state === 'failed' || !board ? (
        <Banner
          tone="danger"
          title={t('failed')}
          action={
            <Button size="sm" onClick={() => actions?.onRetry()}>
              {t('common.retry')}
            </Button>
          }
        >
          {t(model.problem ?? 'error.read')}
        </Banner>
      ) : (
        <>
          {narrow ? (
            <label className="fw-tm-filter">
              <span>{t('filter.label')}</span>
              <Select size="sm" value={model.filter} onChange={(event) => actions?.onFilter(event.target.value)}>
                <option value="all">{t('filter.all')}</option>
                <option value={NO_TEAM_KEY}>{t('filter.none')}</option>
                {board.columns
                  .filter((column) => column.team)
                  .map((column) => (
                    <option key={column.key} value={column.key}>
                      {column.team!.name}
                    </option>
                  ))}
              </Select>
            </label>
          ) : null}
          <div className={`fw-tm-board${narrow ? ' is-list' : ''}`}>
            {columns.map((column) => (
              <TeamColumn key={column.key} column={column} model={model} actions={actions} />
            ))}
          </div>
        </>
      )}
      <p className="fw-tm-privacy">{t('privacy')}</p>
    </div>
  )
}

function TeamColumn({ column, model, actions }: { column: ColumnModel; model: TeamsBoardViewModel; actions?: TeamsBoardViewActions }): ReactElement {
  const t = useT(BOARD_NS)
  const team = column.team
  const name = team?.name ?? t('column.none')
  const load = loadWordsOf(column.load)
  return (
    <section className={`fw-tm-col${team ? '' : ' is-none'}`} aria-label={name}>
      <header className="fw-tm-col-h">
        {team ? (
          <PeoplePicture source={sourceOfPicture(team.name, team.picture, 'team')} size="lg" nameBeside />
        ) : (
          <span className="fw-tm-none-pic" aria-hidden>
            <Users size={20} />
          </span>
        )}
        <span className="fw-tm-col-t">
          <span className="fw-tm-col-name">{name}</span>
          <span className="fw-tm-col-sub">{team ? (team.leader ? t('column.leader', { name: team.leader.name }) : t('column.noLeader')) : t('column.noneHint')}</span>
        </span>
      </header>
      {team ? (
        <div className="fw-tm-col-facts">
          <span className="fw-tm-load">
            {t(load.key, load.params)}
            {column.load.kind === 'small' ? <InfoTip tip={t('load.smallInfo')} /> : null}
          </span>
          {team.people !== null ? <span className="fw-tm-col-sub">{t('column.people', { count: team.people })}</span> : null}
          {column.marks.map((mark) => {
            const said = markWordsOf(mark)
            return (
              <Tag key={mark.code} tone={markToneOf(mark.code)}>
                {t(said.key, said.params)}
              </Tag>
            )
          })}
        </div>
      ) : null}
      {team && column.people && column.people.length > 0 ? (
        <ul className="fw-tm-ppl" aria-label={t('people.label', { team: team.name })}>
          {column.people.map((member) => {
            const first = member.name.split(' ')[0] ?? member.name
            const inner = (
              <>
                <PeoplePicture source={{ name: member.name, who: 'person' }} size="sm" nameBeside />
                <span className="fw-tm-ppl-name">{first}</span>
                {member.isLead ? <span className="fw-tm-ppl-tag">{t('people.leader')}</span> : null}
                {member.onLoan ? <span className="fw-tm-ppl-tag">{t('people.onLoan')}</span> : null}
              </>
            )
            return (
              <li key={member.employeeId}>
                {model.rights.lend && !member.isLead ? (
                  <button type="button" className="fw-tm-ppl-b" title={member.name} aria-label={t('people.lend', { name: member.name })} onClick={() => actions?.onLend(member, team.id)}>
                    {inner}
                  </button>
                ) : (
                  <span className="fw-tm-ppl-b is-plain" title={member.name}>
                    {inner}
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      ) : null}
      {column.cards.length === 0 ? (
        <p className="fw-tm-quiet">{team ? t('column.empty') : t('column.noneEmpty')}</p>
      ) : (
        <ul className="fw-tm-cards" aria-label={t('column.orders', { team: name })}>
          {column.cards.map((card) => (
            <li key={card.orderId}>
              <OrderCard card={card} hasTeam={team !== null} model={model} onGive={() => actions?.onGive(card)} />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function OrderCard({ card, hasTeam, model, onGive }: { card: CardModel; hasTeam: boolean; model: TeamsBoardViewModel; onGive: () => void }): ReactElement {
  const t = useT(BOARD_NS)
  const locale = useLocale()
  const facts = [card.baskets !== null ? t('card.baskets', { count: card.baskets }) : null, card.due ? t('card.due', { date: formatDate(card.due, { locale }) }) : null].filter(Boolean).join(' · ')
  return (
    <div className="fw-tm-card">
      <Link className="fw-tm-card-main" href={orderHref(model.prefix, card.orderId)}>
        <span className="fw-tm-card-no">{card.number}</span>
        <span className="fw-tm-card-code">{card.customerCode}</span>
      </Link>
      <span className="fw-tm-card-foot">
        <span className="fw-tm-card-facts">{facts}</span>
        {card.late ? <Tag tone="danger">{t('card.late')}</Tag> : null}
        {card.inCharge ? <Tag tone="info">{t('card.inCharge')}</Tag> : null}
        <span className="fw-tm-grow" />
        {model.rights.give ? (
          <Button size="sm" onClick={onGive}>
            {t(hasTeam ? 'card.change' : 'card.give')}
          </Button>
        ) : null}
      </span>
    </div>
  )
}
