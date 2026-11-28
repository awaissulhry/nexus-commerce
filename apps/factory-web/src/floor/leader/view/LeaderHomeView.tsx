'use client'

import { Check, ChevronDown, CircleAlert, CircleCheck, CloudOff, History, Package, Pin, RotateCcw, Route, UserRound, Users, X } from 'lucide-react'
import { FloorButton, ScanInput, type CameraScanner } from '@nexus/ui/floor'
import { DeptChip } from '../../../lib/department/view/DeptChip'
import { useT } from '../../../lib/i18n/provider'
import { TeamChip } from '../../../lib/people-picture/view/TeamChip'
import type { BasketRow, BasketTeam, ForYouItem } from '../../basket/api'
import { DepartmentButton, DepartmentPickWindow, type DepartmentPickAction, type DepartmentPickModel } from '../../basket/home/view/DepartmentPick'
import { ForYouList } from '../../basket/home/view/ForYouList'
import { deptOf } from '../../basket/model'
import { BASKET_NS, BasketPic, Flag, RowFlags, StateFlag } from '../../basket/parts'
import { FloorFrameView, type FrameAction, type FrameModel } from '../../frame/view/FloorFrameView'
import { FloorState } from '../../frame/view/FloorState'
import { TILE_ICON } from '../../home/view/HomeView'
import type { TileKey } from '../../model'
import { TEAM_FILTERS, type OrderGroup, type TeamFilter } from '../model'
import '../leader.css'
import '../../basket/basket.css'

/**
 * owb-fl6 step 3 (design § 5zg C "The leader's home: two parts: Baskets · Team"; P/fsteps.js leaderHome, lbRow, ordGroups; P/fplus.js
 * leaderToday, whoHas, handCard) — ONE heading, about 1.8 screens:
 *   Baskets   the four numbers of the TEAM in ONE row (a tap = those baskets; never a number of one person) · For you · the scan · the
 *             team's baskets BY ORDER: a row opens the basket, its pin is Do this first, its step is a button (→ the Steps window);
 *             "Change all" on an order of more than one basket
 *   Team      the team card (people missing, done today) · Who has what (tap a person → tap a basket → given) · the handover note ·
 *             the phone's other jobs
 * View only.
 */

export interface LeaderHomeViewModel {
  readonly frame: FrameModel
  readonly pick: DepartmentPickModel
  readonly part: 'baskets' | 'team'
  readonly state: 'loading' | 'ready' | 'offline' | 'unavailable'
  readonly team: BasketTeam | null
  readonly numbers: Readonly<Record<TeamFilter, number>> | null
  readonly filter: TeamFilter | null
  readonly forYou: readonly ForYouItem[]
  readonly groups: readonly OrderGroup[]
  readonly total: number
  readonly locale: string
  readonly readAt: number
  readonly people: readonly { readonly key: string; readonly label: string; readonly holds: string | null }[]
  readonly jobs: readonly TileKey[]
  readonly scanHeld?: boolean
  readonly badgeRefused?: boolean
  /** A Do this first's answer, in words. */
  readonly said: string | null
  readonly busy: boolean
}

export type LeaderHomeAction =
  | { readonly type: 'part'; readonly part: 'baskets' | 'team' }
  | { readonly type: 'filter'; readonly filter: TeamFilter | null }
  | { readonly type: 'open'; readonly code: string; readonly item?: ForYouItem }
  | { readonly type: 'step'; readonly code: string }
  | { readonly type: 'changeAll'; readonly key: string }
  | { readonly type: 'first'; readonly bundleId: string; readonly on: boolean }
  | { readonly type: 'person'; readonly key: string }
  | { readonly type: 'scan'; readonly code: string }
  | { readonly type: 'retry' }
  | { readonly type: 'job'; readonly key: TileKey }
  | DepartmentPickAction

const NUMBER_TONE: Readonly<Record<TeamFilter, 'info' | 'neutral' | 'danger'>> = { working: 'info', waiting: 'neutral', late: 'danger', problem: 'danger' }

export function LeaderHomeView({ model, onAction, onFrame, camera }: { readonly model: LeaderHomeViewModel; readonly onAction: (action: LeaderHomeAction) => void; readonly onFrame?: (action: FrameAction) => void; readonly camera?: CameraScanner }) {
  const tb = useT(BASKET_NS)
  return (
    <FloorFrameView frame={model.frame} onFrame={onFrame} lead={<DepartmentButton current={model.pick.current} onPress={() => onAction({ type: 'pickOpen' })} />}>
      <div className="fw-bk-stack">
        <div className="fw-ld-parts" role="group" aria-label={tb('leader.parts')}>
          <FloorButton size="md" variant={model.part === 'baskets' ? 'primary' : 'secondary'} aria-pressed={model.part === 'baskets'} icon={<Package />} onClick={() => onAction({ type: 'part', part: 'baskets' })}>
            {tb('leader.baskets', { count: model.total })}
          </FloorButton>
          <FloorButton size="md" variant={model.part === 'team' ? 'primary' : 'secondary'} aria-pressed={model.part === 'team'} icon={<Users />} onClick={() => onAction({ type: 'part', part: 'team' })}>
            {tb('leader.team')}
          </FloorButton>
        </div>
        {model.state === 'loading' ? <FloorState tone="info" icon={<Package />} title={tb('homePage.loading')} busy /> : null}
        {model.state === 'offline' ? <FloorState tone="warning" icon={<CloudOff />} title={tb('homePage.offline')} /> : null}
        {model.state === 'unavailable' ? (
          <FloorState tone="danger" icon={<CircleAlert />} title={tb('homePage.unavailable')} alert>
            <FloorButton size="md" variant="secondary" icon={<RotateCcw />} onClick={() => onAction({ type: 'retry' })}>
              {tb('homePage.retry')}
            </FloorButton>
          </FloorState>
        ) : null}
        {model.said ? (
          <p role="status" className="fw-floor-notice" data-tone="success">
            <span className="fw-floor-inline-icon" aria-hidden="true">
              <CircleCheck />
            </span>
            {model.said}
          </p>
        ) : null}
        {model.state === 'ready' && model.team ? model.part === 'baskets' ? <BasketsPart model={model} onAction={onAction} camera={camera} /> : <TeamPart model={model} team={model.team} onAction={onAction} /> : null}
      </div>
      <DepartmentPickWindow model={model.pick} onAction={onAction} />
    </FloorFrameView>
  )
}

function BasketsPart({ model, onAction, camera }: { readonly model: LeaderHomeViewModel; readonly onAction: (action: LeaderHomeAction) => void; readonly camera?: CameraScanner | undefined }) {
  const tb = useT(BASKET_NS)
  const t = useT('floor')
  const numbers = model.numbers
  return (
    <>
      {numbers ? (
        <div className="fw-ld-nums" role="group" aria-label={tb('leader.today')}>
          {TEAM_FILTERS.map((filter) => (
            <FloorButton
              key={filter}
              size="md"
              variant={model.filter === filter ? 'primary' : numbers[filter] > 0 && NUMBER_TONE[filter] === 'danger' ? 'danger' : 'secondary'}
              aria-pressed={model.filter === filter}
              aria-label={tb(`leader.number.${filter}`, { count: numbers[filter] })}
              onClick={() => onAction({ type: 'filter', filter: model.filter === filter ? null : filter })}
            >
              <span className="fw-ld-num">{numbers[filter]}</span>
              <span className="fw-ld-word">{tb(`leader.filter.${filter}`)}</span>
            </FloorButton>
          ))}
        </div>
      ) : null}
      <ForYouList items={model.forYou} onOpen={(item) => onAction({ type: 'open', code: item.code!, item })} />
      <ScanInput
        label={tb('homePage.scan')}
        hint={model.scanHeld ? t('tile.held.notice') : tb('homePage.scanHint')}
        scannedLabel={(code) => t('scan.read', { code })}
        keyboardLabel={t('scan.type')}
        disabled={model.scanHeld}
        camera={camera ? { scanner: camera, startLabel: t('scan.camera.start'), stopLabel: t('scan.camera.stop'), errorLabel: t('scan.camera.error') } : undefined}
        onScan={(code) => onAction({ type: 'scan', code })}
      />
      {model.badgeRefused ? (
        <p role="alert" className="fw-floor-notice" data-tone="danger">
          {t('home.badgeRefused')}
        </p>
      ) : null}
      {model.filter ? (
        <div className="fw-ld-filter">
          <span className="fw-bk-flags">
            <Flag tone={NUMBER_TONE[model.filter]} icon={<Check />}>
              {tb(`leader.filter.${model.filter}`)}
            </Flag>
          </span>
          <FloorButton size="md" variant="quiet" icon={<X />} onClick={() => onAction({ type: 'filter', filter: null })}>
            {tb('leader.showAll')}
          </FloorButton>
        </div>
      ) : null}
      {model.groups.length === 0 ? <p className="fw-bk-muted">{model.team?.team ? tb('leader.empty') : tb('leader.noTeam')}</p> : null}
      {model.groups.map((group) => (
        <section key={group.key} className="fw-ld-group" aria-label={group.order.customerCode}>
          <div className="fw-ld-group-head">
            <BasketPic id={group.key} code={group.order.customerCode} picture={group.order.picture} size="phone" now={model.readAt} />
            <span className="fw-ld-group-name">
              <bdi className="fw-bk-code">{group.order.customerCode}</bdi>
              <span className="fw-bk-muted">{tb('leader.orderBaskets', { count: group.rows.length })}</span>
            </span>
            {group.rows.length > 1 ? (
              <FloorButton size="md" variant="secondary" icon={<Route />} onClick={() => onAction({ type: 'changeAll', key: group.key })}>
                {tb('leader.changeAll')}
              </FloorButton>
            ) : null}
          </div>
          <ul className="fw-ld-rows">
            {group.rows.map((row) => (
              <LeadRow key={row.bundleId} row={row} locale={model.locale} now={model.readAt} busy={model.busy} onAction={onAction} />
            ))}
          </ul>
        </section>
      ))}
    </>
  )
}

function LeadRow({ row, locale, now, busy, onAction }: { readonly row: BasketRow; readonly locale: string; readonly now: number; readonly busy: boolean; readonly onAction: (action: LeaderHomeAction) => void }) {
  const tb = useT(BASKET_NS)
  const dept = deptOf(row.step.department, locale)
  return (
    <li className="fw-ld-row">
      <FloorButton size="lg" variant="secondary" className="fw-ld-main" onClick={() => onAction({ type: 'open', code: row.code })}>
        <BasketPic id={row.bundleId} code={row.code} picture={row.picture} size="phone" now={now} />
        <bdi className="fw-bk-code">{row.code}</bdi>
        <span className="fw-bk-flags">
          <RowFlags first={row.flags.first} problem={row.flags.problem} late={row.flags.late} />
          <StateFlag state={row.state} />
        </span>
      </FloorButton>
      <FloorButton size="lg" variant={row.flags.first ? 'primary' : 'secondary'} aria-pressed={row.flags.first} aria-label={tb('leader.firstOf', { code: row.code })} icon={<Pin />} heldReason={busy ? tb('homePage.loading') : null} onClick={() => onAction({ type: 'first', bundleId: row.bundleId, on: !row.flags.first })} />
      <FloorButton size="lg" variant="secondary" className="fw-ld-step" aria-label={tb('stepBar.changeLabel', { code: row.code })} onClick={() => onAction({ type: 'step', code: row.code })}>
        {dept ? <DeptChip dept={dept} /> : <StateFlag state="READY" />}
        <ChevronDown aria-hidden="true" />
      </FloorButton>
    </li>
  )
}

function TeamPart({ model, team, onAction }: { readonly model: LeaderHomeViewModel; readonly team: BasketTeam; readonly onAction: (action: LeaderHomeAction) => void }) {
  const tb = useT(BASKET_NS)
  const t = useT('floor')
  const topics = useT('floor-lineview')
  return (
    <>
      <div className="fw-ld-team">
        {team.team ? <TeamChip team={{ name: team.team.name, kind: team.team.picture?.kind ?? null, icon: team.team.picture?.icon ?? null, colour: team.team.picture?.colour ?? null }} /> : <span className="fw-bk-muted">{tb('leader.noTeam')}</span>}
        <Flag tone={team.missing > 0 ? 'warning' : 'neutral'} icon={<UserRound />}>
          {tb('leader.missing', { count: team.missing })}
        </Flag>
        <Flag tone="success" icon={<CircleCheck />}>
          {tb('leader.doneToday', { count: team.doneToday })}
        </Flag>
      </div>
      <h2 className="fw-bk-sec">{tb('leader.whoHas')}</h2>
      {model.people.length > 0 ? (
        <div className="fw-bk-people">
          {model.people.map((person) => (
            <FloorButton key={person.key} size="md" variant="secondary" icon={<UserRound />} onClick={() => onAction({ type: 'person', key: person.key })}>
              <bdi>{person.label}</bdi>
              {person.holds ? (
                <Flag tone="info" icon={<Package />}>
                  <bdi>{person.holds}</bdi>
                </Flag>
              ) : (
                <Flag tone="success" icon={<Check />}>
                  {tb('give.free')}
                </Flag>
              )}
            </FloorButton>
          ))}
        </div>
      ) : (
        <p className="fw-bk-muted">{tb('give.nobody')}</p>
      )}
      {team.handover ? (
        <div className="fw-bk-needs" data-tone="info">
          <History aria-hidden="true" />
          <div className="fw-bk-needs-text">
            <span className="fw-bk-needs-title">{tb('leader.handover')}</span>
            {team.handover.topics.length > 0 ? (
              <span className="fw-bk-flags">
                {team.handover.topics.map((topic) => (
                  <Flag key={topic} tone="primary" icon={<Check />}>
                    {topics(`topic.${topic}`)}
                  </Flag>
                ))}
              </span>
            ) : null}
            {team.handover.text ? <bdi>{team.handover.text}</bdi> : null}
          </div>
        </div>
      ) : null}
      {model.jobs.length > 0 ? (
        <div className="fw-bk-jobs">
          {model.jobs.map((key) => (
            <FloorButton key={key} size="md" variant="secondary" icon={TILE_ICON[key]} onClick={() => onAction({ type: 'job', key })}>
              {t(`tile.${key}`)}
            </FloorButton>
          ))}
        </div>
      ) : null}
    </>
  )
}
