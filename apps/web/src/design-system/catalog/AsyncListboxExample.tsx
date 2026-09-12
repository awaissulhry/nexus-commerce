'use client'

import { useState } from 'react'
import { AsyncListboxPanel } from '../components/AsyncListboxPanel'
import { Button } from '../primitives'

const options = [
  { value: 'standard', label: 'Standard delivery' },
  { value: 'retired', label: 'Retired delivery', disabled: true },
  { value: 'express', label: 'Express delivery' },
]

export function AsyncListboxExample() {
  const [query, setQuery] = useState('')
  const [state, setState] = useState<'ready' | 'loading' | 'error'>('ready')
  const [selection, setSelection] = useState('No selection')
  return <section id="async-listbox-example">
    <h3>AsyncListboxPanel</h3>
    <p>Search remote choices with consistent loading, retry and cancel states. Arrow keys skip disabled choices; Enter accepts a choice and Escape cancels.</p>
    <div className="nds-async-listbox-actions">
      <Button size="sm" variant="secondary" onClick={() => setState('loading')}>Show loading</Button>
      <Button size="sm" variant="secondary" onClick={() => setState('error')}>Show error</Button>
    </div>
    <AsyncListboxPanel label="Example delivery choices" query={query} onQueryChange={setQuery}
      options={options.filter(option => option.label.toLowerCase().includes(query.toLowerCase()))}
      loading={state === 'loading'} error={state === 'error' ? 'Choices are unavailable. Try again.' : undefined}
      onRetry={() => setState('ready')} onCommit={value => setSelection(value)} onCancel={() => setSelection('Cancelled')}
      style={{ width: 'min(400px, 100%)' }} />
    <p role="status">Example result: {selection}</p>
  </section>
}
