import { useEffect, useRef, useState, type ReactNode } from 'react'
import { MultiSelect } from '@nexus/design-system'

// The card harness clips overlays: `.ds-cell` (lib/emit.mjs) sets `overflow:hidden`,
// so any panel that escapes its trigger's box is cut off. Only InfoTip survives it,
// because InfoTip portals to <body>; every other DS overlay renders in-flow. Scoped
// to this component's own page — each card is a separate document.
if (typeof document !== 'undefined' && !document.getElementById('ds-overlay-overflow')) {
  const st = document.createElement('style')
  st.id = 'ds-overlay-overflow'
  st.textContent = '.ds-cell{overflow:visible}'
  document.head.appendChild(st)
}


/**
 * Preview harness — NOT part of the component API.
 *
 * MultiSelect owns `open` internally and exposes no prop for it, so the
 * expanded checkbox list is reached the way an operator reaches it: one click
 * on the trigger, on mount. Everything rendered after that is the DS
 * component's own markup and state. `room` reserves layout height so the
 * absolutely-positioned popover is not clipped by the card cell.
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

const PROGRAMS = [
  { value: 'sp', label: 'Sponsored Products' },
  { value: 'sb', label: 'Sponsored Brands' },
  { value: 'sd', label: 'Sponsored Display' },
]

const MARKETPLACES = [
  { value: 'de', label: 'Amazon Germany' },
  { value: 'it', label: 'Amazon Italy' },
  { value: 'fr', label: 'Amazon France' },
  { value: 'es', label: 'Amazon Spain' },
]

const STATES = [
  { value: 'enabled', label: 'Enabled' },
  { value: 'paused', label: 'Paused' },
  { value: 'out-of-budget', label: 'Out of budget' },
  { value: 'archived', label: 'Archived' },
]

const field: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6 }
const caption: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }

/** A partial selection reads as "N selected" — the trigger never lists the values. */
export const CampaignTypes = () => {
  const [programs, setPrograms] = useState(['sp', 'sd'])
  return (
    <label style={field}>
      <span style={caption}>Campaign type</span>
      <MultiSelect options={PROGRAMS} value={programs} onChange={setPrograms} />
    </label>
  )
}

/** Expanded: a "Select all" row (indeterminate while the selection is partial) above the options. */
export const OpenWithCheckboxes = () => {
  const [markets, setMarkets] = useState(['de', 'it'])
  return (
    <Opened room={200}>
      <label style={field}>
        <span style={caption}>Marketplace</span>
        <MultiSelect options={MARKETPLACES} value={markets} onChange={setMarkets} placeholder="All marketplaces" />
      </label>
    </Opened>
  )
}

/** The two edges of the label logic: everything selected collapses back to "All"; nothing selected shows `placeholder`. */
export const AllAndEmpty = () => {
  const [everything, setEverything] = useState(STATES.map((s) => s.value))
  const [nothing, setNothing] = useState<string[]>([])
  return (
    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
      <label style={field}>
        <span style={caption}>State — all four</span>
        <MultiSelect options={STATES} value={everything} onChange={setEverything} />
      </label>
      <label style={field}>
        <span style={caption}>Marketplace — unset</span>
        <MultiSelect options={MARKETPLACES} value={nothing} onChange={setNothing} placeholder="All marketplaces" />
      </label>
    </div>
  )
}

/** The filter row above a campaign grid: three multi-selects and the count they resolve to. */
export const FilterRow = () => {
  const [programs, setPrograms] = useState(['sp'])
  const [markets, setMarkets] = useState(['de', 'it', 'fr'])
  const [states, setStates] = useState(['enabled', 'paused'])
  return (
    <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
      <label style={field}>
        <span style={caption}>Campaign type</span>
        <MultiSelect options={PROGRAMS} value={programs} onChange={setPrograms} />
      </label>
      <label style={field}>
        <span style={caption}>Marketplace</span>
        <MultiSelect options={MARKETPLACES} value={markets} onChange={setMarkets} placeholder="All marketplaces" />
      </label>
      <label style={field}>
        <span style={caption}>State</span>
        <MultiSelect options={STATES} value={states} onChange={setStates} />
      </label>
      <span style={{ fontSize: 12.5, color: 'var(--text-tertiary)', paddingBottom: 8 }}>41 campaigns match</span>
    </div>
  )
}
