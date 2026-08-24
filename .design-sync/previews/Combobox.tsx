import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Combobox } from '@nexus/design-system'

/**
 * Preview harness — NOT part of the component API.
 *
 * Combobox owns `open` and `query` internally and exposes no prop for either,
 * so both are driven here the way an operator drives them: focus the field to
 * open it, then type. `query` is set through the native value setter plus a
 * bubbling `input` event, which is exactly the signal a keystroke produces —
 * React's own `onChange` runs and the component filters itself. Nothing about
 * the popover is hand-written. `room` reserves layout height so the
 * absolutely-positioned popover is not clipped by the card cell.
 */
const Driven = ({ type, room, children }: { type?: string; room: number; children: ReactNode }) => {
  const host = useRef<HTMLDivElement>(null)
  const fired = useRef(false)
  useEffect(() => {
    if (fired.current) return
    fired.current = true
    const input = host.current?.querySelector('input')
    if (!input) return
    input.focus()
    if (type == null) return
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setValue?.call(input, type)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }, [type])
  return (
    <div ref={host} style={{ paddingBottom: room }}>
      {children}
    </div>
  )
}

const MARKETPLACES = [
  { value: 'de', label: 'Amazon Germany' },
  { value: 'it', label: 'Amazon Italy' },
  { value: 'fr', label: 'Amazon France' },
  { value: 'es', label: 'Amazon Spain' },
  { value: 'nl', label: 'Amazon Netherlands' },
  { value: 'ebay-de', label: 'eBay Germany' },
  { value: 'shopify', label: 'Shopify — Xavia Store' },
]

const CAMPAIGNS = [
  { value: 'c1', label: 'Helmets · Auto' },
  { value: 'c2', label: 'Brand Defense' },
  { value: 'c3', label: 'Gloves · Exact' },
  { value: 'c4', label: 'Retargeting · Views' },
  { value: 'c5', label: 'Helmets · Broad Discovery' },
]

const field: React.CSSProperties = { display: 'grid', gap: 6, width: 280 }
const caption: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }

/** Resting, with a value picked: the field shows the chosen option's label and the chevron. */
export const MarketplacePicker = () => {
  const [marketplace, setMarketplace] = useState('de')
  return (
    <label style={field}>
      <span style={caption}>Marketplace</span>
      <Combobox
        options={MARKETPLACES}
        value={marketplace}
        onChange={setMarketplace}
        placeholder="Search marketplace…"
      />
    </label>
  )
}

/** Focus opens the popover on the full list; the current value is marked `on` (wash + primary, 600). */
export const OpenList = () => {
  const [marketplace, setMarketplace] = useState('it')
  return (
    <Driven room={230}>
      <label style={field}>
        <span style={caption}>Marketplace</span>
        <Combobox
          options={MARKETPLACES}
          value={marketplace}
          onChange={setMarketplace}
          placeholder="Search marketplace…"
        />
      </label>
    </Driven>
  )
}

/** The point of the component: typing filters the list. "helm" narrows five campaigns to two. */
export const Typeahead = () => {
  const [campaign, setCampaign] = useState('')
  return (
    <Driven type="helm" room={150}>
      <label style={field}>
        <span style={caption}>Copy settings from campaign</span>
        <Combobox options={CAMPAIGNS} value={campaign} onChange={setCampaign} placeholder="Search campaigns…" />
      </label>
    </Driven>
  )
}

/** A query that matches nothing falls to the DS's own empty line rather than an empty box. */
export const NoMatches = () => {
  const [marketplace, setMarketplace] = useState('')
  return (
    <Driven type="Amazon Poland" room={110}>
      <label style={field}>
        <span style={caption}>Marketplace</span>
        <Combobox
          options={MARKETPLACES}
          value={marketplace}
          onChange={setMarketplace}
          placeholder="Search marketplace…"
        />
      </label>
    </Driven>
  )
}
