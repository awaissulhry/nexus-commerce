'use client'

import type { ReactNode } from 'react'
import { Boxes, CircleAlert, CircleSlash, House, Layers, MapPin, Package, ScanLine, ScanSearch, Scissors, Tag, WifiOff } from 'lucide-react'
import { FloorActionBar, FloorList, FloorListRow, ScanInput, type CameraScanner, type FloorActions, type FloorTone } from '@nexus/ui/floor'
import { formatDate, formatNumber, formatTime } from '../../../lib/i18n/format'
import { useLocale, useT } from '../../../lib/i18n/provider'
import type { Translate } from '../../../lib/i18n/messages'
import { FloorFrameView, type FrameAction, type FrameModel } from '../../frame/view/FloorFrameView'
import { FloorFacts, type FloorFact } from '../../frame/view/FloorFacts'
import { FloorState } from '../../frame/view/FloorState'
import type { HideCard, LabelType, LocationCard, ScanResult, WorkOrderCard } from '../scan-model'

/**
 * SCR-024 — scan anything (design floor.scan; PLT-126, PLT-155, PLT-243, SCM-273, MES-016, MES-074): one big field for
 * every label of the factory (scanner first, the camera as the fallback, typing as the last way), then the card of
 * what was scanned — the facts a floor person needs, big, never money — and the person's own scans of this session.
 * Every fact is text, not a link (a kiosk). A hide's or a work order's card opens Cut a hide with its code (SCR-094); a
 * card whose job screen is not built yet holds its action with the reason ("Coming soon"): nothing dead, nothing
 * pretending.
 */

export interface RecentScan {
  code: string
  type: LabelType | null
  /** When it was scanned (ISO). */
  at: string
}

export interface ScanViewModel {
  frame: FrameModel
  result: ScanResult | null
  /** The code being looked up. */
  loading?: string | null
  recent: readonly RecentScan[]
  /** The site's time zone. */
  timeZone?: string
  /** The worker notice holds scans. */
  held?: boolean
  /** The person may open Cut a hide (SCR-094): a hide's card and a work order's card open it with the code. */
  canCut?: boolean
}

export type ScanAction = { type: 'scan'; code: string } | { type: 'clear' } | { type: 'home' } | { type: 'cut'; code: string }

export interface ScanViewProps {
  model: ScanViewModel
  onAction?: (action: ScanAction) => void
  onFrame?: (action: FrameAction) => void
  camera?: CameraScanner
}

export const LABEL_ICON: Readonly<Record<LabelType, ReactNode>> = {
  hide: <Scissors />,
  bundle: <Layers />,
  lot: <Boxes />,
  batch: <Boxes />,
  serial: <Tag />,
  carton: <Package />,
  location: <MapPin />,
  workOrder: <ScanSearch />,
}

/** A status word from the API's value (`status.<group>.<VALUE>`), else the value as sent. */
export function statusWord(t: Translate, group: string, value: string): string {
  const key = `status.${group}.${value}`
  const word = t(key)
  return word === key ? value : word
}

export function ScanView({ model, onAction, onFrame, camera }: ScanViewProps) {
  const t = useT('floor')
  const locale = useLocale()
  const send = (action: ScanAction) => onAction?.(action)
  const { result } = model

  const scanAnother = { label: t('scan.another'), icon: <ScanLine />, onPress: () => send({ type: 'clear' }) }
  const coming = (label: string, icon: ReactNode) => ({ label, icon, onPress: () => undefined, heldReason: t('tile.held.coming') })
  let actions: FloorActions | null = null
  if (result && !model.loading) {
    // Cut a hide is built (SCR-094): the card opens it with its code; without the cutting permission, Scan another only.
    const cut = (label: string, icon: ReactNode, code: string) => ({ label, icon, onPress: () => send({ type: 'cut', code }) })
    if (result.kind === 'hide') actions = model.canCut ? [scanAnother, cut(t('scan.action.cut'), <Scissors />, result.code)] : [scanAnother]
    else if (result.kind === 'workOrder') actions = model.canCut ? [scanAnother, cut(t('scan.action.workOrder'), <ScanSearch />, result.number)] : [scanAnother]
    else if (result.kind === 'location') actions = [scanAnother, coming(t('scan.action.move'), <MapPin />)]
    else actions = [{ label: t('frame.home'), icon: <House />, onPress: () => send({ type: 'home' }) }, scanAnother]
  }

  return (
    <FloorFrameView frame={model.frame} onFrame={onFrame} actions={actions ? <FloorActionBar label={t('scan.title')} actions={actions} /> : undefined}>
      <div className="fw-floor-stack">
        <ScanInput
          label={t('scan.label')}
          hint={model.held ? t('tile.held.notice') : t('scan.hint')}
          scannedLabel={(code) => t('scan.read', { code })}
          keyboardLabel={t('scan.type')}
          disabled={Boolean(model.held)}
          camera={camera ? { scanner: camera, startLabel: t('scan.camera.start'), stopLabel: t('scan.camera.stop'), errorLabel: t('scan.camera.error') } : undefined}
          onScan={(code) => send({ type: 'scan', code })}
        />
        {model.loading ? (
          <div className="fw-floor-card" aria-busy="true">
            <p className="fw-floor-card-code">{model.loading}</p>
            <p className="fw-floor-muted">{t('scan.loading')}</p>
          </div>
        ) : result ? (
          <ResultCard result={result} t={t} locale={locale} timeZone={model.timeZone} />
        ) : (
          <p className="fw-floor-lead">{t('scan.empty')}</p>
        )}
        {model.recent.length > 0 ? (
          <section aria-labelledby="fw-floor-recent" className="fw-floor-stack">
            <h2 id="fw-floor-recent" className="fw-floor-subtitle">
              {t('scan.recent')}
            </h2>
            <FloorList label={t('scan.recent')}>
              {model.recent.map((scan, index) => (
                <FloorListRow
                  key={`${scan.code}-${index}`}
                  icon={scan.type ? LABEL_ICON[scan.type] : <CircleSlash />}
                  tone={scan.type ? 'neutral' : 'warning'}
                  title={<span className="fw-floor-code">{scan.code}</span>}
                  meta={scan.type ? t(`label.${scan.type}`) : t('scan.recentNothing')}
                  status={formatTime(scan.at, { locale, timeZone: model.timeZone })}
                />
              ))}
            </FloorList>
          </section>
        ) : null}
      </div>
    </FloorFrameView>
  )
}

function ResultCard({ result, t, locale, timeZone }: { result: ScanResult; t: Translate; locale: 'it' | 'en'; timeZone?: string }) {
  switch (result.kind) {
    case 'hide':
      return <HideFacts card={result} t={t} locale={locale} />
    case 'workOrder':
      return <WorkOrderFacts card={result} t={t} locale={locale} timeZone={timeZone} />
    case 'location':
      return <LocationFacts card={result} t={t} />
    case 'notOnFloor':
      return (
        <FloorState tone="info" icon={LABEL_ICON[result.type]} title={t('scan.notOnFloor.title', { type: t(`label.${result.type}`) })} text={t('scan.notOnFloor.body')}>
          <p className="fw-floor-card-code">{result.code}</p>
        </FloorState>
      )
    case 'noPermission':
      return <FloorState tone="warning" icon={<CircleSlash />} title={t('scan.noPermission', { type: t(`labelPlural.${result.type}`) })} text={t('scan.noPermissionBody')} alert />
    case 'unknown':
      return (
        <FloorState tone="danger" icon={<CircleAlert />} title={t(`scan.unknown.${result.reason}.title`)} text={t(`scan.unknown.${result.reason}.body`)} alert>
          {result.code ? <p className="fw-floor-card-code">{result.code}</p> : null}
        </FloorState>
      )
    case 'unavailable':
      return <FloorState tone="warning" icon={<WifiOff />} title={t('scan.unavailable.title')} text={t('scan.unavailable.body')} alert />
  }
}

function Card({ type, code, status, statusTone, facts, flags, t }: { type: LabelType; code: string; status?: string; statusTone?: FloorTone; facts: FloorFact[]; flags?: ReactNode; t: Translate }) {
  return (
    <section className="fw-floor-card" aria-labelledby="fw-floor-card-code">
      <header className="fw-floor-card-head">
        <span className="fw-floor-card-icon" aria-hidden="true">
          {LABEL_ICON[type]}
        </span>
        <span className="fw-floor-card-title">
          <span className="fw-floor-card-type">{t(`label.${type}`)}</span>
          <span id="fw-floor-card-code" className="fw-floor-card-code">
            {code}
          </span>
        </span>
        {status ? (
          <span className="fw-floor-pill" data-tone={statusTone ?? 'neutral'}>
            {status}
          </span>
        ) : null}
      </header>
      {flags}
      <FloorFacts facts={facts} />
    </section>
  )
}

const decimalText = (value: string, locale: 'it' | 'en') => {
  const number = Number(value)
  return Number.isFinite(number) ? formatNumber(number, locale, { maximumFractionDigits: 2 }) : value
}

function HideFacts({ card, t, locale }: { card: HideCard; t: Translate; locale: 'it' | 'en' }) {
  const lotTone: FloorTone = card.lot.qualityStatus === 'RELEASED' ? 'success' : card.lot.qualityStatus === 'QUARANTINE' ? 'warning' : 'danger'
  return (
    <Card
      type="hide"
      code={card.code}
      status={statusWord(t, 'hide', card.state)}
      statusTone={card.state === 'FULL' || card.state === 'PARTLY_CUT' ? 'success' : 'neutral'}
      t={t}
      flags={
        !card.lot.usable ? (
          <p className="fw-floor-notice" data-tone="danger" role="note">
            <span className="fw-floor-inline-icon" aria-hidden="true">
              <CircleAlert />
            </span>
            {t('scan.hide.notUsable')}
          </p>
        ) : null
      }
      facts={[
        { label: t('scan.fact.item'), value: card.colour ? `${card.item} · ${card.colour}` : card.item },
        { label: t('scan.fact.area'), value: `${decimalText(card.area, locale)} ${card.areaUom}` },
        { label: t('scan.fact.grade'), value: card.grade ?? '—' },
        { label: t('scan.fact.thickness'), value: card.thicknessMm ? `${decimalText(card.thicknessMm, locale)} mm` : '—' },
        { label: t('scan.fact.shade'), value: card.shade ?? '—' },
        {
          label: t('scan.fact.lot'),
          value: (
            <>
              {card.lot.code}{' '}
              <span className="fw-floor-pill" data-tone={lotTone}>
                {statusWord(t, 'lot', card.lot.qualityStatus)}
              </span>
            </>
          ),
        },
        { label: t('scan.fact.crVi'), value: statusWord(t, 'crVi', card.lot.crViStatus) },
        { label: t('scan.fact.where'), value: card.onHand.length > 0 ? card.onHand.map((row) => row.location).join(', ') : t('scan.fact.nowhere') },
        { label: t('scan.fact.forWorkOrders'), value: card.workOrders.length > 0 ? card.workOrders.join(', ') : t('scan.fact.none') },
      ]}
    />
  )
}

function WorkOrderFacts({ card, t, locale, timeZone }: { card: WorkOrderCard; t: Translate; locale: 'it' | 'en'; timeZone?: string }) {
  return (
    <Card
      type="workOrder"
      code={card.number}
      status={statusWord(t, 'workOrder', card.status)}
      statusTone={card.status === 'IN_PROGRESS' ? 'info' : card.status === 'RELEASED' ? 'success' : 'neutral'}
      t={t}
      facts={[
        { label: t('scan.fact.style'), value: card.style },
        { label: t('scan.fact.batch'), value: card.batchNumber ?? '—' },
        { label: t('scan.fact.due'), value: card.dueDate ? formatDate(`${card.dueDate}T12:00:00Z`, { locale, timeZone }) : '—' },
        { label: t('scan.fact.colourways'), value: card.colourways.join(', ') || '—' },
        { label: t('scan.fact.pieces'), value: formatNumber(card.pieces, locale) },
        { label: t('scan.fact.toCut'), value: formatNumber(card.toCut, locale) },
        { label: t('scan.fact.sizesLeft'), value: card.sizesLeft.join(', ') || t('scan.fact.none') },
      ]}
    />
  )
}

function LocationFacts({ card, t }: { card: LocationCard; t: Translate }) {
  return (
    <Card
      type="location"
      code={card.code}
      status={statusWord(t, 'location', card.locationKind)}
      t={t}
      facts={[
        { label: t('scan.fact.name'), value: card.name },
        { label: t('scan.fact.path'), value: card.path.join(' › ') },
      ]}
    />
  )
}
