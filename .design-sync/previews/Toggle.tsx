import { useState } from 'react'
import { Toggle } from '@nexus/design-system'

const cap = { fontSize: 12, color: 'var(--text-secondary)' }

/** On, off and `disabled` — a 30×17 track. `checked` is required; `onChange` gets the next value. */
export const States = () => {
  const [live, setLive] = useState(true)
  const [dry, setDry] = useState(false)
  const cell = { display: 'flex', flexDirection: 'column' as const, alignItems: 'center', gap: 8 }
  return (
    <div style={{ display: 'flex', gap: 28, alignItems: 'center', flexWrap: 'wrap' }}>
      <span style={cell}>
        <Toggle checked={live} onChange={setLive} aria-label="Live bid writes" />
        <span style={cap}>On</span>
      </span>
      <span style={cell}>
        <Toggle checked={dry} onChange={setDry} aria-label="Include paused campaigns" />
        <span style={cap}>Off</span>
      </span>
      <span style={cell}>
        <Toggle checked disabled onChange={() => {}} aria-label="Enforced by the account" />
        <span style={cap}>Disabled · on</span>
      </span>
      <span style={cell}>
        <Toggle checked={false} disabled onChange={() => {}} aria-label="Unavailable on this plan" />
        <span style={cap}>Disabled · off</span>
      </span>
    </div>
  )
}

const SETTINGS = [
  { id: 'writes', title: 'Live bid writes', desc: 'Rules push bids to Amazon instead of only proposing them.', on: true },
  { id: 'budget', title: 'Native budget rules', desc: 'INCREASE-only, Sponsored Products campaigns only.', on: true },
  { id: 'daypart', title: 'Dayparting', desc: 'Hour-of-day multipliers, applied on the 00:00 UTC budget day.', on: false },
  { id: 'email', title: 'Daily digest email', desc: 'One summary at 08:00 with every refusal and every write.', on: false },
]

/** The settings-row idiom: title + description on the left, the switch trailing right. */
export const SettingRows = () => {
  const [on, setOn] = useState<Record<string, boolean>>(
    Object.fromEntries(SETTINGS.map((s) => [s.id, s.on])),
  )
  return (
    <div style={{ display: 'flex', flexDirection: 'column', maxWidth: 460 }}>
      {SETTINGS.map((s, i) => (
        <div
          key={s.id}
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 16,
            padding: '12px 0',
            borderTop: i === 0 ? 'none' : '1px solid var(--border-subtle)',
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{s.title}</div>
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2 }}>{s.desc}</div>
          </div>
          <Toggle
            checked={on[s.id]}
            onChange={(next) => setOn((p) => ({ ...p, [s.id]: next }))}
            aria-label={s.title}
          />
        </div>
      ))}
    </div>
  )
}

/** Inline in a toolbar, where the switch sits after its own short caption. */
export const InlineInToolbar = () => {
  const [zeros, setZeros] = useState(false)
  const [suppressed, setSuppressed] = useState(true)
  const label = { display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--text-secondary)' }
  return (
    <div
      style={{
        display: 'flex',
        gap: 20,
        alignItems: 'center',
        flexWrap: 'wrap',
        padding: '10px 14px',
        background: 'var(--surface-sunken)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 10,
      }}
    >
      <span style={label}>
        Hide zero-spend rows
        <Toggle checked={zeros} onChange={setZeros} aria-label="Hide zero-spend rows" />
      </span>
      <span style={label}>
        Flag suppressed bids (≤ €0.03)
        <Toggle checked={suppressed} onChange={setSuppressed} aria-label="Flag suppressed bids" />
      </span>
    </div>
  )
}
