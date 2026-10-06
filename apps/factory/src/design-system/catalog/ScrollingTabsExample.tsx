'use client'
import { useId, useState } from 'react'
import { Tabs, tabPanelProps } from '../components/Tabs'
/**
 * Narrow-host specimen: touch scrolling and Arrow/Home/End navigation keep labels reachable. While a strip scrolls it
 * is marked `data-overflows` (`useHorizontalOverflow`) and keeps its scrollbar in a band BELOW the tabs — scroll either
 * strip with a trackpad: the bar never covers a label, the active underline or a focus ring. A strip that fits (the
 * second `sm` one) carries no mark and no band.
 */
export function ScrollingTabsExample() {
  const id = useId(), [active, setActive] = useState('categories'), [market, setMarket] = useState('it')
  return <div id="scrolling-tabs-example" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--nds-space-12)', maxWidth: 320 }}>
    <div>
      <Tabs overflow="scroll" idBase={id} ariaLabel="Scrolling category sections" tabs={[{ id: 'categories', label: 'Our categories' }, { id: 'assignments', label: 'Channel assignments' }, { id: 'updates', label: 'Taxonomy updates' }]} active={active} onChange={setActive} />
      <div {...tabPanelProps(id, active)} style={{ padding: 'var(--nds-space-12)' }}>Selected section: {active}</div>
    </div>
    <Tabs size="sm" overflow="scroll" ariaLabel="Chosen markets, scrolling" active={market} onChange={setMarket}
      tabs={[{ id: 'de', label: 'Amazon DE · 3 changes' }, { id: 'it', label: 'Amazon IT · ready' }, { id: 'fr', label: 'Amazon FR · checking…' }]} />
    <Tabs size="sm" overflow="scroll" ariaLabel="Chosen markets, fitting" active={market} onChange={setMarket}
      tabs={[{ id: 'de', label: 'DE' }, { id: 'it', label: 'IT' }]} />
  </div>
}
