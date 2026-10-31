'use client'

import type { ReactNode } from 'react'
import { ArrowLeft, CircleAlert, MapPin, Package, PackageMinus, Printer, ScanLine, Scissors, Tag, Undo2, X } from 'lucide-react'
import { LabelPreview, type LabelLayout } from '@nexus/ui/components/LabelPreview/index'
import { FloorButton, FloorList, FloorListRow, QuantityPad, ScanInput, qtyHeldReason, type CameraScanner, type FloorActions } from '@nexus/ui/floor'
import { formatNumber } from '../../../../lib/i18n/format'
import type { Translate } from '../../../../lib/i18n/messages'
import type { Locale } from '../../../../lib/i18n/locales'
import { FloorState } from '../../../frame/view/FloorState'
import type { TaskProblem } from '../../shared/task-api'
import { HeldLine, ListFooter, ProblemState, TaskLine, Ticks } from '../../shared/view/TaskParts'
import type { ReturnPlace } from '../api'
import { comesBackAs, returnBounds, type ReturnRow, type TagPrinter } from '../returns'

/**
 * SCR-093's W2a part — Return unused (B-W2a-75; design floor.pick sec "return": "Scan → quantity or area → Confirm →
 * label reprint"; SCM-216): what the work order holds that may come back (the pick list's issued less returned, less
 * what was cut), scan or tap one, the pad (a hide's remnant by its area, a lot or a material by its quantity, defaulted
 * to all that may come back), where it goes (the site's storage places), Confirm; then a hide that comes back as a
 * remnant gets its new tag with the area (the HIDE label on the station's printer). Online only, as issuing: held with
 * the reason. No money, no person.
 */

export type ReturnTag =
  /** The hide's code is no tag this app prints (an older code): its area is written on the old tag. */
  | { readonly kind: 'notOurs' }
  /** The role prints no labels. */
  | { readonly kind: 'noRight' }
  | { readonly kind: 'looking' }
  | { readonly kind: 'printer'; readonly printer: TagPrinter; readonly picked: string | null; readonly busy?: boolean; readonly problem?: TaskProblem | null }
  | { readonly kind: 'job'; readonly printer: string; readonly status: 'QUEUED' | 'SENT' | 'PRINTED' | 'FAILED'; readonly detail: string | null; readonly retrying?: boolean }

export interface PickReturnDone {
  readonly row: ReturnRow
  readonly quantity: number
  readonly place: string
  readonly as: 'whole' | 'remnant' | 'part'
  /** A hide's new tag; null: a lot or a material keeps its label. */
  readonly tag: ReturnTag | null
}

export interface PickReturnModel {
  readonly workOrder: string
  readonly rows: readonly ReturnRow[]
  /** The stock picked (scanned or tapped) and the pad's value. */
  readonly picked: { readonly rowKey: string; readonly value: number | null } | null
  /** The site's storage places; null while read. */
  readonly places: readonly ReturnPlace[] | null
  /** Why the places are not listed. */
  readonly placesHeld?: 'noPermission' | 'unavailable' | null
  readonly placeId: string | null
  readonly busy?: boolean
  /** A refusal of the return, or a code the work order does not hold. */
  readonly problem?: { readonly problem: TaskProblem; readonly code: string | null } | null
  readonly done?: PickReturnDone | null
}

export type ReturnAction =
  | { type: 'returnScan'; code: string }
  | { type: 'returnPick'; rowKey: string }
  | { type: 'returnValue'; value: number | null }
  | { type: 'returnPlace'; placeId: string }
  | { type: 'returnConfirm' }
  | { type: 'returnUnpick' }
  | { type: 'returnAnother' }
  | { type: 'returnBack' }
  | { type: 'tagPrinter'; printerId: string }
  | { type: 'tagPrint' }
  | { type: 'tagRetry' }

const KIND_ICON = { hide: <Scissors />, lot: <Package />, material: <Package /> } as const

const unitOf = (t: Translate, uom: string): string => {
  const key = `unit.${uom}`
  const word = t(key)
  return word === key ? uom : word
}

/** The remnant's new tag as the label shows it (HIDE: 100 × 50 mm, its tag's code as a barcode). */
function remnantLayout(row: ReturnRow, area: string, t: Translate): LabelLayout {
  return {
    name: t('return.tag.name', { code: row.code }),
    widthMm: 100,
    heightMm: 50,
    blocks: [
      { kind: 'title', text: `${row.itemCode} · ${row.itemName}`, size: 'md' },
      {
        kind: 'fields',
        columns: 3,
        fields: [
          { label: t('return.tag.colour'), value: row.colour ?? '—' },
          { label: t('return.tag.area'), value: area, size: 'lg' },
          { label: t('return.tag.lot'), value: row.lotCode ?? '—' },
        ],
      },
      { kind: 'fill' },
      { kind: 'barcode', value: row.code, heightMm: 9 },
    ],
  }
}

export interface ReturnStepInput {
  readonly ret: PickReturnModel
  readonly online: boolean
  readonly locale: Locale
  readonly t: Translate
  readonly shared: Translate
  readonly floor: Translate
  readonly send: (action: ReturnAction) => void
  readonly words: (code: string) => { message: string; fix: string | null } | null
  readonly camera?: CameraScanner
}

export function returnStep({ ret, online, locale, t, shared, floor, send, words, camera }: ReturnStepInput): { body: ReactNode; actions: FloorActions } {
  const figure = (value: number) => formatNumber(value, locale, { maximumFractionDigits: 2 })
  const amount = (value: number, uom: string) => `${figure(value)} ${unitOf(t, uom)}`
  const offline = online ? null : t('return.held.offline')
  const back = { label: t('return.back'), icon: <ArrowLeft />, onPress: () => send({ type: 'returnBack' }) }

  // ---- done: what came back, and a remnant's new tag ----
  if (ret.done) {
    const { row, quantity, place, as, tag } = ret.done
    const area = amount(quantity, row.uom)
    const another = { label: t('return.another'), icon: <Undo2 />, onPress: () => send({ type: 'returnAnother' }) }
    const printable = tag?.kind === 'printer' && tag.printer.kind !== 'none'
    const printHeld = tag?.kind === 'printer' ? (offline ?? (tag.busy ? t('return.tag.busy') : tag.printer.kind === 'choose' && tag.picked === null ? t('return.tag.pickPrinter') : null)) : null
    const actions: FloorActions = printable ? [back, another, { label: t('return.tag.print'), icon: <Printer />, onPress: () => send({ type: 'tagPrint' }), heldReason: printHeld }] : [back, another]
    const body = (
      <div className="fw-floor-stack">
        <div className="fw-pick-result" role="status">
          <TaskLine tone="success" icon={<PackageMinus />}>
            {t(`return.done.${as}`, { code: row.code, quantity: area, place })}
          </TaskLine>
          <Ticks state="recorded" />
        </div>
        {tag ? (
          <section className="fw-floor-section" aria-labelledby="fw-pick-tag">
            <h2 id="fw-pick-tag" className="fw-floor-section-title">
              <span className="fw-floor-inline-icon" aria-hidden="true">
                <Tag />
              </span>
              {t('return.tag.title')}
            </h2>
            {tag.kind === 'notOurs' ? <HeldLine text={t('return.tag.notOurs', { area })} /> : null}
            {tag.kind === 'noRight' ? <HeldLine text={t('return.tag.noRight', { area })} /> : null}
            {tag.kind === 'looking' ? <p className="fw-floor-muted" aria-busy="true">{t('return.tag.looking')}</p> : null}
            {tag.kind === 'printer' && tag.printer.kind === 'none' ? <HeldLine text={t('return.tag.noPrinter', { area })} /> : null}
            {tag.kind === 'printer' && (tag.printer.kind === 'station' || tag.printer.kind === 'site') ? (
              <TaskLine tone="info" icon={<Printer />}>
                {t(`return.tag.on.${tag.printer.kind}`, { printer: tag.printer.name })}
              </TaskLine>
            ) : null}
            {tag.kind === 'printer' && tag.printer.kind === 'choose' ? (
              <div className="fw-floor-row-actions" role="group" aria-label={t('return.tag.choose')}>
                {tag.printer.printers.map((printer) => (
                  <FloorButton key={printer.id} size="md" variant={tag.picked === printer.id ? 'primary' : 'secondary'} aria-pressed={tag.picked === printer.id} icon={<Printer />} onClick={() => send({ type: 'tagPrinter', printerId: printer.id })}>
                    {printer.name}
                  </FloorButton>
                ))}
              </div>
            ) : null}
            {tag.kind === 'printer' && tag.problem ? <ProblemState problem={tag.problem} /> : null}
            {printHeld && printable ? <HeldLine text={printHeld} /> : null}
            <div className="fw-pick-tag">
              <LabelPreview
                layout={remnantLayout(row, area, t)}
                scale={3}
                codeLabel={(value) => t('return.tag.code', { code: value })}
                invalidCodeLabel={(value) => t('return.tag.invalid', { code: value })}
                print={tag.kind === 'job' ? { status: tag.status === 'QUEUED' ? 'queued' : tag.status === 'SENT' ? 'sent' : tag.status === 'PRINTED' ? 'printed' : 'failed', label: t(`return.tag.state.${tag.status}`), detail: tag.status === 'FAILED' ? (tag.detail ?? undefined) : undefined } : undefined}
                onRetry={tag.kind === 'job' && tag.status === 'FAILED' ? () => send({ type: 'tagRetry' }) : undefined}
                retryLabel={t('return.tag.retry')}
                retryHeldReason={offline ?? (tag.kind === 'job' && tag.retrying ? t('return.tag.busy') : null)}
              />
            </div>
          </section>
        ) : (
          <p className="fw-floor-muted">{t('return.keepsLabel')}</p>
        )}
      </div>
    )
    return { body, actions }
  }

  const picked = ret.picked ? (ret.rows.find((row) => row.key === ret.picked!.rowKey) ?? null) : null

  // ---- what comes back: scan or tap ----
  if (!picked || !ret.picked) {
    const body = (
      <div className="fw-floor-stack">
        {offline ? <HeldLine text={offline} /> : null}
        <p className="fw-floor-lead">{t('return.lead', { workOrder: ret.workOrder })}</p>
        <ScanInput
          label={t('return.scan.label')}
          hint={offline ?? t('return.scan.hint')}
          scannedLabel={(code) => floor('scan.read', { code })}
          keyboardLabel={floor('scan.type')}
          disabled={Boolean(offline)}
          camera={camera ? { scanner: camera, startLabel: floor('scan.camera.start'), stopLabel: floor('scan.camera.stop'), errorLabel: floor('scan.camera.error') } : undefined}
          onScan={(code) => send({ type: 'returnScan', code })}
        />
        {ret.problem ? <ProblemState problem={ret.problem.problem} code={ret.problem.code} words={words} /> : null}
        {ret.rows.length === 0 ? (
          <FloorState tone="info" icon={<PackageMinus />} title={t('return.empty.title')} text={t('return.empty.body')} />
        ) : (
          <section className="fw-floor-stack" aria-labelledby="fw-pick-return">
            <h2 id="fw-pick-return" className="fw-floor-subtitle">
              {t('return.title')}
            </h2>
            <FloorList label={t('return.title')}>
              {ret.rows.map((row) => (
                <FloorListRow
                  key={row.key}
                  icon={KIND_ICON[row.kind]}
                  tone="neutral"
                  title={<span className="fw-floor-code">{row.code}</span>}
                  meta={[row.name, t('return.row.held', { quantity: amount(row.held, row.uom) }), row.cut > 0 ? t('return.row.cut', { quantity: amount(row.cut, row.uom) }) : null].filter(Boolean).join(' · ')}
                  status={t(`return.row.kind.${row.kind}`)}
                  count={figure(row.returnable)}
                  countLabel={t('return.row.returnable', { unit: unitOf(t, row.uom) })}
                  heldReason={offline}
                  onPress={() => send({ type: 'returnPick', rowKey: row.key })}
                />
              ))}
            </FloorList>
            <ListFooter
              count={t('return.count', { count: ret.rows.length })}
              keys={[
                { key: 'Tab', does: shared('keys.tab') },
                { key: 'Enter', does: shared('keys.enter') },
                { key: 'Esc', does: t('return.keyBack') },
              ]}
            />
          </section>
        )}
      </div>
    )
    return { body, actions: [back] }
  }

  // ---- how much, and where it goes ----
  const bounds = returnBounds(picked)
  const value = ret.picked.value
  const how = value !== null && value > 0 ? comesBackAs(picked, value) : null
  const padWords = { emptyLabel: t('return.pad.empty'), rangeLabel: (min: number | undefined, max: number | undefined) => t('return.pad.range', { min: figure(min ?? 0), max: figure(max ?? 0) }) }
  const held = offline ?? (ret.busy ? t('return.busy') : qtyHeldReason(value, bounds, padWords) ?? (ret.placeId ? null : t('return.held.place')))
  const actions: FloorActions = [
    { label: shared('action.back'), icon: <X />, onPress: () => send({ type: 'returnUnpick' }) },
    { label: value !== null && value > 0 ? t('return.confirm', { quantity: amount(value, picked.uom) }) : t('return.confirmNone'), icon: <PackageMinus />, onPress: () => send({ type: 'returnConfirm' }), heldReason: held },
  ]
  const body = (
    <div className="fw-floor-stack">
      {offline ? <HeldLine text={offline} /> : null}
      {ret.problem ? <ProblemState problem={ret.problem.problem} code={ret.problem.code} words={words} /> : null}
      <div className="fw-task-split">
        <section className="fw-pick-pad" aria-labelledby="fw-pick-return-pad">
          <h2 id="fw-pick-return-pad" className="fw-floor-section-title">
            <span className="fw-floor-inline-icon" aria-hidden="true">
              {KIND_ICON[picked.kind]}
            </span>
            {t('return.pad.title', { code: picked.code })}
          </h2>
          <p className="fw-floor-muted">
            {[picked.name, t('return.row.held', { quantity: amount(picked.held, picked.uom) }), picked.cut > 0 ? t('return.row.cut', { quantity: amount(picked.cut, picked.uom) }) : null].filter(Boolean).join(' · ')}
          </p>
          <QuantityPad
            label={picked.kind === 'hide' ? t('return.pad.area') : t('return.pad.quantity')}
            value={value}
            onChange={(next) => send({ type: 'returnValue', value: next })}
            unit={unitOf(t, picked.uom)}
            min={bounds.min}
            max={bounds.max}
            decimals={bounds.decimals}
            expected={bounds.suggested}
            expectedLabel={(expected) => t('return.pad.expected', { quantity: figure(expected) })}
            quickValues={picked.kind === 'hide' && picked.cut <= 0 ? [{ value: bounds.suggested, label: t('return.pad.whole') }] : [{ value: bounds.suggested, label: t('return.pad.all') }]}
            decimalSeparator={locale === 'it' ? ',' : '.'}
            separatorLabel={t('pad.separator')}
            decrementLabel={t('pad.minus')}
            incrementLabel={t('pad.plus')}
            clearLabel={t('pad.clear')}
            backLabel={t('pad.back')}
            emptyLabel={padWords.emptyLabel}
            rangeLabel={padWords.rangeLabel}
            message={how === 'remnant' ? t('return.pad.remnant') : how === 'whole' ? t('return.pad.wholeBack') : undefined}
            messageTone="info"
            autoFocus
          />
        </section>
        <section className="fw-floor-stack" aria-labelledby="fw-pick-return-place">
          <h2 id="fw-pick-return-place" className="fw-floor-section-title">
            <span className="fw-floor-inline-icon" aria-hidden="true">
              <MapPin />
            </span>
            {t('return.place.title')}
          </h2>
          {ret.placesHeld ? (
            <HeldLine text={t(`return.place.held.${ret.placesHeld}`)} />
          ) : ret.places === null ? (
            <p className="fw-floor-muted" aria-busy="true">
              {t('return.place.loading')}
            </p>
          ) : ret.places.length === 0 ? (
            <TaskLine tone="warning" icon={<CircleAlert />}>
              {t('return.place.none')}
            </TaskLine>
          ) : (
            <>
              <FloorList label={t('return.place.title')}>
                {ret.places.map((entry) => (
                  <FloorListRow
                    key={entry.id}
                    icon={<MapPin />}
                    tone={entry.id === ret.placeId ? 'success' : 'neutral'}
                    title={<span className="fw-floor-code">{entry.code}</span>}
                    meta={entry.name}
                    status={entry.id === ret.placeId ? t('return.place.picked') : undefined}
                    selected={entry.id === ret.placeId}
                    onPress={() => send({ type: 'returnPlace', placeId: entry.id })}
                  />
                ))}
              </FloorList>
              <ListFooter
                count={t('return.place.count', { count: ret.places.length })}
                keys={[
                  { key: 'Tab', does: shared('keys.tab') },
                  { key: 'Enter', does: t('return.keyConfirm') },
                  { key: 'Esc', does: shared('keys.escape') },
                ]}
              />
            </>
          )}
          {picked.kind === 'hide' ? (
            <p className="fw-floor-muted">
              <span className="fw-floor-inline-icon" aria-hidden="true">
                <ScanLine />
              </span>
              {t('return.place.tagNext')}
            </p>
          ) : null}
        </section>
      </div>
    </div>
  )
  return { body, actions }
}
