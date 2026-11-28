'use client'

import type { ReactNode } from 'react'
import { CircleAlert, Clock, Hourglass, Package, Pause, Pin, Play, Zap } from 'lucide-react'
import type { FloorTone } from '@nexus/ui/floor'
import type { Department } from '../../lib/department/model'
import { DeptChip } from '../../lib/department/view/DeptChip'
import type { PictureSize } from '../../lib/record-picture/model'
import { RecordPicture } from '../../lib/record-picture/view/RecordPicture'
import { useT } from '../../lib/i18n/provider'
import type { BasketPicture, WorkState } from './api'
import { heldOf, rowPictureOf } from './model'
import './basket.css'

/**
 * owb-fl5 — the small parts every basket screen draws the same way: a step's department (the base's DeptChip; a step with no
 * department says its name), the basket's picture (the base's picture part, source `basket`: its order's picture stamped for this
 * site), a state word and a flag. Never colour alone: an icon and a word always come with the tone. Views only: nothing is fetched.
 */

export const BASKET_NS = 'floor-basket'

/** A step's department as the chip every door draws, or the step's own name when it names no department. */
export function StepName({ dept, name }: { readonly dept: Department | null; readonly name: string }) {
  return dept ? <DeptChip dept={dept} /> : <span className="fw-bk-plain">{name}</span>
}

/** The basket's picture (a placeholder when it has none). `now`: when the read came (the address's life). */
export function BasketPic({ id, code, label, picture, size, now, onOpen }: { readonly id: string; readonly code: string; readonly label?: string | null; readonly picture: BasketPicture | null; readonly size: PictureSize; readonly now: number; readonly onOpen?: () => void }) {
  return <RecordPicture source="basket" recordId={id} number={code} picture={rowPictureOf({ id, code, label: label ?? null }, picture)} held={heldOf(picture, now)} size={size} {...(onOpen ? { onOpen } : {})} />
}

/** One flag: an icon and a word in a tone. */
export function Flag({ tone, icon, children }: { readonly tone: FloorTone; readonly icon: ReactNode; readonly children: ReactNode }) {
  return (
    <span className="fw-bk-flag" data-tone={tone}>
      <span aria-hidden="true">{icon}</span>
      {children}
    </span>
  )
}

const STATE_LOOK: Readonly<Record<WorkState | 'READY', { readonly tone: FloorTone; readonly icon: ReactNode }>> = {
  WAITING: { tone: 'neutral', icon: <Hourglass /> },
  WORKING: { tone: 'info', icon: <Play /> },
  PAUSED: { tone: 'warning', icon: <Pause /> },
  READY: { tone: 'success', icon: <Package /> },
}

/** Waiting · Working · Paused · Ready to ship. */
export function StateFlag({ state }: { readonly state: WorkState | 'READY' }) {
  const tb = useT(BASKET_NS)
  const look = STATE_LOOK[state]
  return (
    <Flag tone={look.tone} icon={look.icon}>
      {tb(`state.${state}`)}
    </Flag>
  )
}

/** The row flags of a basket: Do this first, a problem, late, rush. */
export function RowFlags({ first, problem, late, lateDays, rush }: { readonly first?: boolean; readonly problem?: boolean; readonly late?: boolean; readonly lateDays?: number | null; readonly rush?: boolean }) {
  const tb = useT(BASKET_NS)
  return (
    <>
      {first ? (
        <Flag tone="primary" icon={<Pin />}>
          {tb('flag.first')}
        </Flag>
      ) : null}
      {rush ? (
        <Flag tone="warning" icon={<Zap />}>
          {tb('flag.rush')}
        </Flag>
      ) : null}
      {problem ? (
        <Flag tone="danger" icon={<CircleAlert />}>
          {tb('flag.problem')}
        </Flag>
      ) : null}
      {late ? (
        <Flag tone="danger" icon={<Clock />}>
          {lateDays ? tb('flag.lateDays', { count: lateDays }) : tb('flag.late')}
        </Flag>
      ) : null}
    </>
  )
}
