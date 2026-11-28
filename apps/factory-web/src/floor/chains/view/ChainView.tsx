'use client'

import { Check, CircleAlert, Hourglass, Minus, Plus, Route, WifiOff } from 'lucide-react'
import { FloorButton } from '@nexus/ui/floor'
import { departmentOfAnswer } from '../../../lib/department/model'
import { DeptChip } from '../../../lib/department/view/DeptChip'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { FloorState } from '../../frame/view/FloorState'
import { TaskLine } from '../../tasks/shared/view/TaskParts'
import type { FloorChain } from '../api'
import { lotAt, plusOf, undoOpen, type LastReport } from '../model'
import '../../board/board.css'

/**
 * owb-fl9 step 3 — a chain on the floor (design § 4.8; P/lines.js chainSteps): a chip per step (number, department, done), ONE step on
 * the screen, its lots as big rows: size, model, done, waiting; **+12** (one report of the cell's next bundle) and, for two minutes,
 * **−12** (the worker's own Undo of that report). The slowest step says "Slowest" and how many wait (never colour alone).
 */

export interface ChainModel {
  readonly lineId: string | null
  readonly chain: FloorChain | null
  readonly step: string | null
  readonly state: 'loading' | 'ready' | 'failed'
  readonly online: boolean
  readonly last: LastReport | null
  readonly now: number
  /** The lot being reported (its +12 waits). */
  readonly busy: string | null
  readonly problem: string | null
}

export type ChainAction = { readonly type: 'step'; readonly operationId: string } | { readonly type: 'plus'; readonly workOrderSizeId: string } | { readonly type: 'minus' } | { readonly type: 'retry' }

export function ChainView({ model, onAction }: { model: ChainModel; onAction: (action: ChainAction) => void }) {
  const t = useT('floor-board')
  const locale = useLocale()
  if (!model.lineId) return <FloorState tone="info" icon={<Route />} title={t('chain.noLine')} />
  if (model.state === 'loading') return <FloorState tone="info" icon={<Route />} title={t('loading')} busy />
  if (model.state === 'failed' || !model.chain)
    return (
      <FloorState tone="warning" icon={<WifiOff />} title={t('failed')}>
        <FloorButton variant="secondary" onClick={() => onAction({ type: 'retry' })}>
          {t('retry')}
        </FloorButton>
      </FloorState>
    )
  const chain = model.chain
  const step = chain.steps.find((entry) => entry.operationId === model.step) ?? chain.steps[0]
  if (!step) return <FloorState tone="info" icon={<Route />} title={t('chain.noSteps')} />
  return (
    <div className="fw-floor-stack fw-fb">
      <div className="fw-fb-chips" role="group" aria-label={t('chain.steps')}>
        {chain.steps.map((entry, index) => (
          <FloorButton key={entry.operationId} variant="secondary" className="fw-fb-chip" aria-pressed={entry.operationId === step.operationId} onClick={() => onAction({ type: 'step', operationId: entry.operationId })}>
            <span className="fw-fb-no">{index + 1}</span>
            {entry.department ? <DeptChip dept={departmentOfAnswer({ ...entry.department, shortName: entry.department.shortName ?? null, nameI18n: entry.department.nameI18n ?? null }, locale)} /> : <span>{entry.name}</span>}
            <span className="fw-fb-count">{entry.done}</span>
          </FloorButton>
        ))}
      </div>
      <div className="fw-fb-stephead">
        <h2 className="fw-floor-section-title">{step.name}</h2>
        {step.slowest ? (
          <span className="fw-fb-slow">
            <Hourglass aria-hidden className="fw-fb-icon" /> {t('chain.slowest', { count: step.waiting })}
          </span>
        ) : null}
      </div>
      {!model.online ? (
        <TaskLine tone="warning" icon={<WifiOff />}>
          {t('chain.offline')}
        </TaskLine>
      ) : null}
      {model.problem ? (
        <TaskLine tone="danger" icon={<CircleAlert />} alert>
          {model.problem}
        </TaskLine>
      ) : null}
      <ul className="fw-fb-lots">
        {chain.lots.map((lot) => {
          const cell = lotAt(lot, step.operationId)
          const plus = plusOf(lot)
          const canUndo = undoOpen(model.last, lot.workOrderSizeId, step.operationId, model.now)
          const held = !model.online ? t('chain.offline') : model.busy ? t('chain.sending') : null
          return (
            <li key={lot.workOrderSizeId} className="fw-fb-lot" data-full={cell.full || undefined}>
              <div className="fw-fb-lottext">
                <span className="fw-fb-size">{lot.size}</span>
                <span className="fw-fb-model">{lot.model}</span>
                <span className="fw-fb-done">
                  <b>{cell.done}</b>
                  {lot.quantity !== undefined ? ` / ${lot.quantity}` : ''}
                  {cell.full ? <Check aria-hidden className="fw-fb-icon fw-fb-ok" /> : null}
                </span>
                {cell.waiting > 0 ? <span className="fw-floor-muted">{t('chain.waiting', { count: cell.waiting })}</span> : null}
              </div>
              <div className="fw-fb-lotacts">
                <FloorButton size="lg" variant="primary" icon={<Plus />} heldReason={cell.full ? t('chain.full') : held} onClick={() => onAction({ type: 'plus', workOrderSizeId: lot.workOrderSizeId })}>
                  {plus !== null ? `+${plus}` : t('chain.plusBundle')}
                </FloorButton>
                {canUndo && model.last ? (
                  <FloorButton size="lg" variant="secondary" icon={<Minus />} aria-label={t('chain.undoLabel', { count: model.last.quantity, code: model.last.bundleCode })} onClick={() => onAction({ type: 'minus' })}>
                    −{model.last.quantity}
                  </FloorButton>
                ) : null}
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
