'use client'
import { useId, useState } from 'react'
import { Tabs, tabPanelProps } from '../components/Tabs'
/** Narrow-host specimen: touch scrolling and Arrow/Home/End navigation keep labels reachable. */
export function ScrollingTabsExample() {
  const id = useId(), [active, setActive] = useState('categories')
  return <div style={{ maxWidth: 320 }}>
    <Tabs overflow="scroll" idBase={id} ariaLabel="Scrolling category sections" tabs={[{ id: 'categories', label: 'Our categories' }, { id: 'assignments', label: 'Channel assignments' }, { id: 'updates', label: 'Taxonomy updates' }]} active={active} onChange={setActive} />
    <div {...tabPanelProps(id, active)} style={{ padding: 'var(--nds-space-12)' }}>Selected section: {active}</div>
  </div>
}
