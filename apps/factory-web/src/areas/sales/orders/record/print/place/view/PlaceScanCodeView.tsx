'use client'

import { useRef, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactElement } from 'react'
import { ChevronLeft, ChevronRight, Lock, Printer, QrCode } from 'lucide-react'
import { Banner } from '@nexus/ui/components'
import { Button, FilterChip, Pill } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../../../lib/i18n/provider'
import { PartReading } from '../../../../../../../lib/record-sections/Kit'
import { WindowShell } from '../../../../../../../lib/window-shell/view/WindowShell'
import { dragged, keyed, maxSizeOf, MIN_CODE_MM, placeKeyOf, placeWordsOf, pxPerMmOf, QUICK_PLACES, quickPlaceOf, resized, sized, type PageMm, type Place, type Said, type SavedPlace } from '../model'
import '../../print.css'

/**
 * owb-ss4b step 4.4 (design plan § 5f "Place the code"; ui.js `qrModal`) — the window "Place the scan code", drawn with the ONE window
 * frame: the design page big (its own shape), the code as a square you drag; its corner you pull to make it bigger or smaller; a slider
 * in mm; six quick places; the keys (arrows 1 mm, Shift + arrows 5 mm, + / − the size, in the ONE ⓘ line). It never leaves the page and is
 * never under 20 mm: the drag, the corner, the slider and the keys stop there, and a line says why. One piece and one page at a time
 * (Piece 1 of 3 ‹ ›; Page 1 · Page 2). The ONE act **Save the place**; at the foot's left **Print this page again…** once the order is
 * printed. Draws its model; fetches nothing (it measures the page it draws to turn pixels into millimetres).
 */

export interface PlacePiece {
  readonly salesOrderLineId: string
  readonly label: string
  readonly fileId: string
}

export interface PlaceScanCodeViewModel {
  readonly open: boolean
  readonly state: 'reading' | 'failed' | 'none' | 'ready'
  /** Why it could not be read: a `shipments` word (problem.read.*), or `place.notForYou` (this reader may not open the pages). */
  readonly readProblem: string | null
  readonly pieces: readonly PlacePiece[]
  readonly pieceIndex: number
  readonly page: number
  readonly pageCount: number
  /** The page drawn and its own size in mm; null while it draws. */
  readonly drawn: ({ readonly src: string } & PageMm) | null
  readonly drawFailed: boolean
  readonly place: Place | null
  readonly saved: SavedPlace | null
  /** Why the last move stopped (under 20 mm, the edge). */
  readonly why: Said | null
  readonly held: Said | null
  readonly busy: boolean
  /** The place was just saved. */
  readonly savedNow: boolean
  /** A refused save, in the Warehouse's refusal words (`shipments`: problem.write.*), with the API's sentence. */
  readonly writeProblem: { readonly key: string; readonly detail: string | null } | null
  /** "Print this page again…" (production.print.start, the order printed). */
  readonly mayPrintAgain: boolean
}

export interface PlaceScanCodeViewActions {
  readonly onClose: () => void
  readonly onPiece?: (index: number) => void
  readonly onPage?: (page: number) => void
  readonly onPlace?: (place: Place, why: Said | null) => void
  readonly onSave?: () => void
  readonly onPrintAgain?: () => void
}

const NO_ACTIONS: PlaceScanCodeViewActions = Object.freeze({ onClose: () => undefined })

export function PlaceScanCodeView({ model, actions = NO_ACTIONS }: { model: PlaceScanCodeViewModel; actions?: PlaceScanCodeViewActions }): ReactElement {
  const t = useT('print-start')
  const s = useT('shipments')
  const piece = model.pieces[model.pieceIndex] ?? null
  const act = model.state === 'ready' ? { words: t('place.act'), onAct: () => actions.onSave?.(), held: model.held ? t(model.held.key, model.held.params) : null, busy: model.busy } : null
  const more = model.mayPrintAgain && model.state === 'ready' ? (
    <Button size="sm" variant="quiet" onClick={() => actions.onPrintAgain?.()}>
      <Printer size={14} aria-hidden /> {t('place.printAgain')}
    </Button>
  ) : undefined
  return (
    <WindowShell open={model.open} onClose={actions.onClose} title={t('place.title')} subtitle={piece?.label} act={act} more={more} size="xl">
      <div className="fw-print">
        {model.state === 'reading' ? <PartReading rows={4} height={48} /> : null}
        {model.state === 'failed' ? <Banner tone="danger" title={t('place.readFailed')}>{model.readProblem ? (model.readProblem.startsWith('place.') ? t(model.readProblem) : s(model.readProblem)) : null}</Banner> : null}
        {model.state === 'none' ? <p className="fw-print-mu">{t('place.none')}</p> : null}
        {model.state === 'ready' && piece ? <Ready model={model} actions={actions} /> : null}
        {model.writeProblem ? (
          <Banner tone="danger" title={s(model.writeProblem.key)}>
            {model.writeProblem.detail}
          </Banner>
        ) : null}
      </div>
    </WindowShell>
  )
}

function Ready({ model, actions }: { model: PlaceScanCodeViewModel; actions: PlaceScanCodeViewActions }): ReactElement {
  const t = useT('print-start')
  const locale = useLocale()
  const n = model.pieces.length
  const piece = model.pieces[model.pieceIndex]!
  return (
    <>
      <div className="fw-place-head">
        {n > 1 ? (
          <span className="fw-place-step">
            <Button size="sm" variant="quiet" aria-label={t('place.piecePrev')} onClick={() => actions.onPiece?.((model.pieceIndex - 1 + n) % n)}>
              <ChevronLeft size={16} aria-hidden />
            </Button>
            <b>{t('place.pieceOf', { n: model.pieceIndex + 1, of: n })}</b>
            <Button size="sm" variant="quiet" aria-label={t('place.pieceNext')} onClick={() => actions.onPiece?.((model.pieceIndex + 1) % n)}>
              <ChevronRight size={16} aria-hidden />
            </Button>
          </span>
        ) : null}
        <span className="fw-place-label">{piece.label}</span>
        {model.pageCount > 1 ? (
          <span className="fw-print-chips" role="group" aria-label={t('place.pages')}>
            {Array.from({ length: model.pageCount }, (_, index) => (
              <FilterChip key={index} pressed={model.page === index + 1} onClick={() => actions.onPage?.(index + 1)}>
                {t('place.page', { n: index + 1 })}
              </FilterChip>
            ))}
          </span>
        ) : null}
      </div>
      <div className="fw-place">
        <div className="fw-place-stage">
          {model.drawn && model.place ? <Stage drawn={model.drawn} place={model.place} onPlace={actions.onPlace} /> : model.drawFailed ? <p className="fw-print-mu">{t('place.drawFailed')}</p> : <PartReading rows={1} height={320} />}
          <p className="fw-print-hint">{t('place.drag')}</p>
        </div>
        <div className="fw-place-side">
          {model.drawn && model.place ? <Side drawn={model.drawn} place={model.place} onPlace={actions.onPlace} /> : null}
          {model.why ? <Banner tone="warning" title={t(model.why.key, model.why.params)} /> : null}
          <Banner tone="info" icon={<Lock size={18} aria-hidden />} title={t('place.rule', { min: MIN_CODE_MM })} />
          <p className="fw-print-mu" role="status">
            {model.savedNow ? t('place.savedNow') : model.saved ? t('place.savedBy', { name: model.saved.placedBy.name, at: formatDateTime(model.saved.placedAt, { locale }) }) : t('place.notSaved')}
          </p>
        </div>
      </div>
    </>
  )
}

/** The page big, the code as a square: drag it, pull its corner, or move it with the keys. */
function Stage({ drawn, place, onPlace }: { drawn: { readonly src: string } & PageMm; place: Place; onPlace?: (place: Place, why: Said | null) => void }): ReactElement {
  const t = useT('print-start')
  const box = useRef<HTMLDivElement>(null)
  const drag = useRef<{ readonly kind: 'move' | 'size'; readonly x: number; readonly y: number; readonly start: Place } | null>(null)
  const begin = (kind: 'move' | 'size') => (event: PointerEvent<HTMLElement>) => {
    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { kind, x: event.clientX, y: event.clientY, start: place }
  }
  const move = (event: PointerEvent<HTMLElement>) => {
    const now = drag.current
    if (!now || !box.current) return
    const pxPerMm = pxPerMmOf(drawn, box.current.clientWidth)
    const next = (now.kind === 'move' ? dragged : resized)(now.start, event.clientX - now.x, event.clientY - now.y, pxPerMm, drawn)
    onPlace?.(next.place, next.why)
  }
  const end = () => {
    drag.current = null
  }
  const onKey = (event: KeyboardEvent<HTMLElement>) => {
    const key = placeKeyOf(event)
    if (!key) return
    event.preventDefault()
    const next = keyed(place, key, drawn)
    onPlace?.(next.place, next.why)
  }
  const ratio = drawn.widthMm / drawn.heightMm
  const square: CSSProperties = {
    left: `${(place.xMm / drawn.widthMm) * 100}%`,
    top: `${(place.yMm / drawn.heightMm) * 100}%`,
    width: `${(place.sizeMm / drawn.widthMm) * 100}%`,
    height: `${(place.sizeMm / drawn.heightMm) * 100}%`,
  }
  const words = placeWordsOf(place)
  return (
    <div ref={box} className="fw-place-page" style={{ aspectRatio: `${drawn.widthMm} / ${drawn.heightMm}`, width: `min(100%, ${(64 * ratio).toFixed(2)}vh)` }}>
      <img className="fw-place-img" src={drawn.src} alt={t('place.pageAlt')} draggable={false} />
      <div
        className="fw-place-code"
        style={square}
        role="group"
        tabIndex={0}
        aria-label={t('place.codeLabel', { where: t(words.key, words.params) })}
        aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Shift+ArrowLeft + -"
        onPointerDown={begin('move')}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        onKeyDown={onKey}
      >
        <QrCode className="fw-place-qr" aria-hidden />
        {/* The corner: the pointer it catches still reaches the square's own move and end (they bubble), so it needs only its start. */}
        <span className="fw-place-corner" aria-hidden onPointerDown={begin('size')} />
      </div>
    </div>
  )
}

/** The size slider in mm, the place in words, the six quick places. */
function Side({ drawn, place, onPlace }: { drawn: PageMm; place: Place; onPlace?: (place: Place, why: Said | null) => void }): ReactElement {
  const t = useT('print-start')
  const words = placeWordsOf(place)
  const max = Math.floor(maxSizeOf(drawn))
  return (
    <>
      <label className="fw-place-size">
        <span className="fw-place-row">
          <b>{t('place.size')}</b>
          <Pill tone="neutral">{t('place.mm', { mm: Math.round(place.sizeMm) })}</Pill>
        </span>
        <input
          type="range"
          className="fw-place-range"
          min={MIN_CODE_MM}
          max={max}
          step={0.5}
          value={place.sizeMm}
          onChange={(event) => {
            const next = sized(place, Number(event.target.value), drawn)
            onPlace?.(next.place, next.why)
          }}
          aria-valuetext={t('place.mm', { mm: Math.round(place.sizeMm) })}
        />
      </label>
      <div className="fw-place-row">
        <b>{t('place.whereTitle')}</b>
        <span className="fw-print-mu">{t(words.key, words.params)}</span>
      </div>
      <div className="fw-print-h3">{t('place.quick')}</div>
      <div className="fw-place-quick">
        {QUICK_PLACES.map((spot) => (
          <Button key={spot} size="sm" onClick={() => onPlace?.(quickPlaceOf(spot, place.sizeMm, drawn), null)}>
            {t(`place.spot.${spot}`)}
          </Button>
        ))}
      </div>
    </>
  )
}
