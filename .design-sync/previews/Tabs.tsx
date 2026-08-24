import { useState } from 'react'
import { Sparkles } from 'lucide-react'
import { Tabs } from '@nexus/design-system'

const Note = ({ children }: { children: React.ReactNode }) => (
  <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-tertiary)' }}>
    {children}
  </div>
)

/** Default `md` — the in-panel underline bar. Controlled: the parent owns `active`. */
export const Default = () => {
  const [tab, setTab] = useState('overview')
  return (
    <Tabs
      tabs={[
        { id: 'overview', label: 'Overview' },
        { id: 'targeting', label: 'Targeting' },
        { id: 'placements', label: 'Placements' },
        { id: 'history', label: 'History' },
      ]}
      active={tab}
      onChange={setTab}
    />
  )
}

/** `size="lg"` is the PAGE-level bar — bigger bolder labels, a 3px indicator, full-weight count pills. */
export const PageLevel = () => {
  const [view, setView] = useState('bids')
  return (
    <Tabs
      size="lg"
      tabs={[
        { id: 'ai', label: 'A.I. Bids', count: 12, icon: <Sparkles size={15} /> },
        { id: 'bids', label: 'Bids', count: 148 },
        { id: 'new-keywords', label: 'New Keywords', count: 31 },
        { id: 'negatives', label: 'Negative Keywords', count: 7 },
        { id: 'budget', label: 'Budget', count: 0 },
      ]}
      active={view}
      onChange={setView}
    />
  )
}

/** Both sizes on the same tabs — `lg` above, the default `md` below. */
export const Sizes = () => {
  const [a, setA] = useState('suggestions')
  const [b, setB] = useState('suggestions')
  const tabs = [
    { id: 'suggestions', label: 'Suggestions' },
    { id: 'analytics', label: 'Analytics' },
    { id: 'changelog', label: 'Changelog' },
  ]
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <Note>size=&quot;lg&quot;</Note>
        <Tabs size="lg" tabs={tabs} active={a} onChange={setA} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <Note>size=&quot;md&quot; (default)</Note>
        <Tabs tabs={tabs} active={b} onChange={setB} />
      </div>
    </div>
  )
}

/**
 * `count` is deliberately three-valued: a number renders a pill, `0` renders a pill reading 0
 * (a real answer), and `null` renders nothing at all (unknown ≠ zero). `badge` is the promo pill.
 */
export const CountsAndBadges = () => {
  const [tab, setTab] = useState('pending')
  return (
    <Tabs
      size="lg"
      tabs={[
        { id: 'pending', label: 'Pending', count: 148 },
        { id: 'applied', label: 'Applied', count: 0 },
        { id: 'dismissed', label: 'Dismissed', count: null },
        { id: 'autopilot', label: 'Autopilot', badge: 'New' },
      ]}
      active={tab}
      onChange={setTab}
    />
  )
}
