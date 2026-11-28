'use client'

import { useEffect, useRef } from 'react'
import { Clock, Hourglass, Kanban, Lock, Package, Pause, Pin, Play, TriangleAlert, Users, WifiOff } from 'lucide-react'
import { FloorButton, FloorList, FloorListRow } from '@nexus/ui/floor'
import { departmentOfAnswer } from '../../../lib/department/model'
import { DeptChip } from '../../../lib/department/view/DeptChip'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { FloorState } from '../../frame/view/FloorState'
import { TaskLine } from '../../tasks/shared/view/TaskParts'
import type { BoardScope, FloorBoard, FloorBoardCard } from '../api'
import { chipsOf, customerCodeOf, listOf, READY_CHIP } from '../model'
import '../board.css'

/**
 * owb-fl9 step 2 — the phone's Board (the team leader's tab; design § 5zf C, § 5zg C, § 5zl "the open tab is in view": the picked chip
 * scrolls into view): My team · Whole floor, one chip per department in use and Ready to ship (each with its count), the list (picture,
 * B-number, the customer's CODE, state, Do this first, a problem, late); a tap opens the basket. Nothing to tap under 48 px.
 */

export interface FloorBoardModel {
  readonly leader: boolean
  readonly scope: BoardScope
  readonly chip: string | null
  readonly board: FloorBoard | null
  readonly state: 'loading' | 'ready' | 'failed'
  readonly online: boolean
}

export type FloorBoardAction = { readonly type: 'scope'; readonly scope: BoardScope } | { readonly type: 'chip'; readonly key: string } | { readonly type: 'open'; readonly code: string } | { readonly type: 'retry' }

const STATE_ICON = { WORKING: Play, PAUSED: Pause, WAITING: Hourglass } as const

function Row({ card, ready, onOpen }: { card: FloorBoardCard; ready: boolean; onOpen: () => void }) {
  const t = useT('floor-board')
  const state = ready ? null : card.state === 'WORKING' || card.state === 'PAUSED' ? card.state : 'WAITING'
  const StateIcon = state ? STATE_ICON[state] : Package
  const flags: string[] = []
  if (card.flags?.first) flags.push(t('row.first'))
  if (card.flags?.problem) flags.push(t('row.problem'))
  if (card.flags?.late) flags.push(t('row.late'))
  return (
    <FloorListRow
      icon={card.picture?.src ? <img className="fw-fb-pic" src={card.picture.src} alt="" /> : <StateIcon />}
      title={<bdi className="fw-fb-code">{card.code}</bdi>}
      meta={
        <span className="fw-fb-meta">
          <bdi>{customerCodeOf(card)}</bdi>
          <span>
            <StateIcon aria-hidden className="fw-fb-icon" /> {ready ? t('row.ready') : t(`row.${state}`)}
          </span>
          {card.worker?.name ? <span>{card.worker.name}</span> : null}
        </span>
      }
      status={
        flags.length > 0 ? (
          <span className="fw-fb-flags">
            {card.flags?.first ? <Pin aria-hidden className="fw-fb-icon" /> : null}
            {card.flags?.problem ? <TriangleAlert aria-hidden className="fw-fb-icon" /> : null}
            {card.flags?.late ? <Clock aria-hidden className="fw-fb-icon" /> : null}
            {flags.join(' · ')}
          </span>
        ) : undefined
      }
      tone={card.flags?.problem ? 'danger' : card.flags?.first ? 'primary' : 'neutral'}
      onPress={onOpen}
    />
  )
}

export function FloorBoardView({ model, onAction }: { model: FloorBoardModel; onAction: (action: FloorBoardAction) => void }) {
  const t = useT('floor-board')
  const locale = useLocale()
  const chipsRef = useRef<HTMLDivElement>(null)
  const chips = model.board ? chipsOf(model.board) : []
  const picked = model.chip ?? chips[0]?.key ?? READY_CHIP

  // The picked chip is in view when the page opens (a long row of departments on a phone).
  useEffect(() => {
    chipsRef.current?.querySelector<HTMLElement>('[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest', inline: 'center' })
  }, [picked, model.state])

  if (!model.leader) return <FloorState tone="info" icon={<Lock />} title={t('leaderOnly')} />

  const list = model.board ? listOf(model.board, picked) : []
  return (
    <div className="fw-floor-stack fw-fb">
      <div className="fw-fb-scope" role="group" aria-label={t('scope.label')}>
        <FloorButton size="lg" variant={model.scope === 'team' ? 'primary' : 'secondary'} icon={<Users />} aria-pressed={model.scope === 'team'} onClick={() => onAction({ type: 'scope', scope: 'team' })}>
          {t('scope.team')}
        </FloorButton>
        <FloorButton size="lg" variant={model.scope === 'floor' ? 'primary' : 'secondary'} icon={<Kanban />} aria-pressed={model.scope === 'floor'} onClick={() => onAction({ type: 'scope', scope: 'floor' })}>
          {t('scope.floor')}
        </FloorButton>
      </div>
      {!model.online ? (
        <TaskLine tone="warning" icon={<WifiOff />}>
          {t('offline')}
        </TaskLine>
      ) : null}
      {model.state === 'loading' ? <FloorState tone="info" icon={<Kanban />} title={t('loading')} busy /> : null}
      {model.state === 'failed' ? (
        <FloorState tone="warning" icon={<WifiOff />} title={t('failed')}>
          <FloorButton variant="secondary" onClick={() => onAction({ type: 'retry' })}>
            {t('retry')}
          </FloorButton>
        </FloorState>
      ) : null}
      {model.state === 'ready' && model.board ? (
        <>
          <div className="fw-fb-chips" ref={chipsRef} role="group" aria-label={t('chips.label')}>
            {chips.map((chip) => (
              <FloorButton key={chip.key} variant="secondary" className="fw-fb-chip" aria-pressed={chip.key === picked} onClick={() => onAction({ type: 'chip', key: chip.key })}>
                {chip.department ? <DeptChip dept={departmentOfAnswer({ ...chip.department, shortName: chip.department.shortName ?? null, nameI18n: chip.department.nameI18n ?? null }, locale)} /> : <span className="fw-fb-ready"><Package aria-hidden className="fw-fb-icon" /> {t('chips.ready')}</span>}
                <span className="fw-fb-count">{chip.count}</span>
              </FloorButton>
            ))}
          </div>
          {list.length === 0 ? (
            <p className="fw-floor-lead">{t('empty')}</p>
          ) : (
            <FloorList label={t('list.label')}>
              {list.map((card) => (
                <Row key={card.bundleId} card={card} ready={picked === READY_CHIP} onOpen={() => onAction({ type: 'open', code: card.code })} />
              ))}
            </FloorList>
          )}
        </>
      ) : null}
    </div>
  )
}
