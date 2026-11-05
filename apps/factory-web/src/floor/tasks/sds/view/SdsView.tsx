'use client'

import { ArrowLeft, CloudOff, FileText, House, RefreshCw, ShieldAlert } from 'lucide-react'
import { FloorActionBar, FloorButton } from '@nexus/ui/floor'
import { PdfViewer } from '@nexus/ui/components/PdfViewer/index'
import { Select } from '@nexus/ui/primitives'
import { cabinetCodeOf, type QuantityUnit } from '@nexus/factory-domain/safety/chemicals/rules'
import { formatDateTime } from '../../../../lib/i18n/format'
import type { Translate } from '../../../../lib/i18n/messages'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { pdfViewerLabels } from '../../../../lib/pdf/labels'
import { WithMessages } from '../../../../record-panels/i18n'
import { FloorFrameView, type FrameAction, type FrameModel } from '../../../frame/view/FloorFrameView'
import { FloorState } from '../../../frame/view/FloorState'
import { TaskLine } from '../../shared/view/TaskParts'
import { GhsMarks, SignalWord } from '../../../../lib/chemicals/marks'
import '../sds.css'
import type { FloorChemical, SdsPack } from '../api'
import { cabinetIn, cabinetsOf, firstSheetOf, keptSheets } from '../model'

/** The cabinet named in the address (`?cabinet=`), as stored: in capitals; null when none. */
export const cabinetCodeFrom = (value: string | null): string | null => cabinetCodeOf(value)

/** A sheet open full screen: its kept bytes, or why it cannot open. */
export interface SdsOpenSheet {
  readonly sheetId: string
  readonly title: string
  readonly bytes: Uint8Array | null
  readonly problem: boolean
}

/** SCR-213-floor — the cabinet reader: one view model, nothing fetched. */
export interface SdsModel {
  readonly frame: FrameModel
  /** The cabinet the QR names; null: every cabinet of the site. */
  readonly cabinet: string | null
  /** What the tablet keeps (null: nothing yet). */
  readonly pack: SdsPack | null
  /** The file ids whose PDF the tablet keeps. */
  readonly kept: ReadonlySet<string>
  /** reading / refreshing: online, bringing it up to date; fresh; partial: some PDFs not taken; offline: the kept copy; nothingKept. */
  readonly state: 'reading' | 'refreshing' | 'fresh' | 'partial' | 'offline' | 'nothingKept'
  readonly open: SdsOpenSheet | null
  readonly readerLanguage: string
}

export type SdsAction = { type: 'open'; sheetId: string; fileId: string; title: string } | { type: 'close' } | { type: 'cabinet'; code: string | null } | { type: 'home' }

/**
 * SCR-213-floor — Floor › Safety data sheets at the cabinet (B-W2b-143; design plant.chemicals "SDS at the cabinet by QR,
 * readable offline on floor devices"; REACH art. 35): tablet first, one job — the cabinet's products (pictograms, signal
 * word, H and P statements, the most kept, the PPE to wear) and each one's current sheet, opened full screen. Everything comes
 * from what this tablet keeps, so it reads with the network gone; the screen says when it was kept, and a sheet the tablet does
 * not hold yet says so. Read-aloud is the frame's; no person, no money.
 */
export function SdsView({ model, onFrame, onAction }: { model: SdsModel; onFrame?: (action: FrameAction) => void; onAction?: (action: SdsAction) => void }) {
  return (
    <WithMessages namespaces={['floor', 'floor-sds', 'plant-chemicals', 'shell']}>
      <Reader model={model} onFrame={onFrame} onAction={onAction} />
    </WithMessages>
  )
}

function Reader({ model, onFrame, onAction }: { model: SdsModel; onFrame?: ((action: FrameAction) => void) | undefined; onAction?: ((action: SdsAction) => void) | undefined }) {
  const t = useT('floor-sds')
  const chem = useT('plant-chemicals')
  const shell = useT('shell')
  const locale = useLocale()
  const { pack, open } = model

  if (open) {
    return (
      <FloorFrameView frame={model.frame} onFrame={onFrame} actions={<FloorActionBar label={t('actions')} actions={[{ id: 'back', label: t('back'), icon: <ArrowLeft size={22} aria-hidden />, onPress: () => onAction?.({ type: 'close' }) }]} />}>
        <div className="fw-sds">
          <h1 className="fw-sds-title">{open.title}</h1>
          {open.bytes ? (
            <div className="fw-sds-pdf">
              <PdfViewer src={open.bytes} title={open.title} fileName={`${open.title}.pdf`} labels={pdfViewerLabels(shell)} height="72vh" />
            </div>
          ) : open.problem ? (
            <FloorState tone="warning" icon={<CloudOff size={28} aria-hidden />} title={t('notKept')} text={t('notKeptText')} />
          ) : (
            <FloorState tone="info" icon={<FileText size={28} aria-hidden />} title={t('opening')} busy />
          )}
        </div>
      </FloorFrameView>
    )
  }

  const group = pack && model.cabinet ? cabinetIn(pack, model.cabinet) : null
  const groups = pack ? (model.cabinet ? (group ? [group] : []) : cabinetsOf(pack)) : []
  const status = statusLine(t, model, locale)

  return (
    <FloorFrameView frame={model.frame} onFrame={onFrame} actions={<FloorActionBar label={t('actions')} actions={[{ id: 'home', label: t('home'), icon: <House size={22} aria-hidden />, onPress: () => onAction?.({ type: 'home' }) }]} />}>
      <div className="fw-sds">
        <header className="fw-sds-head">
          <span className="fw-sds-row">
            <h1 className="fw-sds-title">{model.cabinet ? t('cabinetTitle', { cabinet: model.cabinet }) : t('allTitle')}</h1>
            {group && <span className="fw-sds-muted">{group.places.join(' · ')}</span>}
          </span>
          {pack && (
            <Select size="md" value={model.cabinet ?? ''} aria-label={t('pickCabinet')} onChange={(event) => onAction?.({ type: 'cabinet', code: event.target.value || null })}>
              <option value="">{t('allCabinets')}</option>
              {cabinetsOf(pack)
                .filter((entry) => entry.code !== null)
                .map((entry) => (
                  <option key={entry.code!} value={entry.code!}>
                    {entry.code}
                  </option>
                ))}
            </Select>
          )}
        </header>
        {status && <TaskLine tone={status.tone} icon={status.icon}>{status.text}</TaskLine>}
        {!pack ? (
          model.state === 'nothingKept' ? (
            <FloorState tone="warning" icon={<CloudOff size={28} aria-hidden />} title={t('nothingKept')} text={t('nothingKeptText')} />
          ) : (
            <FloorState tone="info" icon={<RefreshCw size={28} aria-hidden />} title={t('reading')} busy />
          )
        ) : model.cabinet && !group ? (
          <FloorState tone="warning" icon={<ShieldAlert size={28} aria-hidden />} title={t('noCabinet', { cabinet: model.cabinet })} text={t('noCabinetText')} />
        ) : groups.length === 0 ? (
          <FloorState tone="info" icon={<FileText size={28} aria-hidden />} title={t('empty')} text={t('emptyText')} />
        ) : (
          groups.map((entry) => (
            <section key={entry.code ?? 'none'} className="fw-sds-section" aria-label={entry.code ? t('cabinetTitle', { cabinet: entry.code }) : t('noCabinetGroup')}>
              {!model.cabinet && <h2 className="fw-sds-h">{entry.code ? t('cabinetTitle', { cabinet: entry.code }) : t('noCabinetGroup')}</h2>}
              <div className="fw-sds-items">
                {entry.chemicals.map((chemical) => (
                  <Item key={chemical.id} chemical={chemical} model={model} chem={chem} t={t} onAction={onAction} />
                ))}
              </div>
            </section>
          ))
        )}
      </div>
    </FloorFrameView>
  )
}

function Item({ chemical, model, chem, t, onAction }: { chemical: FloorChemical; model: SdsModel; chem: Translate; t: Translate; onAction?: ((action: SdsAction) => void) | undefined }) {
  const first = firstSheetOf(chemical, model.readerLanguage, model.pack?.language ?? 'it')
  const sheets = keptSheets(chemical, model.kept)
  const unit = (code: QuantityUnit) => chem(`unit.${code}`)
  const most = chemical.maxQuantity && chemical.maxQuantityUnit ? `${chemical.maxQuantity.replace('.', ',')} ${unit(chemical.maxQuantityUnit)}` : null
  return (
    <article className="fw-sds-item" aria-label={chemical.name}>
      <span className="fw-sds-row">
        <h3 className="fw-sds-title">{chemical.name}</h3>
        <SignalWord word={chemical.signalWord} say={chem} />
      </span>
      <GhsMarks codes={chemical.ghsPictograms} say={chem} big />
      <span className="fw-sds-codes">{chemical.hazardStatements.join(' ') || '—'}</span>
      <span className="fw-sds-codes">{chemical.precautionStatements.join(' ') || '—'}</span>
      <span className="fw-sds-muted">{t('ppe', { ppe: chemical.ppe.join(', ') || t('noPpe') })}</span>
      {most && <span className="fw-sds-muted">{t('most', { quantity: most })}</span>}
      {sheets.length === 0 ? (
        <TaskLine tone="warning" icon={<ShieldAlert size={18} aria-hidden />}>
          {t('noSheet')}
        </TaskLine>
      ) : (
        <span className="fw-sds-stack">
          {[...sheets].sort((a, b) => (a.sheet.id === first?.id ? -1 : b.sheet.id === first?.id ? 1 : 0)).map(({ sheet, kept }) => (
            <FloorButton
              key={sheet.id}
              variant={sheet.id === first?.id ? 'primary' : 'secondary'}
              size="lg"
              block
              icon={<FileText size={20} aria-hidden />}
              heldReason={kept ? null : t('notKept')}
              onClick={() => onAction?.({ type: 'open', sheetId: sheet.id, fileId: sheet.fileId, title: t('sheetTitle', { name: chemical.name, version: sheet.versionLabel, language: chem(`lang.${sheet.language}`) }) })}
            >
              {t('openSheet', { language: chem(`lang.${sheet.language}`), version: sheet.versionLabel })}
            </FloorButton>
          ))}
        </span>
      )}
    </article>
  )
}

function statusLine(t: Translate, model: SdsModel, locale: string): { tone: 'info' | 'success' | 'warning'; icon: React.ReactNode; text: string } | null {
  const at = model.pack ? formatDateTime(model.pack.at, { locale: locale as never }) : null
  switch (model.state) {
    case 'refreshing':
      return at ? { tone: 'info', icon: <RefreshCw size={18} aria-hidden />, text: t('refreshing', { at }) } : null
    case 'fresh':
      return at ? { tone: 'success', icon: <FileText size={18} aria-hidden />, text: t('fresh', { at }) } : null
    case 'partial':
      return at ? { tone: 'warning', icon: <CloudOff size={18} aria-hidden />, text: t('partial', { at }) } : null
    case 'offline':
      return at ? { tone: 'warning', icon: <CloudOff size={18} aria-hidden />, text: t('offline', { at }) } : null
    default:
      return null
  }
}
