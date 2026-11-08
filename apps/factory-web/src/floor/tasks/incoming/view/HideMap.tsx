'use client'

import { useRef, type KeyboardEvent, type MouseEvent } from 'react'
import { Info, Minus, Plus, Trash2, Undo2 } from 'lucide-react'
import { DetailPopover } from '@nexus/ui/components'
import { FloorButton, type FloorTone } from '@nexus/ui/floor'
import { Kbd } from '@nexus/ui/primitives'
import { viewBoxOf, ZOOMS, type MapTool } from '../model'
import '../incoming.css'

/**
 * HideMap (design part, floor only; plan B-W2b-115: "HideMap stays in this folder"): the hide's outline with its defect marks
 * and its grade zones A, B, C; + / − zoom buttons, no pinch and no drag (MES-054). A tap places the defect picked, or adds a
 * point to the zone being drawn; "Close the zone" closes it (three points or more). The keyboard moves a cross with the arrows
 * and places with Enter or Space; + and − zoom; Backspace takes back the last mark. The view follows the cross when zoomed in.
 * Every mark is also a row of words below the map (what it is, where), with its own Remove button: the drawing is never the
 * only way to read it. Composed of DS parts (FloorButton, DetailPopover, Kbd) and an SVG; layout-only CSS. Every
 * word comes from the screen.
 */

export interface MapMark {
  readonly kind: 'DEFECT' | 'ZONE'
  readonly x: number
  readonly y: number
  readonly outline: readonly { readonly x: number; readonly y: number }[]
  /** What the row and the drawing say: the defect's words, or "Zone B". */
  readonly label: string
  /** The short mark drawn on the map: the mark's number, or the zone's grade. */
  readonly short: string
  readonly tone: FloorTone
  /** The defect's class in words, or the grade's usable share. */
  readonly detail: string | null
}

export interface HideMapWords {
  readonly title: string
  /** What a tap does now, or why it places nothing (said once, politely). */
  readonly status: string
  readonly zoomIn: string
  readonly zoomOut: string
  readonly zoomTop: string
  readonly zoomBottom: string
  readonly zoom: (percent: number) => string
  readonly undo: string
  readonly nothingToUndo: string
  readonly remove: (label: string) => string
  readonly removeShort: string
  readonly marks: string
  readonly noMarks: string
  readonly where: (across: number, down: number) => string
  readonly keysTitle: string
  readonly keysTrigger: string
  readonly keys: readonly { readonly key: string; readonly does: string }[]
}

/** A stylised hide in the 1000 × 700 drawing (the outline a tap lies on; any point of the drawing may be marked). */
export const HIDE_OUTLINE =
  'M160 120C230 60 360 90 420 60C470 35 530 35 580 60C640 90 770 60 840 120C900 170 950 230 930 330C915 400 960 470 920 540C880 610 760 600 700 640C640 675 560 660 500 680C440 660 360 675 300 640C240 600 120 610 80 540C40 470 85 400 70 330C50 230 100 170 160 120Z'

export function HideMap({
  marks,
  tool,
  zoom,
  cross,
  heldReason,
  words,
  onTap,
  onCross,
  onZoom,
  onRemove,
  onUndo,
}: {
  marks: readonly MapMark[]
  tool: MapTool
  /** Index into ZOOMS. */
  zoom: number
  cross: { readonly x: number; readonly y: number }
  /** Set: a tap places nothing (the words say why). */
  heldReason: string | null
  words: HideMapWords
  onTap: (x: number, y: number) => void
  onCross: (x: number, y: number) => void
  onZoom: (delta: 1 | -1) => void
  onRemove: (index: number) => void
  onUndo: () => void
}) {
  const svg = useRef<SVGSVGElement | null>(null)
  const scale = ZOOMS[Math.min(Math.max(0, zoom), ZOOMS.length - 1)] ?? 1
  const box = viewBoxOf(scale, cross)
  const unit = 1 / scale

  const pointOf = (event: MouseEvent<SVGSVGElement>): { x: number; y: number } | null => {
    const element = svg.current
    const matrix = element?.getScreenCTM()
    if (!element || !matrix) return null
    const point = element.createSVGPoint()
    point.x = event.clientX
    point.y = event.clientY
    const at = point.matrixTransform(matrix.inverse())
    return { x: at.x / 1000, y: at.y / 700 }
  }

  const onClick = (event: MouseEvent<SVGSVGElement>) => {
    const at = pointOf(event)
    if (!at) return
    onCross(at.x, at.y)
    onTap(at.x, at.y)
  }

  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const step: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
    const move = step[event.key]
    if (move) {
      event.preventDefault()
      const d = 1 / (50 * scale)
      return onCross(Math.min(1, Math.max(0, cross.x + move[0] * d)), Math.min(1, Math.max(0, cross.y + move[1] * d)))
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      return onTap(cross.x, cross.y)
    }
    if (event.key === '+' || event.key === '=') {
      event.preventDefault()
      return onZoom(1)
    }
    if (event.key === '-') {
      event.preventDefault()
      return onZoom(-1)
    }
    if (event.key === 'Backspace') {
      event.preventDefault()
      onUndo()
    }
  }

  const drawing = tool.kind === 'zone' ? tool.points : []
  return (
    <section className="fw-ii-map" aria-label={words.title}>
      <div className="fw-ii-map-tools">
        <FloorButton variant="secondary" icon={<Minus />} heldReason={zoom <= 0 ? words.zoomBottom : null} onClick={() => onZoom(-1)}>
          {words.zoomOut}
        </FloorButton>
        <span className="fw-ii-map-zoom" aria-live="polite">
          {words.zoom(Math.round(scale * 100))}
        </span>
        <FloorButton variant="secondary" icon={<Plus />} heldReason={zoom >= ZOOMS.length - 1 ? words.zoomTop : null} onClick={() => onZoom(1)}>
          {words.zoomIn}
        </FloorButton>
      </div>
      <div className="fw-ii-map-frame" role="group" tabIndex={0} aria-label={words.title} aria-describedby="fw-ii-map-status" onKeyDown={onKey} data-held={heldReason ? 'true' : 'false'}>
        <svg ref={svg} className="fw-ii-map-svg" viewBox={`${box.x} ${box.y} ${box.width} ${box.height}`} preserveAspectRatio="xMidYMid meet" onClick={onClick} aria-hidden="true">
          <path className="fw-ii-hide" d={HIDE_OUTLINE} />
          {marks.map((mark, index) =>
            mark.kind === 'ZONE' ? (
              <g key={`z${index}`} className="fw-ii-zone" data-tone={mark.tone}>
                <polygon points={mark.outline.map((point) => `${point.x * 1000},${point.y * 700}`).join(' ')} />
                <text x={mark.x * 1000} y={mark.y * 700} fontSize={48 * unit} textAnchor="middle" dominantBaseline="central">
                  {mark.short}
                </text>
              </g>
            ) : null,
          )}
          {marks.map((mark, index) =>
            mark.kind === 'DEFECT' ? (
              <g key={`d${index}`} className="fw-ii-defect" data-tone={mark.tone}>
                <circle cx={mark.x * 1000} cy={mark.y * 700} r={34 * unit} />
                <text x={mark.x * 1000} y={mark.y * 700} fontSize={34 * unit} textAnchor="middle" dominantBaseline="central">
                  {mark.short}
                </text>
              </g>
            ) : null,
          )}
          {drawing.length > 0 ? (
            <g className="fw-ii-drawing">
              <polyline points={drawing.map((point) => `${point.x * 1000},${point.y * 700}`).join(' ')} />
              {drawing.map((point, index) => (
                <circle key={index} cx={point.x * 1000} cy={point.y * 700} r={12 * unit} />
              ))}
            </g>
          ) : null}
          <g className="fw-ii-cross">
            <line x1={cross.x * 1000 - 30 * unit} y1={cross.y * 700} x2={cross.x * 1000 + 30 * unit} y2={cross.y * 700} />
            <line x1={cross.x * 1000} y1={cross.y * 700 - 30 * unit} x2={cross.x * 1000} y2={cross.y * 700 + 30 * unit} />
          </g>
        </svg>
      </div>
      <div className="fw-ii-map-foot">
        <p id="fw-ii-map-status" className="fw-floor-muted" role="status">
          {heldReason ?? words.status}
        </p>
        <FloorButton variant="secondary" icon={<Undo2 />} heldReason={marks.length === 0 && drawing.length === 0 ? words.nothingToUndo : null} onClick={onUndo}>
          {words.undo}
        </FloorButton>
        <DetailPopover trigger={<Info aria-hidden />} triggerLabel={words.keysTrigger} triggerClassName="fw-task-keys-trigger" label={words.keysTitle} hoverDelay={150}>
          <div className="fw-task-keys">
            <p className="fw-floor-subtitle">{words.keysTitle}</p>
            <dl className="fw-task-keymap">
              {words.keys.map((entry) => (
                <div key={entry.key} className="fw-task-keymap-row">
                  <dt>
                    <Kbd>{entry.key}</Kbd>
                  </dt>
                  <dd>{entry.does}</dd>
                </div>
              ))}
            </dl>
          </div>
        </DetailPopover>
      </div>
      {marks.length === 0 ? (
        <p className="fw-floor-muted">{words.noMarks}</p>
      ) : (
        <ul className="fw-ii-marks" aria-label={words.marks}>
          {marks.map((mark, index) => (
            <li key={index} className="fw-ii-mark" data-tone={mark.tone}>
              <span className="fw-ii-mark-badge" data-tone={mark.tone} aria-hidden="true">
                {mark.short}
              </span>
              <span className="fw-ii-mark-text">
                <span className="fw-ii-mark-label">{mark.label}</span>
                <span className="fw-floor-muted">{[mark.detail, words.where(Math.round(mark.x * 100), Math.round(mark.y * 100))].filter(Boolean).join(' · ')}</span>
              </span>
              <FloorButton variant="quiet" icon={<Trash2 />} aria-label={words.remove(mark.label)} onClick={() => onRemove(index)}>
                {words.removeShort}
              </FloorButton>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
