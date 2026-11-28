'use client'

import { useState } from 'react'
import { MessageCircleQuestion, TriangleAlert } from 'lucide-react'
import { FloorButton } from '@nexus/ui/floor'
import { useT } from '../../../lib/i18n/provider'
import type { HelpRead } from './api'
import { HelpWindow } from './HelpWindow'
import './help2.css'

/**
 * owb-fl8 — two of the basket's four tiles (Problem · Ask · Photo · Notes, one row, fl5's page draws the row): each tile is ONE
 * button (48 px and more, icon above its word) that opens its own window. One tap opens, one tap tells it.
 */

export interface TileProps {
  readonly read: HelpRead
  readonly onChanged?: () => void
}

/** Problem: the red tile → the Problem window. */
export function ProblemTile({ read, onChanged }: TileProps) {
  const t = useT('floor-help2')
  const [open, setOpen] = useState(false)
  return (
    <>
      <FloorButton className="fw-h2-tile" data-tone="danger" variant="secondary" icon={<TriangleAlert />} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
        {t('tile.problem')}
      </FloorButton>
      <ProblemWindow open={open} onClose={() => setOpen(false)} read={read} onChanged={onChanged} />
    </>
  )
}

/** Ask: → the Ask window (who answers is fixed by the ask). */
export function AskTile({ read, onChanged }: TileProps) {
  const t = useT('floor-help2')
  const [open, setOpen] = useState(false)
  return (
    <>
      <FloorButton className="fw-h2-tile" data-tone="info" variant="secondary" icon={<MessageCircleQuestion />} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
        {t('tile.ask')}
      </FloorButton>
      <AskWindow open={open} onClose={() => setOpen(false)} read={read} onChanged={onChanged} />
    </>
  )
}

export interface WindowProps {
  readonly open: boolean
  readonly onClose: () => void
  readonly read: HelpRead
  readonly onChanged?: () => void
}

/** The Problem window on its own (fl5 may open it from elsewhere). */
export const ProblemWindow = (props: WindowProps) => <HelpWindow group="PROBLEM" {...props} />

/** The Ask window on its own: fl5's "Ask your team leader" (a hold, not on its route, restricted) opens it. */
export const AskWindow = (props: WindowProps) => <HelpWindow group="ASK" {...props} />
