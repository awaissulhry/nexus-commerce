'use client'
import { useState } from 'react'
import { DateTimeField } from '../components/DateTimeField'
import { Field } from '../components/Field'
/** An end time: from one minute from now to one year ahead, in 15-minute steps, in the viewer's zone. */
export function DateTimeFieldExample() {
  const [min] = useState(() => new Date(Date.now() + 60_000).toISOString())
  const [max] = useState(() => new Date(Date.now() + 366 * 24 * 3600_000).toISOString())
  const [value, setValue] = useState('')
  return <div style={{ maxWidth: 420 }}>
    <Field label="Ends" hint="The listing goes back to Follow by itself at this time.">
      <DateTimeField value={value} onChange={setValue} min={min} max={max} ariaLabel="Ends" />
    </Field>
    <div style={{ marginTop: 'var(--nds-space-8)', fontSize: 'var(--nds-font-size-xs)', color: 'var(--nds-text-muted)' }}>Stored: {value || 'not set'}</div>
  </div>
}
