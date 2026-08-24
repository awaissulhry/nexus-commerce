import { useState } from 'react'
import { Radio } from '@nexus/design-system'

/** A radio group: one shared `name`, one `checked` at a time, plus a `disabled` option. */
export const MatchTypeGroup = () => {
  const [match, setMatch] = useState('exact')
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>Match type</span>
      <Radio name="match" label="Exact" checked={match === 'exact'} onChange={() => setMatch('exact')} />
      <Radio name="match" label="Phrase" checked={match === 'phrase'} onChange={() => setMatch('phrase')} />
      <Radio name="match" label="Broad" checked={match === 'broad'} onChange={() => setMatch('broad')} />
      <Radio name="match" label="Close match (auto campaigns only)" checked={false} disabled readOnly />
    </div>
  )
}

/** Laid out inline, as a compact one-line choice above a grid. */
export const InlineGroup = () => {
  const [scope, setScope] = useState('adgroup')
  return (
    <div style={{ display: 'flex', gap: 20, alignItems: 'center', flexWrap: 'wrap' }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>Negate at</span>
      <Radio name="scope" label="Ad group" checked={scope === 'adgroup'} onChange={() => setScope('adgroup')} />
      <Radio name="scope" label="Campaign" checked={scope === 'campaign'} onChange={() => setScope('campaign')} />
      <Radio name="scope" label="Portfolio" checked={false} disabled readOnly />
    </div>
  )
}

/** A rich label — the option carries its own consequence line. */
export const RichLabels = () => {
  const [mode, setMode] = useState('propose')
  const hint = { display: 'block', fontSize: 11.5, color: 'var(--text-tertiary)', marginTop: 2 }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 13, maxWidth: 400 }}>
      <Radio
        name="autonomy"
        checked={mode === 'propose'}
        onChange={() => setMode('propose')}
        label={
          <span>
            Propose only
            <span style={hint}>Writes land in the queue for an operator to approve.</span>
          </span>
        }
      />
      <Radio
        name="autonomy"
        checked={mode === 'auto'}
        onChange={() => setMode('auto')}
        label={
          <span>
            Apply automatically
            <span style={hint}>Bids and budgets go to Amazon on the next engine run.</span>
          </span>
        }
      />
    </div>
  )
}
