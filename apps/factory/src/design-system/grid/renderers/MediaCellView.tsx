'use client'

/**
 * GDS / PES.2 — `MediaCell`: an AG cell whose content is a PICTURE.
 *
 * Built to PES.7's three spike conditions (hub ruling #12), and each one shows up in the code:
 *
 *   1. **The picture comes from the cell VALUE** (`p.value`), so AG's change detection sees it and
 *      repaints on its own. A renderer drawing from `cellRendererParams` is invisible to AG, and
 *      the "fix" of churning that params object re-runs the whole column model.
 *   2. **Handlers come from CONTEXT** (`MediaCellHandlers`), never from rebuilt params. The host
 *      mounts one provider around its grid; the identity of `cellRendererParams` never changes.
 *   3. **`cellSelection` is off on a media matrix** — see `MEDIA_MATRIX_GRID_OPTIONS`. AG opens a
 *      range on the same mousedown that starts a tile drag, and `stopPropagation` does not stop it.
 *
 * And one trap from the same ruling that dictates the markup: **`position: absolute` inside an AG
 * cell ESCAPES the cell.** So the badge, the count and the publish mark are normal flex children,
 * not overlays. Nothing here is absolutely positioned.
 *
 * Sizing goes through `cdnFit` (ruling #28). A bare original in a 165px tile measured 1.6MB against
 * 18KB sized — and a matrix multiplies that by rows × columns.
 */
import { createContext, memo, useContext, type PointerEvent as ReactPointerEvent, type DragEvent as ReactDragEvent } from 'react'
import { Image as ImageIcon, Lock, AlertTriangle } from 'lucide-react'

import type { ICellRendererParams } from 'ag-grid-community'

import { cdnFit } from '../../lib/cdn-image'
import { provenanceTooltip } from './provenance'
import { ProvenanceMark } from './provenanceMark'
import { mediaCellAcceptsDrop, mediaCellClasses, mediaCellState, mediaCellTitle, mediaRenditionWidth, type MediaCellValue } from './mediaCell'

/**
 * What a media matrix does with its tiles. Supplied ONCE by the host through a provider, so the
 * cell renderer's params never change identity.
 *
 * Every handler is optional: a read-only matrix passes none and the tiles are inert, which is the
 * honest rendering of a surface that cannot be edited.
 */
export interface MediaCellHandlers {
  /** Pointer-drag is the PRIMARY model (ruling #12). The host owns the drag session. */
  onTilePointerDown?: (rowId: string, colId: string, e: ReactPointerEvent<HTMLElement>) => void
  /** HTML5 is kept for desktop FILE drops only, not for tile-to-tile movement. */
  onFileDrop?: (rowId: string, colId: string, files: FileList) => void
  onOpen?: (rowId: string, colId: string) => void
  /** Tile box in px. Stable — it is layout, not a handler, and it decides the rendition asked for. */
  size?: number
}

const HandlersCtx = createContext<MediaCellHandlers>({})

export function MediaCellProvider({ value, children }: { value: MediaCellHandlers; children: React.ReactNode }) {
  return <HandlersCtx.Provider value={value}>{children}</HandlersCtx.Provider>
}

const DEFAULT_SIZE = 96

export const MediaCell = memo(function MediaCell(p: ICellRendererParams) {
  const handlers = useContext(HandlersCtx)
  const value = (p.value ?? null) as MediaCellValue | null
  const rowId = String(p.node?.id ?? '')
  const colId = p.colDef?.colId ?? p.colDef?.field ?? ''
  const size = handlers.size ?? DEFAULT_SIZE
  const state = mediaCellState(value)
  const accepts = mediaCellAcceptsDrop(value) && !!handlers.onFileDrop
  const title = mediaCellTitle(value, value?.provenance ? provenanceTooltip(value.provenance, value.inheritedFrom) : undefined)

  const onDrop = (e: ReactDragEvent<HTMLDivElement>) => {
    if (!accepts) return
    e.preventDefault()
    if (e.dataTransfer?.files?.length) handlers.onFileDrop?.(rowId, colId, e.dataTransfer.files)
  }

  return (
    <div
      className={mediaCellClasses(value).join(' ')}
      style={{ ['--nds-media-size' as string]: `${size}px` }}
      title={title || undefined}
      onPointerDown={(e) => handlers.onTilePointerDown?.(rowId, colId, e)}
      onDoubleClick={() => handlers.onOpen?.(rowId, colId)}
      onDragOver={accepts ? (e) => e.preventDefault() : undefined}
      onDrop={accepts ? onDrop : undefined}
      data-media-state={state}
    >
      {value?.src ? (
        // eslint-disable-next-line @next/next/no-img-element -- an AG cell is not a Next layout box
        <img className="nds-media-img" src={cdnFit(value.src, mediaRenditionWidth(size))} alt={value.alt ?? ''} draggable={false} loading="lazy" />
      ) : (
        <span className="nds-media-empty" aria-hidden>
          <ImageIcon size={Math.max(12, Math.round(size / 6))} />
        </span>
      )}

      {/* Marks. Normal flex children on purpose — an absolutely positioned child ESCAPES an AG
          cell (ruling #12), so overlays are laid out, never floated. */}
      <span className="nds-media-marks">
        {value?.provenance && value.provenance !== 'own' && <ProvenanceMark provenance={value.provenance} from={value.inheritedFrom} />}
        {value?.locked && <Lock size={11} aria-hidden />}
        {(state === 'warned' || state === 'refused') && <AlertTriangle size={11} aria-hidden />}
        {typeof value?.count === 'number' && value.count > 1 && <span className="nds-media-count">+{value.count - 1}</span>}
      </span>
    </div>
  )
})

/**
 * Grid options a MEDIA MATRIX must use.
 *
 * 🔴 `cellSelection: false` is not a preference. AG begins a cell range on the same mousedown that
 * starts a tile drag, and `stopPropagation` on the tile does not prevent it — measured in PES.7's
 * spike. A matrix that leaves cell selection on gets a drag that paints a blue range instead of
 * moving a picture.
 *
 * Spread it like `SHEET_GRID_OPTIONS`: one stable object, so the option-identity guard is satisfied.
 */
export const MEDIA_MATRIX_GRID_OPTIONS = {
  cellSelection: false,
  suppressCellFocus: false,
} as const
