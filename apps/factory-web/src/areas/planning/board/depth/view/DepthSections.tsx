'use client'

import { ArrowRight, History, Undo2 } from 'lucide-react'
import { Banner, Disclosure, EmptyState } from '@nexus/ui/components'
import { Button, FilterChip, SegmentedControl, Select, Skeleton, Spinner, Tag } from '@nexus/ui/primitives'
import { Timeline } from '../../../../../lib/i18n/ds-parts'
import type { Board } from '../../api'
import type { Refusal } from '../../model'
import type { BoardActions, BoardDepth, BoardViewModel } from '../../view-model'
import type { ChangeEntry } from '../api'
import {
  changeDetail,
  changeLabel,
  changePlaceWords,
  changeTone,
  depthProblemRows,
  effectParts,
  LOG_KINDS,
  orderMoveWords,
  triedMoveWords,
  undoHeldWords,
  type DepthProblemRow,
  type DepthWords,
} from '../model'

/**
 * The board's W2b sections (SCR-122, B-W2b-337): the What-if bar (design sec:whatif: the banner across the board, the deltas
 * against the working plan, the orders that move, Apply to plan · Discard), the Changes feed (design sec:log: every move with
 * who, when, from → to, Undo per move while it is still ours, Filter by planner) and the problems list's three W2b kinds.
 * The WhatIfBar is NEW in the design and not in the DS (frozen): composed here from Banner, Tag, Disclosure and Button.
 * ChangeValue is composed too (the DS one says "removed" and its screen-reader sentence in English only).
 */

const ready = <T,>(loaded: { status: string; value?: T }): T | null => (loaded.status === 'ready' ? (loaded as { value: T }).value : null)

/** Before → after, the old muted, an arrow, the new strong; a screen reader hears one sentence in the page's language. */
export function FromTo({ from, to, words }: { from: string | null; to: string | null; words: DepthWords }) {
  if (!from && !to) return null
  const said = from && to ? words.t('log.fromTo', { from, to }) : to ? words.t('log.toOnly', { to }) : words.t('log.fromOnly', { from: from ?? '' })
  return (
    <span className="fw-pbd-change">
      <span className="fw-pbd-change-lines" aria-hidden="true">
        {from ? <span className="fw-pbd-change-from">{from}</span> : null}
        <ArrowRight size={12} className="fw-pbd-change-arrow" />
        <span className="fw-pbd-change-to">{to ?? words.t('log.offBoard')}</span>
      </span>
      <span className="nds-vh">{said}</span>
    </span>
  )
}

// ---- What-if ----------------------------------------------------------------------------------------------------------------

export function WhatIfSection({ model, depth, board, actions, words }: { model: BoardViewModel; depth: BoardDepth; board: Board; actions?: BoardActions; words: DepthWords }) {
  const { t } = words
  const state = depth.whatIf
  if (!state) return null
  const scenario = ready(state.read)
  const mayChange = board.plan.mayChange
  const applyHeld = !mayChange ? t('held.whatIfReadOnly') : model.offline ? t('held.offline') : state.busy ? t('held.busy') : !scenario ? t('held.reading') : scenario.moves.length === 0 ? t('held.whatIfEmpty') : null
  const discardHeld = !mayChange ? t('held.whatIfReadOnly') : model.offline ? t('held.offline') : state.busy ? t('held.busy') : !scenario ? t('held.reading') : null
  return (
    <section className="fw-pbd-whatif" aria-labelledby="fw-pbd-whatif">
      <Banner tone="info" title={t('whatif.banner')}>
        {t('whatif.bannerBody')}
      </Banner>
      <div className="fw-pbd-head">
        <h2 className="fw-pb-h2" id="fw-pbd-whatif">
          {t('whatif.title')}
        </h2>
        <span className="fw-pbd-actions">
          <Button size="sm" variant="quiet" heldReason={discardHeld} onClick={() => actions?.onWhatIfDiscard?.()}>
            {t('whatif.discard')}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => actions?.onWhatIf?.(false)}>
            {t('whatif.leave')}
          </Button>
          <Button size="sm" variant="primary" heldReason={applyHeld} onClick={() => actions?.onWhatIfApply?.()}>
            {state.busy ? <Spinner size={12} /> : null} {scenario ? t('whatif.apply', { count: scenario.moves.length, moves: String(scenario.moves.length) }) : t('whatif.applyPlain')}
          </Button>
        </span>
      </div>
      {state.error ? <Banner tone="danger" title={state.error} /> : null}
      {state.read.status === 'loading' ? (
        <div className="fw-pbd-stack" aria-busy="true" aria-label={t('whatif.reading')}>
          <Skeleton width="50%" />
          <Skeleton height={28} />
        </div>
      ) : state.read.status === 'error' ? (
        <EmptyState
          title={t('whatif.errorTitle')}
          description={t(`error.${state.read.problem}`)}
          action={
            <Button size="sm" onClick={() => actions?.onWhatIfRetry?.()}>
              {t('dialog.retry')}
            </Button>
          }
        />
      ) : scenario ? (
        <>
          {scenario.moves.length === 0 ? (
            <p className="fw-pb-hint">{t('whatif.empty')}</p>
          ) : (
            <ul className="fw-pbd-deltas" aria-label={t('whatif.deltas')}>
              {effectParts(scenario, words).map((part) => (
                <li key={part}>
                  <Tag tone="info">{part}</Tag>
                </li>
              ))}
            </ul>
          )}
          {scenario.planChanged ? <Banner tone="warning" title={t('whatif.planChanged')}>{t('whatif.planChangedBody')}</Banner> : null}
          {scenario.moves.length > 0 ? (
            <Disclosure summary={t('whatif.movesSummary', { count: scenario.moves.length, moves: String(scenario.moves.length) })}>
              <ul className="fw-pbd-list">
                {scenario.moves.map((move, index) => {
                  const said = triedMoveWords(move, board, words)
                  return (
                    <li key={`${move.slotId ?? move.operationId}-${index}`} className="fw-pbd-move">
                      <span>{said.what}</span>
                      <FromTo from={said.from} to={said.to} words={words} />
                      {move.conflict ? <Tag tone="danger">{t(`whatif.conflict.${move.conflict.code}`)}</Tag> : null}
                      {move.material && !move.material.inTime ? <Tag tone="warning">{t('whatif.materialLate')}</Tag> : null}
                    </li>
                  )
                })}
              </ul>
            </Disclosure>
          ) : null}
          {scenario.effect.orders.length > 0 ? (
            <Disclosure summary={t('whatif.ordersSummary', { count: scenario.effect.orders.length, orders: String(scenario.effect.orders.length) })}>
              <ul className="fw-pbd-list">
                {scenario.effect.orders.map((order) => (
                  <li key={order.workOrderId}>{orderMoveWords(order, words)}</li>
                ))}
              </ul>
            </Disclosure>
          ) : null}
          <p className="fw-pb-hint">{t('whatif.private')}</p>
        </>
      ) : null}
    </section>
  )
}

// ---- Changes (the board's log) ----------------------------------------------------------------------------------------------

export function ChangesSection({ model, depth, board, actions, words, say }: { model: BoardViewModel; depth: BoardDepth; board: Board; actions?: BoardActions; words: DepthWords; say: (refusal: Refusal) => string }) {
  const { t } = words
  const changes = depth.changes
  const page = ready(changes.read)
  const step = (entry: ChangeEntry) => {
    const held = model.offline ? t('held.offline') : changes.busy ? t('held.busy') : undoHeldWords(entry, words)
    const undoable = entry.kind !== 'PUBLISH' && entry.kind !== 'UNDO'
    return {
      key: entry.id,
      tone: changeTone(entry),
      at: entry.changedAt,
      label: (
        <span className="fw-pbd-entry">
          <span>{changeLabel(entry, words)}</span>
          {entry.from || entry.to ? <FromTo from={changePlaceWords(entry.from, words)} to={entry.kind === 'REMOVE' ? null : changePlaceWords(entry.to, words)} words={words} /> : null}
        </span>
      ),
      detail: changeDetail(entry, words),
      action: undoable ? (
        <Button size="sm" variant="quiet" heldReason={held} onClick={() => actions?.onUndo?.(entry.id)} aria-label={t('log.undoOne', { what: changeLabel(entry, words) })}>
          {changes.busy === entry.id ? <Spinner size={12} /> : <Undo2 size={14} aria-hidden />} {t('log.undo')}
        </Button>
      ) : undefined,
    }
  }
  const emptyWords = changes.since === 'PUBLISHED' && page?.since ? t('log.emptySince', { version: page.since.number }) : changes.since === 'PUBLISHED' && board.plan.published ? t('log.emptySince', { version: board.plan.published.number }) : t('log.empty')
  return (
    <section className="fw-pbd-log" aria-labelledby="fw-pbd-log">
      <div className="fw-pbd-head">
        <h2 className="fw-pb-h2" id="fw-pbd-log">
          {t('log.title')}
        </h2>
        <span className="fw-pb-hint">{t('log.hint')}</span>
      </div>
      <div className="fw-pbd-filters" role="group" aria-label={t('log.filters')}>
        <SegmentedControl
          size="sm"
          ariaLabel={t('log.since')}
          options={[
            { value: 'PUBLISHED', label: page?.since ? t('log.sinceVersion', { version: page.since.number }) : t('log.sincePublished') },
            { value: 'ALL', label: t('log.all') },
          ]}
          value={changes.since}
          onChange={(value) => actions?.onChangesFilter?.({ since: value === 'ALL' ? 'ALL' : 'PUBLISHED' })}
        />
        {LOG_KINDS.map((kind) => {
          const on = changes.kinds.includes(kind)
          return (
            <FilterChip key={kind} pressed={on} onClick={() => actions?.onChangesFilter?.({ kinds: on ? changes.kinds.filter((entry) => entry !== kind) : [...changes.kinds, kind] })}>
              {t(`log.chip.${kind}`)}
            </FilterChip>
          )
        })}
        <Select size="sm" aria-label={t('log.planner')} value={changes.planner ?? ''} onChange={(event) => actions?.onChangesFilter?.({ planner: event.target.value || null })}>
          <option value="">{t('log.everyPlanner')}</option>
          {changes.planners.map((planner) => (
            <option key={planner.id} value={planner.id}>
              {planner.name}
            </option>
          ))}
        </Select>
      </div>
      {changes.error ? <Banner tone="danger" title={say(changes.error)} /> : null}
      {changes.read.status === 'loading' ? (
        <div className="fw-pbd-stack" aria-busy="true" aria-label={t('log.reading')}>
          <Skeleton height={36} />
          <Skeleton height={36} />
          <Skeleton height={36} />
        </div>
      ) : changes.read.status === 'error' ? (
        <EmptyState
          icon={<History size={24} aria-hidden />}
          title={t('log.errorTitle')}
          description={t(`error.${changes.read.problem}`)}
          action={
            <Button size="sm" onClick={() => actions?.onChangesRetry?.()}>
              {t('dialog.retry')}
            </Button>
          }
        />
      ) : page && page.entries.length === 0 ? (
        <p className="fw-pb-hint">{emptyWords}</p>
      ) : page ? (
        <>
          <Timeline label={t('log.title')} steps={page.entries.map(step)} />
          {page.next ? (
            <Button size="sm" variant="secondary" heldReason={changes.more ? t('held.busy') : null} onClick={() => actions?.onChangesMore?.()}>
              {changes.more ? <Spinner size={12} /> : null} {t('log.more')}
            </Button>
          ) : null}
        </>
      ) : null}
    </section>
  )
}

// ---- the problems list's W2b kinds ------------------------------------------------------------------------------------------

export function DepthProblems({ model, board, actions, words }: { model: BoardViewModel; board: Board; actions?: BoardActions; words: DepthWords }) {
  const { t } = words
  const rows = depthProblemRows(board, words)
  if (rows.length === 0) return null
  const mayChange = board.plan.mayChange
  const fixHeld = (row: DepthProblemRow) => (!mayChange ? t('held.readOnly') : model.offline ? t('held.offline') : model.depth?.whatIf ? t('held.inWhatIf') : row.fix === 'snap' && !row.slotId ? t('held.reading') : null)
  return (
    <ul className="fw-pb-problem-list" aria-label={t('problems.more')}>
      {rows.map((row) => (
        <li key={row.id} className="fw-pb-problem">
          <Tag tone={row.kind === 'GATE_NOT_PASSED' ? 'danger' : 'warning'}>{t(`problems.kind.${row.kind}`)}</Tag>
          <span className="fw-pb-problem-words">{row.words}</span>
          {row.fix ? (
            <Button size="sm" variant="secondary" heldReason={fixHeld(row)} onClick={() => actions?.onProblemFix?.(row)}>
              {t(`problems.fix.${row.fix}`)}
            </Button>
          ) : null}
          <Button size="sm" variant="quiet" onClick={() => actions?.onShowDepthProblem?.(row)}>
            {t('problems.show')}
          </Button>
        </li>
      ))}
    </ul>
  )
}
