'use client'

import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { MapPin } from 'lucide-react'
import { GARMENT_ZONES } from '@nexus/factory-domain/quality/defects/rules'
import { Button, Select } from '@nexus/ui/primitives'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import { centreOf, FIGURES, figureOf, OFF_SKETCH, stepZone, ZONE_SHAPES, zoneWords, type Figure } from './zones'
import './zones.css'

export { zoneWords } from './zones'

export interface GarmentZoneMapProps {
  /** The picked zone id (factory-domain GARMENT_ZONES), or null. */
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
}

/**
 * GarmentZoneMap (design "GarmentZoneMap (new)", an area part of Quality — quality.defects df-drawer, quality.inspections
 * ins-defects; composed from DS primitives and an inline SVG): the jacket's front and back and the trousers' front, each
 * zone of the garment a pressable region named by its words in the person's language (aria-pressed), the picked zone
 * marked by more than colour — a thick outline, a pin and its words under the map — and the zones with no place on the
 * sketch (the lining) as chips. Keyboard: ONE Tab stop on the sketch, the arrows walk every zone, Enter or Space picks it,
 * Delete clears; the list under it (every zone and "No zone") is the same choice for whoever prefers a list. Read-only (or
 * held, with its reason) it draws the pin and the words only.
 */
export function GarmentZoneMap(props: GarmentZoneMapProps) {
  return (
    <WithMessages namespaces={['defects']}>
      <ZoneMap {...props} />
    </WithMessages>
  )
}

function ZoneMap({ value, onChange, readOnly, label, compact, heldReason }: GarmentZoneMapProps) {
  const t = useT('defects')
  const locale = useLocale()
  const listId = useId()
  const editable = !!onChange && !readOnly && !heldReason
  const refs = useRef(new Map<string, HTMLElement | SVGElement>())
  // The one Tab stop of the sketch: the picked zone, else the first.
  const focusZone = value && GARMENT_ZONES.some((zone) => zone.id === value) ? value : GARMENT_ZONES[0].id
  const pick = (zone: string | null) => {
    if (editable) onChange?.(zone)
  }
  const onKey = (event: KeyboardEvent, zone: string) => {
    if (!editable) return
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown' || event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault()
      const next = stepZone(zone, event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1)
      refs.current.get(next)?.focus()
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
  const pinFigure = figureOf(value)
  const words = zoneWords(value, locale)
  const picked = value ? t('zoneMap.picked', { zone: words }) : t('zoneMap.nonePicked')

  return (
    <div className={compact ? 'fw-zone-map is-compact' : 'fw-zone-map'} role="group" aria-label={label}>
      <div className="fw-zone-figures">
        {FIGURES.map((figure) => (
          <FigureSketch key={figure} figure={figure} title={t(`zoneMap.figure.${figure}`)}>
            {ZONE_SHAPES.filter((shape) => shape.figure === figure).map((shape, index) => {
              const isPicked = shape.zone === value
              const name = zoneWords(shape.zone, locale)
              const common = {
                points: shape.points,
                className: 'fw-zone-shape',
                'data-picked': isPicked ? 'true' : undefined,
                'data-zone': shape.zone,
                onClick: editable ? () => pick(shape.zone) : undefined,
              }
              if (shape.copy || !editable) {
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
            {pinFigure === figure && value && <Pin points={ZONE_SHAPES.find((shape) => shape.zone === value && !shape.copy)!.points} />}
          </FigureSketch>
        ))}
      </div>
      {OFF_SKETCH.length > 0 && (
        <div className="fw-zone-elsewhere">
          <span className="fw-zone-sub">{t('zoneMap.elsewhere')}</span>
          {OFF_SKETCH.map((zone) => {
            const isPicked = zone === value
            const name = zoneWords(zone, locale)
            return editable ? (
              <button
                key={zone}
                type="button"
                ref={register(zone) as (element: HTMLButtonElement | null) => void}
                className="fw-zone-chip"
                data-picked={isPicked ? 'true' : undefined}
                aria-pressed={isPicked}
                tabIndex={zone === focusZone ? 0 : -1}
                onClick={() => pick(zone)}
                onKeyDown={(event) => onKey(event, zone)}
              >
                {isPicked && <MapPin size={12} aria-hidden />}
                {name}
              </button>
            ) : (
              <span key={zone} className="fw-zone-chip is-static" data-picked={isPicked ? 'true' : undefined}>
                {isPicked && <MapPin size={12} aria-hidden />}
                {name}
              </span>
            )
          })}
        </div>
      )}
      <p className="fw-zone-picked" role="status">
        <MapPin size={14} aria-hidden />
        <span>{picked}</span>
      </p>
      {heldReason && !readOnly && <p className="fw-zone-sub">{heldReason}</p>}
      {editable && (
        <div className="fw-zone-list">
          <label className="fw-zone-sub" htmlFor={listId}>
            {t('zoneMap.list')}
          </label>
          <Select id={listId} size="sm" value={value ?? ''} onChange={(event) => pick(event.target.value || null)}>
            <option value="">{t('zoneMap.none')}</option>
            {GARMENT_ZONES.map((zone) => (
              <option key={zone.id} value={zone.id}>
                {locale === 'it' ? zone.it : zone.en}
              </option>
            ))}
          </Select>
          <Button size="sm" variant="quiet" heldReason={value ? null : t('zoneMap.nothingToClear')} onClick={() => pick(null)}>
            {t('zoneMap.clear')}
          </Button>
        </div>
      )}
      {editable && !compact && <p className="fw-zone-sub">{t('zoneMap.hint')}</p>}
    </div>
  )
}

function FigureSketch({ figure, title, children }: { figure: Figure; title: string; children: ReactNode }) {
  return (
    <figure className="fw-zone-figure" data-figure={figure}>
      <svg viewBox="0 0 120 150" className="fw-zone-svg" focusable="false">
        {children}
      </svg>
      <figcaption className="fw-zone-sub">{title}</figcaption>
    </figure>
  )
}

/** The pin on the picked zone: a ring with a dot (the outline and the words say it too). */
function Pin({ points }: { points: string }) {
  const { x, y } = centreOf(points)
  return (
    <g className="fw-zone-pin" aria-hidden="true" pointerEvents="none">
      <circle cx={x} cy={y} r={5.5} />
      <circle cx={x} cy={y} r={2} className="fw-zone-pin-dot" />
    </g>
  )
}
