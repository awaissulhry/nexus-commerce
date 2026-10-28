'use client'

/**
 * FloorHelpButton — Help, always in the same corner of the floor top bar (gap G2, SCR-022). A question-mark icon with
 * the word under the app's control ("Aiuto" / "Help"); what it opens (a help sheet, a call to the lead) is the app's.
 */
import { CircleHelp } from 'lucide-react'

import { FloorButton } from './FloorButton'

export interface FloorHelpButtonProps {
  /** "Aiuto" / "Help". */
  label: string
  onPress: () => void
  /** `aria-haspopup` of what it opens. */
  hasPopup?: 'dialog' | 'menu'
  /** `aria-expanded` while it is open. */
  expanded?: boolean
}

export function FloorHelpButton({ label, onPress, hasPopup, expanded }: FloorHelpButtonProps) {
  return (
    <FloorButton variant="secondary" size="sm" icon={<CircleHelp />} onClick={onPress} aria-haspopup={hasPopup} aria-expanded={expanded} className="nds-floor-help">
      {label}
    </FloorButton>
  )
}
