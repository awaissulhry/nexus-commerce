'use client'

/**
 * GarmentZoneMap — where on the garment (B-W2b-207, design part GarmentZoneMap; moved from the factory's quality area,
 * `areas/quality/defects/zones`, where B-W2a-67 built it): the rider jacket's front and back and the trousers' front,
 * each zone a pressable region named by its words (aria-pressed), the picked zone marked by more than colour — a thick
 * outline, a pin and its words under the map — and the zones with no place on the sketch (the lining) as chips.
 *
 *   <GarmentZoneMap zones={zonesInMyLanguage} value={zone} onChange={setZone} label="Where on the garment" labels={ds.garmentZoneMap} />
 *
 * - Keyboard: ONE Tab stop on the sketch, the arrows walk every zone (sketch and chips, in the zones' order), Enter or
 *   Space picks, Delete clears. The list under it (every zone and "No zone") is the same choice for whoever prefers a list.
 * - Read-only, without `onChange`, or held (`heldReason`, said on screen): the pin and the words only.
 * - `marks` (a heat map of defects, a risk assessment's hazards): marked zones drawn stronger in four steps with their
 *   number on the sketch (a text mark is shaded only: its words are in the table), and a table of the marked zones under
 *   it — the screen-reader way to the same facts.
 * - `shapes` / `figures`: another sketch (the default is the rider garment, `RIDER_GARMENT_SHAPES`).
 * The zones and their words are the app's (`zones`); data in, events out.
 */
import { useId, useMemo, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { MapPin } from 'lucide-react'

import { mergeLabels } from '../../lib/labels'
import { Button } from '../../primitives/Button'
import { Select } from '../../primitives/Select'
import { GARMENT_ZONE_MAP_LABELS, type GarmentZoneMapLabels } from './GarmentZoneMapLabels'
import {
  centreOf,
  figureOf,
  offSketch,
  RIDER_GARMENT_FIGURES,
  RIDER_GARMENT_SHAPES,
  stepZone,
  zoneLabel,
  zoneMarkViews,
  type GarmentFigure,
  type GarmentZoneMark,
  type GarmentZoneMarkView,
  type GarmentZoneOption,
  type GarmentZoneShape,
} from './garmentZoneMapModel'
import './garmentZoneMap.css'

export interface GarmentZoneMapProps {
  /** Every zone in the order the arrows and the list walk them, with its words in the page's language. */
  zones: readonly GarmentZoneOption[]
  /** The picked zone id, or null. */
  value: string | null
  /** A pick (null: no zone). Absent, or `readOnly`, or a `heldReason`: the map only shows the pin. */
  onChange?: (zone: string | null) => void
  readOnly?: boolean
  /** The map's name for assistive technology ("Where on the garment"). */
  label: string
  /** Smaller figures (a row of a list, a narrow drawer). */
  compact?: boolean
  /** Why it cannot be changed now (the map shows the pin and says why). */
  heldReason?: string | null
  /** Marks per zone (a heat map, a risk assessment): drawn stronger with their number, and listed in a table. */
  marks?: readonly GarmentZoneMark[] | null
  /** How a mark's value is written (the page's language). Default: as it is. */
  formatMark?: (value: number) => string
  /** Another sketch. Default: the rider garment. */
  shapes?: readonly GarmentZoneShape[]
  /** The figures of `shapes`, in drawing order. Default: front, back, trousers. */
  figures?: readonly GarmentFigure[]
  className?: string
  labels?: Partial<GarmentZoneMapLabels>
}

export function GarmentZoneMap({
  zones,
  value,
  onChange,
  readOnly,
  label,
  compact,
  heldReason,
  marks,
  formatMark,
  shapes = RIDER_GARMENT_SHAPES,
  figures = RIDER_GARMENT_FIGURES,
  className,
  labels,
}: GarmentZoneMapProps) {
  const lw = mergeLabels(GARMENT_ZONE_MAP_LABELS, labels)
  const listId = useId()
  const editable = !!onChange && !readOnly && !heldReason
  const refs = useRef(new Map<string, HTMLElement | SVGElement>())
  const ids = useMemo(() => zones.map((zone) => zone.id), [zones])
  const elsewhere = useMemo(() => offSketch(ids, shapes), [ids, shapes])
  const marked = useMemo(() => zoneMarkViews(marks, zones, formatMark), [marks, zones, formatMark])
  const markOf = (zone: string): GarmentZoneMarkView | undefined => marked.find((mark) => mark.zone === zone)
  // The one Tab stop of the sketch: the picked zone, else the first.
  const focusZone = value && ids.includes(value) ? value : (ids[0] ?? null)
  const pick = (zone: string | null) => {
    if (editable) onChange?.(zone)
  }
  const onKey = (event: KeyboardEvent, zone: string) => {
    if (!editable) return
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown' || event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault()
      const next = stepZone(ids, zone, event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1)
      if (next) refs.current.get(next)?.focus()
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      pick(zone)
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault()
      pick(null)
    }
  }
  const register = (zone: string) => (element: HTMLElement | SVGElement | null) => {
    if (element) refs.current.set(zone, element)
    else refs.current.delete(zone)
  }
  const nameOf = (zone: string) => {
    const mark = markOf(zone)
    const name = zoneLabel(zones, zone)
    return mark ? lw.marked(name, mark.words) : name
  }
  const pinFigure = figureOf(value, shapes)
  const pinShape = value ? shapes.find((shape) => shape.zone === value && !shape.copy) : undefined
  const picked = value ? lw.picked(zoneLabel(zones, value)) : lw.nonePicked

  return (
    <div className={['nds-zone-map', compact ? 'is-compact' : null, className].filter(Boolean).join(' ')} role="group" aria-label={label}>
      <div className="nds-zone-figures">
        {figures.map((figure) => (
          <FigureSketch key={figure} title={lw.figures[figure] ?? figure}>
            {shapes
              .filter((shape) => shape.figure === figure)
              .map((shape, index) => {
                const isPicked = shape.zone === value
                const mark = markOf(shape.zone)
                const name = nameOf(shape.zone)
                const common = {
                  points: shape.points,
                  className: 'nds-zone-shape',
                  'data-picked': isPicked ? 'true' : undefined,
                  'data-level': mark ? String(mark.level) : undefined,
                  'data-zone': shape.zone,
                  onClick: editable ? () => pick(shape.zone) : undefined,
                }
                if (shape.copy || !editable || !ids.includes(shape.zone)) {
                  return (
                    <polygon key={`${shape.zone}-${index}`} {...common} aria-hidden="true">
                      {!shape.copy && <title>{name}</title>}
                    </polygon>
                  )
                }
                return (
                  <polygon
                    key={`${shape.zone}-${index}`}
                    {...common}
                    ref={register(shape.zone)}
                    role="button"
                    tabIndex={shape.zone === focusZone ? 0 : -1}
                    aria-pressed={isPicked}
                    aria-label={name}
                    onKeyDown={(event) => onKey(event, shape.zone)}
                  >
                    <title>{name}</title>
                  </polygon>
                )
              })}
            {marked
              .filter((mark) => mark.badge && figureOf(mark.zone, shapes) === figure)
              .map((mark) => (
                <MarkWords key={mark.zone} points={shapes.find((shape) => shape.zone === mark.zone && !shape.copy)!.points} words={mark.badge} />
              ))}
            {pinFigure === figure && pinShape && <Pin points={pinShape.points} />}
          </FigureSketch>
        ))}
      </div>
      {elsewhere.length > 0 && (
        <div className="nds-zone-elsewhere">
          <span className="nds-zone-sub">{lw.elsewhere}</span>
          {elsewhere.map((zone) => {
            const isPicked = zone === value
            const mark = markOf(zone)
            const name = zoneLabel(zones, zone)
            const words = mark?.words ? <span className="nds-zone-chip-mark">{mark.words}</span> : null
            return editable ? (
              <button
                key={zone}
                type="button"
                ref={register(zone) as (element: HTMLButtonElement | null) => void}
                className="nds-zone-chip"
                data-picked={isPicked ? 'true' : undefined}
                data-level={mark ? String(mark.level) : undefined}
                aria-pressed={isPicked}
                aria-label={mark ? lw.marked(name, mark.words) : undefined}
                tabIndex={zone === focusZone ? 0 : -1}
                onClick={() => pick(zone)}
                onKeyDown={(event) => onKey(event, zone)}
              >
                {isPicked && <MapPin size={12} aria-hidden />}
                {name}
                {words}
              </button>
            ) : (
              <span key={zone} className="nds-zone-chip is-static" data-picked={isPicked ? 'true' : undefined} data-level={mark ? String(mark.level) : undefined}>
                {isPicked && <MapPin size={12} aria-hidden />}
                {name}
                {words}
              </span>
            )
          })}
        </div>
      )}
      <p className="nds-zone-picked" role="status">
        <MapPin size={14} aria-hidden />
        <span>{picked}</span>
      </p>
      {heldReason && !readOnly && <p className="nds-zone-sub">{heldReason}</p>}
      {marked.length > 0 && (
        <table className="nds-zone-marks">
          <caption className="nds-zone-sub">{lw.marks}</caption>
          <thead>
            <tr>
              <th scope="col">{lw.marksZone}</th>
              <th scope="col">{lw.marksValue}</th>
            </tr>
          </thead>
          <tbody>
            {marked.map((mark) => (
              <tr key={mark.zone} data-picked={mark.zone === value ? 'true' : undefined}>
                <th scope="row">{mark.label}</th>
                <td>{mark.words}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editable && (
        <div className="nds-zone-list">
          <label className="nds-zone-sub" htmlFor={listId}>
            {lw.list}
          </label>
          <Select id={listId} size="sm" value={value ?? ''} onChange={(event) => pick(event.target.value || null)}>
            <option value="">{lw.none}</option>
            {zones.map((zone) => (
              <option key={zone.id} value={zone.id}>
                {zone.label}
              </option>
            ))}
          </Select>
          <Button size="sm" variant="quiet" heldReason={value ? null : lw.nothingToClear} onClick={() => pick(null)}>
            {lw.clear}
          </Button>
        </div>
      )}
      {editable && !compact && <p className="nds-zone-sub">{lw.hint}</p>}
    </div>
  )
}

function FigureSketch({ title, children }: { title: string; children: ReactNode }) {
  return (
    <figure className="nds-zone-figure">
      <svg viewBox="0 0 120 150" className="nds-zone-svg" focusable="false">
        {children}
      </svg>
      <figcaption className="nds-zone-sub">{title}</figcaption>
    </figure>
  )
}

/** The pin on the picked zone: a ring with a dot (the outline and the words say it too). */
function Pin({ points }: { points: string }) {
  const { x, y } = centreOf(points)
  return (
    <g className="nds-zone-pin" aria-hidden="true" pointerEvents="none">
      <circle cx={x} cy={y} r={5.5} />
      <circle cx={x} cy={y} r={2} className="nds-zone-pin-dot" />
    </g>
  )
}

/** A mark's number on its zone (the table under the map says it too). */
function MarkWords({ points, words }: { points: string; words: string }) {
  const { x, y } = centreOf(points)
  return (
    <text className="nds-zone-mark-words" x={x} y={y} dy="0.35em" textAnchor="middle" aria-hidden="true" pointerEvents="none">
      {words}
    </text>
  )
}
