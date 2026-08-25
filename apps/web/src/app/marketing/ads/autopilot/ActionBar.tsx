'use client'
import { useState } from 'react'
import { Button } from '@/design-system/primitives/Button'
import { Input } from '@/design-system/primitives/Input'
import type { ActionSpec } from '../_canvas/actions'

/** Bulk action bar — appears when ≥1 object is selected. Each control STAGES an
 * action (opens the diff preview); nothing applies here. Budget + Status are the
 * v1 levers; Target-ACoS + Placement are a fast follow (stageActions supports them).
 *
 * DS alignment (2026-08-25): the seven `.mc-actbtn`s are the design system's `Button`
 * (`sm`), and the value field is its `Input`. `Clear` was `.mc-actbtn.ghost` — grey-500 on
 * white, **3.10:1, below the 4.5:1 floor**; `link` keeps it visually quieter than the four
 * committing actions beside it while raising it to 4.80:1.
 *
 * The `+% / −% / Set €` group stays hand-rolled on purpose: the DS has no segmented control
 * yet (the DS session is building one), and a local workaround is what the alignment is for
 * removing. It is the one thing on this bar that is not yet the DS.
 */
export function ActionBar({
  count,
  onStage,
  onClear,
}: {
  count: number
  onStage: (spec: ActionSpec) => void
  onClear: () => void
}) {
  const [budgetOpen, setBudgetOpen] = useState(false)
  const [mode, setMode] = useState<'incPct' | 'decPct' | 'set'>('incPct')
  const [value, setValue] = useState('10')

  const stageBudget = () => {
    const v = Number(value)
    if (!Number.isFinite(v) || v < 0) return
    onStage({ kind: 'budget', mode, value: v })
    setBudgetOpen(false)
  }

  return (
    <div className="mc-actbar">
      <span className="mc-actbar-count">
        {count} campaign{count === 1 ? '' : 's'} selected
      </span>
      <div className="mc-actbar-spacer" />
      <div className="mc-actbar-group">
        <Button size="sm" aria-expanded={budgetOpen} onClick={() => setBudgetOpen((o) => !o)}>
          Budget ▾
        </Button>
        {budgetOpen && (
          <div className="mc-pop">
            <div className="mc-seg">
              {(['incPct', 'decPct', 'set'] as const).map((m) => (
                <button key={m} type="button" className={mode === m ? 'on' : ''} onClick={() => setMode(m)}>
                  {m === 'incPct' ? '+%' : m === 'decPct' ? '−%' : 'Set €'}
                </button>
              ))}
            </div>
            <Input
              fieldClassName="mc-pop-input"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              inputMode="decimal"
              aria-label="Budget value"
            />
            <Button variant="primary" size="sm" onClick={stageBudget}>
              Stage →
            </Button>
          </div>
        )}
      </div>
      <Button size="sm" onClick={() => onStage({ kind: 'status', status: 'ENABLED' })}>
        Enable
      </Button>
      <Button size="sm" onClick={() => onStage({ kind: 'status', status: 'PAUSED' })}>
        Pause
      </Button>
      <Button size="sm" onClick={() => onStage({ kind: 'status', status: 'ARCHIVED' })}>
        Archive
      </Button>
      <Button variant="link" size="sm" onClick={onClear}>
        Clear
      </Button>
    </div>
  )
}
