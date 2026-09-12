'use client'

import { useEffect, useState } from 'react'
import { Checkbox } from '../primitives/Checkbox'
import { Tabs } from '../components/Tabs'
import { DetailHeader } from '../patterns/DetailHeader'
import { WorkspaceSubheader, type WorkspaceSubheaderProps } from '../patterns/WorkspaceSubheader'

const sampleViews = ['Sheet', 'Images', 'Analytics & Ads', 'Activity', 'Errors & Sync']

/** Local specimen destinations: selection changes only this example, never catalog data. */
export function WorkspaceSubheaderExample() {
  const [selected, setSelected] = useState('Sheet')
  const [stress, setStress] = useState(false)
  const [chrome, setChrome] = useState<WorkspaceSubheaderProps['chrome']>()
  useEffect(() => setChrome({
    header: document.querySelector('.nds-topbar'),
    primaryNavigation: document.querySelector('.h10-rail'),
  }), [])
  const item = (label: string) => ({ id: label, label, href: '#workspace-subheader-example', active: label === selected })
  const views = sampleViews.map(item)
  return <div id="workspace-subheader-example">
    <p>Open the navigation or the menu beside the title. The content below keeps its full width.</p>
    <Checkbox label="Include long labels and 32 sample collections" checked={stress} onChange={event => setStress(event.target.checked)} />
    <div style={{ marginTop: 'var(--nds-space-12)', border: '1px solid var(--nds-border)' }}>
      <WorkspaceSubheader
        header={titleMenu => <DetailHeader dense title={selected} titleMenu={titleMenu} />}
        tabs={<Tabs ariaLabel="Example product views" tabs={views} active={selected} onChange={setSelected} />}
        navigationLabel="Example workspace navigation"
        chrome={chrome}
        groups={[
          { id: 'views', label: 'Product views', items: views },
          { id: 'collections', label: 'Sample collections', collapsible: true, items: stress ? Array.from({ length: 32 }, (_, index) => ({
            ...item(`Waterproof motorcycle jackets — international catalogue collection ${index + 1}`), badge: index === 0 ? 12 : undefined,
          })) : [] },
        ]}
        views={{ label: 'Switch example view', selectedId: selected, items: views }}
        onNavigate={(event, destination) => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
          event.preventDefault()
          setSelected(destination.id)
        }}
      />
      <div data-example-content style={{ padding: 'var(--nds-space-16)', background: 'var(--nds-surface)' }}>
        <strong>{selected}</strong>
        <p>This content is a sibling of the complete subheader. No navigation column is reserved here.</p>
      </div>
    </div>
  </div>
}
