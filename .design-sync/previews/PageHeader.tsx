import { useState } from 'react'
import { Button, PageHeader, SegmentedControl, Select } from '@nexus/design-system'

/** The canonical list-page header: eyebrow · title · subtitle, with the page's actions right. */
export const ListPage = () => (
  <PageHeader
    eyebrow="Advertising"
    title="Ad Manager"
    subtitle="212 active campaigns across 4 marketplaces · synced 6 minutes ago"
    actions={
      <>
        <Select defaultValue="7d" aria-label="Date range">
          <option value="7d">Last 7 days</option>
          <option value="14d">Last 14 days</option>
          <option value="30d">Last 30 days</option>
        </Select>
        <Button>Export CSV</Button>
        <Button variant="primary">New campaign</Button>
      </>
    }
  />
)

/** The actions slot takes any control — here a view switcher beside the buttons. */
export const WithViewSwitcher = () => {
  const [lens, setLens] = useState('grid')
  return (
    <PageHeader
      eyebrow="Catalogue"
      title="Products"
      subtitle="1,284 SKUs · 38 missing a main image"
      actions={
        <>
          <SegmentedControl
            size="sm"
            value={lens}
            onChange={setLens}
            options={[
              { value: 'grid', label: 'Grid' },
              { value: 'board', label: 'Board' },
            ]}
          />
          <Button>Customise</Button>
          <Button variant="primary">Import</Button>
        </>
      }
    />
  )
}

/** Every slot but `title` is optional — the quiet form for a sub-page. */
export const TitleAndSubtitle = () => (
  <PageHeader title="Purchase orders" subtitle="6 open · €18,940 committed to suppliers" />
)
