'use client'

/**
 * MX.P — the SELECTION surface for the Matrix verbs (design §3.8): the DS `BulkActionBar`, the eleven
 * verbs from ONE declaration (the engine's `matrixActions`). A `hidden` verb (a parent-only selection)
 * is not offered at all; a held one is.
 *
 * 🔴 A verb this selection cannot run is KEPT, with its reason, and it is HELD rather than `disabled`:
 * `aria-disabled` + the sentence in the DOM, so hover, focus and a press all explain themselves
 * (`scripts/check-silent-disabled.mjs`). "Nothing in this selection carries inventory" is something
 * the operator can fix by ticking different rows — a bar that hid the verb would leave them with an
 * empty strip and no idea which selection would fill it.
 */
import { memo } from 'react'

import { BulkActionBar } from '@/design-system/patterns/BulkActionBar'
import { Button, InfoTip } from '@/design-system/primitives'

import type { MatrixVerbSpec } from '@/design-system/grid'

import type { StudioRow } from '../sheet/master/types'

export interface MatrixSelectionBarProps {
  rows: readonly StudioRow[]
  verbs: readonly MatrixVerbSpec[]
  /** `on Amazon · IT` · `on all 8 coordinates` — what the selection's cells span. */
  scopeLabel: string
  busy: boolean
  onVerb: (verb: MatrixVerbSpec) => void
  onClear: () => void
}

export const MatrixSelectionBar = memo(function MatrixSelectionBar({ rows, verbs, scopeLabel, busy, onVerb, onClear }: MatrixSelectionBarProps) {
  if (rows.length === 0) return null
  const noun = `${rows.length === 1 ? 'row selected' : 'rows selected'} · ${scopeLabel}`
  return (
    <BulkActionBar count={rows.length} noun={noun} onClear={onClear} className="nds-matrix-selbar">
      {verbs.filter((verb) => !verb.hidden).map((verb) => {
        const held = verb.unavailable ?? null
        const button = (
          <Button
            size="sm"
            variant={verb.danger ? 'danger' : 'secondary'}
            disabled={busy}
            aria-disabled={!!held || busy}
            className={held ? 'held' : undefined}
            title={held ?? verb.label}
            onClick={() => { if (held || busy) return; onVerb(verb) }}
          >
            {verb.label}
          </Button>
        )
        return held ? <InfoTip key={verb.id} tip={held}>{button}</InfoTip> : <span key={verb.id}>{button}</span>
      })}
    </BulkActionBar>
  )
})
