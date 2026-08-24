import { useState } from 'react'
import { ColumnCustomizer, type CustomizableColumn } from '@nexus/design-system'

const CAMPAIGN_COLUMNS: CustomizableColumn[] = [
  { key: 'campaign', label: 'Campaign', visible: true, locked: true },
  { key: 'status', label: 'Status', visible: true },
  { key: 'budget', label: 'Daily budget', visible: true },
  { key: 'spend', label: 'Spend', visible: true },
  { key: 'sales', label: 'Ad sales', visible: true },
  { key: 'acos', label: 'ACoS', visible: false },
]

const ORDER_COLUMNS: CustomizableColumn[] = [
  { key: 'order', label: 'Order', visible: true, locked: true },
  { key: 'placed', label: 'Placed', visible: true },
  { key: 'channel', label: 'Channel', visible: true },
  { key: 'fulfilment', label: 'Fulfilment', visible: false },
  { key: 'total', label: 'Order total', visible: true },
  { key: 'buyer', label: 'Buyer', visible: false },
  { key: 'tracking', label: 'Tracking', visible: false },
]

/** The Customize-columns modal, open: a locked leading column, up/down reorder, a checkbox per column. */
export const CustomizeColumns = () => {
  const [cols, setCols] = useState(CAMPAIGN_COLUMNS)
  return <ColumnCustomizer open onClose={() => {}} columns={cols} onApply={setCols} />
}

/** Hidden columns keep their place in the list — unchecking never loses the column, only the view. */
export const WithHiddenColumns = () => {
  const [cols, setCols] = useState(ORDER_COLUMNS)
  return <ColumnCustomizer open onClose={() => {}} columns={cols} onApply={setCols} />
}
