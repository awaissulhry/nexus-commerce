'use client'

/**
 * GDS — the grid's loading and empty overlays, as AG overlay components.
 *
 *   loadingOverlayComponent={GridLoadingOverlay}
 *   noRowsOverlayComponent={GridNoRowsOverlay}
 *   noRowsOverlayComponentParams={{ title, message, action }}
 *
 * The skeleton draws rows at the CURRENT density (it reads the same context the grid does), so a
 * loading Spacious grid is the height of a loaded one and nothing jumps when the data lands.
 */
import { memo, type ReactNode } from 'react'

import { Button } from '../../primitives'
import { gridDensity } from '../../tokens/grid'
import { useGridDensity } from '../hooks/useGridDensity'

export interface GridLoadingOverlayParams {
  /** Skeleton rows to draw (default 6). */
  rows?: number
  /** Draw a thumbnail block in the first cell (media rows). */
  media?: boolean
}

export const GridLoadingOverlay = memo(function GridLoadingOverlay({ rows = 6, media = false }: GridLoadingOverlayParams) {
  const density = useGridDensity()
  const tier = gridDensity[density]
  const rowH = media ? tier.rowMedia : tier.rowText
  return (
    <div className="nds-grid-skel" role="status" aria-live="polite" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="nds-grid-skel-row" style={{ height: rowH }}>
          {media && <span className="nds-grid-skel-thumb" style={{ width: tier.thumb, height: tier.thumb }} />}
          <span className="nds-grid-skel-text">
            <span className="nds-grid-skel-line" style={{ width: `${44 + ((i * 17) % 30)}%` }} />
            {media && <span className="nds-grid-skel-line nds-grid-skel-line-sub" style={{ width: `${20 + ((i * 11) % 18)}%` }} />}
          </span>
        </div>
      ))}
    </div>
  )
})

export interface GridNoRowsOverlayParams {
  title?: ReactNode
  message?: ReactNode
  /** A call to action — `{ label, onClick }` or your own node. */
  action?: { label: ReactNode; onClick: () => void } | ReactNode
}

const isAction = (a: GridNoRowsOverlayParams['action']): a is { label: ReactNode; onClick: () => void } =>
  !!a && typeof a === 'object' && 'onClick' in (a as object)

export const GridNoRowsOverlay = memo(function GridNoRowsOverlay({ title = 'Nothing here', message, action }: GridNoRowsOverlayParams) {
  return (
    <div className="nds-ag-empty nds-grid-noRows" role="status">
      <div className="nds-grid-noRows-title">{title}</div>
      {message && <div className="nds-grid-noRows-msg">{message}</div>}
      {isAction(action) ? (
        <Button size="sm" variant="secondary" onClick={action.onClick}>
          {action.label}
        </Button>
      ) : (
        action
      )}
    </div>
  )
})
