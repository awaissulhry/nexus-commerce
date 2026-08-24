import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Listbox } from '@nexus/design-system'

/**
 * Preview harness — NOT part of the component API.
 *
 * Listbox keeps `open` in internal state and exposes no `open`/`defaultOpen`
 * prop, so the expanded list can only be reached the way an operator reaches
 * it: by clicking the trigger. This clicks it once on mount, then leaves the
 * DS's own state machine alone — every pixel below is the real component's.
 * `room` reserves layout height so the absolutely-positioned popover is not
 * clipped by the card cell's `overflow:hidden`.
 */
const Opened = ({ room, children }: { room: number; children: ReactNode }) => {
  const host = useRef<HTMLDivElement>(null)
  const fired = useRef(false)
  useEffect(() => {
    if (fired.current) return
    fired.current = true
    host.current?.querySelector('button')?.click()
  }, [])
  return (
    <div ref={host} style={{ paddingBottom: room }}>
      {children}
    </div>
  )
}

const MATCH_TYPES = [
  { value: 'exact', label: 'Exact' },
  { value: 'phrase', label: 'Phrase' },
  { value: 'broad', label: 'Broad' },
  { value: 'auto', label: 'Auto — Amazon decides' },
]

const MARKETPLACES = [
  { value: 'de', label: 'Amazon Germany' },
  { value: 'it', label: 'Amazon Italy' },
  { value: 'fr', label: 'Amazon France' },
  { value: 'es', label: 'Amazon Spain' },
]

const BID_STRATEGIES = [
  { value: 'down', label: 'Dynamic bids — down only' },
  { value: 'updown', label: 'Dynamic bids — up and down' },
  { value: 'fixed', label: 'Fixed bids' },
]

const PROGRAMS = [
  { value: 'sp', label: 'Sponsored Products' },
  { value: 'sb', label: 'Sponsored Brands' },
  { value: 'sd', label: 'Sponsored Display' },
]

const field: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6, width: 240 }
const caption: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }

/** The resting control: a button in the Select box skin, no native `<select>` anywhere. */
export const MatchType = () => {
  const [match, setMatch] = useState('phrase')
  return (
    <label style={field}>
      <span style={caption}>Match type</span>
      <Listbox options={MATCH_TYPES} value={match} onChange={setMatch} ariaLabel="Match type" />
    </label>
  )
}

/** Expanded: the Combobox popover surface, with the current value marked `on` (wash + primary). */
export const OpenOptions = () => {
  const [strategy, setStrategy] = useState('updown')
  return (
    <Opened room={170}>
      <label style={field}>
        <span style={caption}>Campaign bidding strategy</span>
        <Listbox options={BID_STRATEGIES} value={strategy} onChange={setStrategy} ariaLabel="Campaign bidding strategy" />
      </label>
    </Opened>
  )
}

/** Unset shows `placeholder` in tertiary ink; `disabled` dims the whole trigger to 55%. */
export const PlaceholderAndDisabled = () => {
  const [marketplace, setMarketplace] = useState('')
  return (
    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
      <label style={field}>
        <span style={caption}>Marketplace</span>
        <Listbox
          options={MARKETPLACES}
          value={marketplace}
          onChange={setMarketplace}
          placeholder="Choose a marketplace…"
          ariaLabel="Marketplace"
        />
      </label>
      <label style={field}>
        <span style={caption}>Program (locked by the rule)</span>
        <Listbox options={PROGRAMS} value="sp" onChange={() => {}} ariaLabel="Program" disabled />
      </label>
    </div>
  )
}

/** Three on one line — the scope row that sits above every campaign grid. */
export const ScopeRow = () => {
  const [marketplace, setMarketplace] = useState('de')
  const [program, setProgram] = useState('sp')
  const [state, setState] = useState('enabled')
  return (
    <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
      <label style={{ ...field, width: 200 }}>
        <span style={caption}>Marketplace</span>
        <Listbox options={MARKETPLACES} value={marketplace} onChange={setMarketplace} ariaLabel="Marketplace" />
      </label>
      <label style={{ ...field, width: 210 }}>
        <span style={caption}>Program</span>
        <Listbox options={PROGRAMS} value={program} onChange={setProgram} ariaLabel="Program" />
      </label>
      <label style={{ ...field, width: 160 }}>
        <span style={caption}>State</span>
        <Listbox
          options={[
            { value: 'enabled', label: 'Enabled' },
            { value: 'paused', label: 'Paused' },
            { value: 'archived', label: 'Archived' },
          ]}
          value={state}
          onChange={setState}
          ariaLabel="State"
        />
      </label>
    </div>
  )
}
