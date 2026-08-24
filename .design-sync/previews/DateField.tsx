// DateField — the single-date replacement for `<input type="date">` (native
// date chrome is banned by the DS conformance ratchet). Controlled: `value` is
// an ISO 'YYYY-MM-DD' string, '' means unset.
//
// Compositions ported from the compliance and workflow tabs
// (apps/web/src/app/products/[id]/edit/tabs/ComplianceTab.tsx, WorkflowTab.tsx),
// which pair it with a label above and pass `ariaLabel`.
//
// Dates are FIXED literals, never `new Date()` — a capture that moves with the
// clock is a card that changes every day.
import { useState, type ReactNode } from 'react'
import { DateField } from '@nexus/design-system'

// The field is width:100%; the product gives it a form column, so the stories do too.
const Field = ({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 5, maxWidth: 260 }}>
    <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>{label}</span>
    {children}
    {hint && <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>{hint}</span>}
  </div>
)

/** A date already chosen — the trigger prints it as DD/MM/YYYY. */
export const Selected = () => {
  const [value, setValue] = useState('2026-08-14')
  return (
    <Field label="Certificate issued">
      <DateField value={value} onChange={setValue} ariaLabel="Issued date" />
    </Field>
  )
}

/** Unset: `value=''` shows `placeholder` in the muted placeholder ink. */
export const Empty = () => {
  const [value, setValue] = useState('')
  return (
    <Field label="Expiry date" hint="Leave empty for a certificate that does not expire.">
      <DateField value={value} onChange={setValue} placeholder="not set" ariaLabel="Expiry date" />
    </Field>
  )
}

/** `min`/`max` bound the calendar — days outside the window render disabled and refuse the click. */
export const Bounded = () => {
  const [value, setValue] = useState('2026-09-30')
  return (
    <Field label="Task due" hint="Within the current planning quarter (1 Jul – 31 Dec 2026).">
      <DateField value={value} onChange={setValue} min="2026-07-01" max="2026-12-31" ariaLabel="Due date" />
    </Field>
  )
}

/** Disabled — the whole trigger is inert, so the calendar can never open. */
export const Disabled = () => (
  <Field label="Locked by the flat-file import" hint="Set by the last import; edit it there.">
    <DateField value="2026-06-01" onChange={() => {}} disabled ariaLabel="Import date" />
  </Field>
)

/** The real pairing: two bounded fields in one compliance row. */
export const ValidityRange = () => {
  const [issued, setIssued] = useState('2026-03-12')
  const [expires, setExpires] = useState('2027-03-11')
  return (
    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
      <Field label="Issued">
        <DateField value={issued} onChange={setIssued} max={expires} ariaLabel="Issued date" />
      </Field>
      <Field label="Expires">
        <DateField value={expires} onChange={setExpires} min={issued} clearLabel="no expiry" ariaLabel="Expiry date" />
      </Field>
    </div>
  )
}
