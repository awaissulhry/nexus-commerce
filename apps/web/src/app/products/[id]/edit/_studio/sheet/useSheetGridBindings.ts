import { useCallback, useRef, type MutableRefObject } from 'react'
import type { GridApi, GridReadyEvent } from '@/design-system/grid'
import type { SheetColumnsApi } from './useSheetColumns'

/** Persist the departing grid before releasing it; never clear a replacement grid. */
export function useSheetGridBindings<Row, Page>(options: {
  apiRef: MutableRefObject<GridApi<Row> | null>
  sheetColumns: SheetColumnsApi<Page>
  bindGridApi: (api: GridApi<Row>) => void
  releaseGrid: (event: { api: GridApi<Row> }) => void
  bindWriter?: (api: GridApi<Row> | null) => void
  clearRows: () => void
}) {
  const live = useRef(options)
  live.current = options
  const onGridReady = useCallback((event: GridReadyEvent<Row>) => {
    const opts = live.current
    opts.bindGridApi(event.api)
    opts.bindWriter?.(event.api)
    opts.sheetColumns.gridState.bind(event.api)
  }, [])
  const onGridPreDestroyed = useCallback((event: { api: GridApi<Row> }) => {
    const opts = live.current
    if (opts.apiRef.current === event.api) {
      opts.sheetColumns.captureGridState()
      opts.sheetColumns.gridState.persist()
      opts.bindWriter?.(null)
      opts.clearRows()
    }
    opts.releaseGrid(event)
  }, [])
  return { onGridReady, onGridPreDestroyed }
}
