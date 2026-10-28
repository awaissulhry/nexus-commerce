'use client'

import { useCallback, useEffect, useState } from 'react'
import type { IHeaderParams, IRowNode } from 'ag-grid-community'
import { Checkbox } from '../../primitives/Checkbox'

/** Select explicit loaded rows. Server-side select-all rules otherwise include future rows. */
export function LoadedRowsSelectionHeader({ api }: IHeaderParams) {
  const nodes = useCallback(() => {
    const rows: IRowNode[] = []
    api.forEachNode(node => { if (node.data && node.selectable && node.displayed && !node.rowPinned) rows.push(node) })
    return rows
  }, [api])
  const [state, setState] = useState({ all: false, some: false, empty: true })
  const refresh = useCallback(() => {
    if (api.isDestroyed()) return
    const rows = nodes(), selected = rows.filter(node => node.isSelected()).length
    setState({ all: rows.length > 0 && selected === rows.length, some: selected > 0 && selected < rows.length, empty: rows.length === 0 })
  }, [api, nodes])
  useEffect(() => {
    refresh()
    api.addEventListener('selectionChanged', refresh)
    api.addEventListener('modelUpdated', refresh)
    return () => {
      if (api.isDestroyed()) return
      api.removeEventListener('selectionChanged', refresh)
      api.removeEventListener('modelUpdated', refresh)
    }
  }, [api, refresh])
  return <Checkbox aria-label="Select loaded rows" checked={state.all} disabled={state.empty}
    ref={element => { if (element) element.indeterminate = state.some }}
    onClick={event => event.stopPropagation()}
    onKeyDown={event => { if (event.key === ' ') event.stopPropagation() }}
    onChange={event => api.setNodesSelected({ nodes: nodes(), newValue: event.target.checked })} />
}
