'use client'
import { useState } from 'react'
import type { ActionSpec } from '../_canvas/actions'

/** Bulk action bar — appears when ≥1 object is selected. Each control STAGES an
 * action (opens the diff preview); nothing applies here. Budget + Status are the
 * v1 levers; Target-ACoS + Placement are a fast follow (stageActions supports them). */
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
        <button type="button" className="mc-actbtn" onClick={() => setBudgetOpen((o) => !o)}>
          Budget ▾
        </button>
        {budgetOpen && (
          <div className="mc-pop">
            <div className="mc-seg">
              {(['incPct', 'decPct', 'set'] as const).map((m) => (
                <button key={m} type="button" className={mode === m ? 'on' : ''} onClick={() => setMode(m)}>
                  {m === 'incPct' ? '+%' : m === 'decPct' ? '−%' : 'Set €'}
                </button>
              ))}
            </div>
            <input
              className="mc-pop-input"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              inputMode="decimal"
              aria-label="Budget value"
            />
            <button type="button" className="mc-actbtn primary" onClick={stageBudget}>
              Stage →
            </button>
          </div>
        )}
      </div>
      <button type="button" className="mc-actbtn" onClick={() => onStage({ kind: 'status', status: 'ENABLED' })}>
        Enable
      </button>
      <button type="button" className="mc-actbtn" onClick={() => onStage({ kind: 'status', status: 'PAUSED' })}>
        Pause
      </button>
      <button type="button" className="mc-actbtn" onClick={() => onStage({ kind: 'status', status: 'ARCHIVED' })}>
        Archive
      </button>
      <button type="button" className="mc-actbtn ghost" onClick={onClear}>
        Clear
      </button>
    </div>
  )
}
