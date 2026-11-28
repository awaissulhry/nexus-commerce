'use client'

import type { ReactNode } from 'react'
import { ArrowRight, Check, CircleAlert, Image as ImageIcon, MoveDown, Package, Pause, Play, Route, ShieldCheck, UserCheck } from 'lucide-react'
import { FloorButton } from '@nexus/ui/floor'
import type { Department } from '../../../lib/department/model'
import { DeptChip } from '../../../lib/department/view/DeptChip'
import { useFloorWords } from '../../../lib/floor-words/FloorWords'
import { useT } from '../../../lib/i18n/provider'
import type { Dock } from '../model'
import { BASKET_NS, StateFlag } from '../parts'
import '../basket.css'

/**
 * owb-fl5 step 3 (design § 5zf A–B "the dock", § 5zg A "Pause now stands beside Done"; P/fplus.js floorDock) — the ONE next action,
 * in the floor frame's foot (sticky, always on the first screen, under the thumb), 64 px:
 *   Start (Resume) → Pause + Done (Done shows the next department's chip; Passed at Quality, held until the check is complete;
 *   Packed at the last step) · I saw the new design (before the next Start) · a hold: why, and Ask your team leader · another
 *   department: Take it here (scanned, on its route) · a team leader from a list: Change the step (fl6).
 * Built from DS FloorButtons (size lg = the main action's height); the layout puts Pause beside Done in ONE row (the DS action bar
 * gives the main action its own row on a phone). View only.
 */

export type DockAction = 'start' | 'pause' | 'done' | 'sawDesign' | 'takeHere' | 'changeStep' | 'askLeader'

export interface BasketDockModel {
  readonly dock: Dock
  /** Where Done sends it (null: ready to ship). */
  readonly next: Department | null
  /** The department this phone stands in (Take it here's chip). */
  readonly here: Department | null
  /** fl8's ask window is built ("Ask your team leader"). */
  readonly canAsk: boolean
  readonly busy: boolean
  /** A refusal or a failure, in words. */
  readonly problem: string | null
}

export function BasketDock({ model, onAction }: { readonly model: BasketDockModel; readonly onAction: (action: DockAction) => void }) {
  const tb = useT(BASKET_NS)
  const fw = useFloorWords(BASKET_NS)
  const { dock } = model
  const held = model.busy ? tb('homePage.loading') : null
  const ask = model.canAsk ? (
    <FloorButton size="lg" variant="primary" icon={<UserCheck />} heldReason={held} onClick={() => onAction('askLeader')}>
      {fw('dock.askLeader')}
    </FloorButton>
  ) : null
  const problem = model.problem ? (
    <p role="alert" className="fw-bk-dock-note" data-tone="danger">
      {model.problem}
    </p>
  ) : null

  let note: { readonly words: string; readonly tone?: 'warning' | 'danger' } | null = null
  let row: ReactNode = null
  let two = false
  switch (dock.kind) {
    case 'none':
      if (!problem) return null
      break
    case 'hold':
      // The page says the hold's words; the dock says what it is, where Start would be.
      note = { words: tb(`needs.hold.${dock.hold}`), tone: 'warning' }
      row = ask
      break
    case 'offRoute':
      row = ask
      if (!row && !problem) return null
      break
    case 'takeHere':
      note = { words: tb('elsewhere.warned') }
      row = (
        <FloorButton size="lg" variant="primary" className="fw-bk-dock-main" icon={<MoveDown />} heldReason={held} onClick={() => onAction('takeHere')}>
          {fw('dock.takeHere')}
          {model.here ? <DeptChip dept={model.here} /> : null}
        </FloorButton>
      )
      break
    case 'changeStep':
      row = (
        <FloorButton size="lg" variant="primary" icon={<Route />} heldReason={held} onClick={() => onAction('changeStep')}>
          {fw('dock.changeStep')}
        </FloorButton>
      )
      break
    case 'sawDesign':
      row = (
        <FloorButton size="lg" variant="warning" icon={<ImageIcon />} heldReason={held} onClick={() => onAction('sawDesign')}>
          {fw('dock.sawDesign')}
        </FloorButton>
      )
      break
    case 'start':
      row = (
        <FloorButton size="lg" variant="primary" icon={<Play />} heldReason={held} onClick={() => onAction('start')}>
          {fw(dock.resume ? 'dock.resume' : 'dock.start')}
        </FloorButton>
      )
      break
    case 'working': {
      const waits = dock.held ? tb('dock.qcFirst') : null
      if (waits) note = { words: waits, tone: 'warning' }
      two = dock.pause
      row = (
        <>
          {dock.pause ? (
            <FloorButton size="lg" variant="secondary" icon={<Pause />} heldReason={held} onClick={() => onAction('pause')}>
              {fw('dock.pause')}
            </FloorButton>
          ) : null}
          <FloorButton size="lg" variant="success" className="fw-bk-dock-main" icon={dock.main === 'passed' ? <ShieldCheck /> : dock.main === 'packed' ? <Package /> : <Check />} heldReason={waits ?? held} onClick={() => onAction('done')}>
            {fw(`dock.${dock.main}`)}
            <ArrowRight className="fw-bk-mirror" aria-hidden="true" />
            {model.next ? <DeptChip dept={model.next} /> : <StateFlag state="READY" />}
          </FloorButton>
        </>
      )
      break
    }
  }

  return (
    <div className="fw-bk-dock" role="group" aria-label={tb('dock.label')}>
      {note ? (
        <p className="fw-bk-dock-note" data-tone={note.tone}>
          {note.tone ? (
            <span className="fw-floor-inline-icon" aria-hidden="true">
              <CircleAlert />
            </span>
          ) : null}
          {note.words}
        </p>
      ) : null}
      {problem}
      {row ? <div className={two ? 'fw-bk-dock-row is-two' : 'fw-bk-dock-row'}>{row}</div> : null}
    </div>
  )
}

/** Whether the dock draws anything (the frame's foot is left out when it does not). */
export function dockDraws(model: Pick<BasketDockModel, 'dock' | 'canAsk' | 'problem'>): boolean {
  if (model.problem) return true
  if (model.dock.kind === 'none') return false
  if (model.dock.kind === 'offRoute') return model.canAsk
  return true
}
