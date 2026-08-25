import { useState } from 'react'
import { PreferencesModal, Toggle, type PreferencesColumnSpec, type PreferencesValue } from '@nexus/design-system'

const CAMPAIGN_COLUMNS: PreferencesColumnSpec[] = [
  { key: 'campaign', label: 'Campaign', locked: true },
  { key: 'status', label: 'Status' },
  { key: 'budget', label: 'Daily budget' },
  { key: 'spend', label: 'Spend' },
  { key: 'sales', label: 'Ad sales' },
  { key: 'acos', label: 'ACoS' },
  { key: 'roas', label: 'ROAS' },
  { key: 'orders', label: 'Orders' },
  { key: 'cpc', label: 'CPC' },
  { key: 'actions', label: 'Actions', locked: true },
]

const PRODUCT_COLUMNS: PreferencesColumnSpec[] = [
  { key: 'product', label: 'Product', locked: true },
  { key: 'channels', label: 'Channels' },
  { key: 'status', label: 'Status' },
  { key: 'available', label: 'Available' },
  { key: 'price', label: 'Price' },
  { key: 'margin', label: 'Margin' },
  { key: 'actions', label: 'Actions', locked: true },
]

/**
 * The full two-panel Customise dialog: rows-per-page, sticky columns and sort on the left,
 * the whole column registry — visible first, then hidden, locked ones pinned — on the right.
 */
export const CustomiseColumns = () => {
  const [value, setValue] = useState<PreferencesValue>({
    visibleColumns: ['status', 'budget', 'spend', 'sales', 'acos'],
    stickyFirstColumn: true,
    stickyLastColumn: true,
    pageSize: 100,
    sortBy: 'spend',
    sortDir: 'desc',
  })
  return (
    <PreferencesModal
      open
      onClose={() => {}}
      value={value}
      onConfirm={setValue}
      allColumns={CAMPAIGN_COLUMNS}
      defaultVisible={['status', 'budget', 'spend', 'sales', 'acos']}
      sortFieldOptions={[
        { value: 'spend', label: 'Spend' },
        { value: 'sales', label: 'Ad sales' },
        { value: 'acos', label: 'ACoS' },
      ]}
    />
  )
}

/**
 * The live /products composition: an empty `pageSizeChoices` and `showSticky={false}` collapse
 * their sections, so the left panel carries sort alone.
 */
export const SortOnly = () => {
  const [value, setValue] = useState<PreferencesValue>({
    visibleColumns: ['channels', 'status', 'available', 'price'],
    stickyFirstColumn: false,
    stickyLastColumn: false,
    pageSize: 50,
    sortBy: 'available',
    sortDir: 'asc',
  })
  return (
    <PreferencesModal
      open
      onClose={() => {}}
      title="Customise the products grid"
      value={value}
      onConfirm={setValue}
      allColumns={PRODUCT_COLUMNS}
      defaultVisible={['channels', 'status', 'available', 'price']}
      sortFieldOptions={[
        { value: 'product', label: 'Product name' },
        { value: 'available', label: 'Available stock' },
        { value: 'price', label: 'Price' },
      ]}
      pageSizeChoices={[]}
      showSticky={false}
    />
  )
}

/** `workspaceSlot` is the escape hatch for preferences only one workspace has. */
export const WithWorkspaceSlot = () => {
  const [value, setValue] = useState<PreferencesValue>({
    visibleColumns: ['channels', 'status', 'available', 'price', 'margin'],
    stickyFirstColumn: true,
    stickyLastColumn: false,
    pageSize: 50,
    sortBy: 'price',
    sortDir: 'desc',
  })
  const [archived, setArchived] = useState(false)
  const [zeroStock, setZeroStock] = useState(true)
  return (
    <PreferencesModal
      open
      onClose={() => {}}
      value={value}
      onConfirm={setValue}
      allColumns={PRODUCT_COLUMNS}
      defaultVisible={['channels', 'status', 'available', 'price']}
      sortFieldOptions={[
        { value: 'price', label: 'Price' },
        { value: 'available', label: 'Available stock' },
      ]}
      pageSizeChoices={[25, 50, 100]}
      workspaceSlot={
        <fieldset className="nds-prefs-set">
          <legend>Catalogue</legend>
          <p className="nds-prefs-help">Rows these preferences add to or remove from the grid.</p>
          <label className="nds-prefs-check">
            <Toggle checked={archived} onChange={setArchived} aria-label="Show archived SKUs" />
            <span>Show archived SKUs</span>
          </label>
          <label className="nds-prefs-check">
            <Toggle checked={zeroStock} onChange={setZeroStock} aria-label="Show out-of-stock" />
            <span>Show out-of-stock</span>
          </label>
        </fieldset>
      }
    />
  )
}
