'use client'

import { ArrowRight, Undo2, UserRound, X } from 'lucide-react'
import { FloorButton } from '@nexus/ui/floor'
import { DeptChip } from '../../../../lib/department/view/DeptChip'
import { useT } from '../../../../lib/i18n/provider'
import { BASKET_NS, StateFlag } from '../../parts'
import type { UndoEntry } from '../store'
import '../../basket.css'

/**
 * owb-fl6 (design § 5zg "3. Undo"; round 36: also a give) — ONE bar at the foot of every floor page, above the dock: the basket (or
 * "3 baskets"), from → to (a department, Ready to ship, or who had it → who has it now), **Undo**, and a cross that closes it. A give that
 * nobody held before has no Undo (today's API takes a give back only to a person): the bar says what was done and closes. After an Undo
 * that came too late: "Somebody moved this basket after you. Your step stays as it is." View only: the floor app runs the Undo.
 */
export interface UndoBarModel {
  readonly entry: UndoEntry | null
  readonly busy: boolean
  readonly said: 'moved' | 'failed' | null
}

export function UndoBar({ model, onUndo, onClose }: { readonly model: UndoBarModel; readonly onUndo: () => void; readonly onClose: () => void }) {
  const tb = useT(BASKET_NS)
  const { entry } = model
  const canUndo = entry !== null && (entry.kind === 'move' || entry.backTo !== null)
  return (
    <div className="fw-bk-undo" role="status" aria-label={tb('undo.label')}>
      {entry ? (
        <span className="fw-bk-undo-what">
          <bdi className="fw-bk-code">{entry.kind === 'move' ? (entry.code ?? tb('undo.baskets', { count: entry.count })) : entry.code}</bdi>
          <span className="fw-bk-undo-way">
            {entry.kind === 'move' ? (
              <>
                {entry.from ? <DeptChip dept={entry.from} /> : null}
                <ArrowRight className="fw-bk-mirror" aria-hidden="true" />
                {entry.toReady ? <StateFlag state="READY" /> : entry.to ? <DeptChip dept={entry.to} /> : null}
              </>
            ) : (
              <>
                {entry.from ? (
                  <span className="fw-bk-flag">
                    <UserRound aria-hidden="true" />
                    <bdi>{entry.from}</bdi>
                  </span>
                ) : null}
                <ArrowRight className="fw-bk-mirror" aria-hidden="true" />
                <span className="fw-bk-flag" data-tone="info">
                  <UserRound aria-hidden="true" />
                  <bdi>{entry.to}</bdi>
                </span>
              </>
            )}
          </span>
        </span>
      ) : null}
      {model.said ? <span className="fw-bk-undo-said">{tb(`undo.${model.said}`)}</span> : null}
      <span className="fw-bk-undo-acts">
        {canUndo ? (
          <FloorButton size="md" variant="secondary" icon={<Undo2 className="fw-bk-mirror" />} heldReason={model.busy ? tb('homePage.loading') : null} onClick={onUndo}>
            {tb('undo.undo')}
          </FloorButton>
        ) : null}
        <FloorButton size="md" variant="quiet" icon={<X />} aria-label={tb('undo.close')} onClick={onClose} />
      </span>
    </div>
  )
}
