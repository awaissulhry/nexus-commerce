'use client'

import { Banner } from '@nexus/ui/components'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { PdfViewer } from '@nexus/ui/components/PdfViewer/index'
import { Spinner } from '@nexus/ui/primitives'
import { SDS_LAW } from '@nexus/factory-domain/safety/chemicals/rules'
import { useDsWords } from '../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../lib/i18n/provider'
import { pdfViewerLabels } from '../../../../../lib/pdf/labels'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { Chemical, Sheet } from '../../api'
import '../../chemicals.css'
import { CHEMICALS_NAMESPACES, NoChemicalsAccess, SignalWord, useDay, useWords } from '../../view/parts'

/** SCR-213-sds — one sheet's PDF in its own tab: one view model, nothing fetched. */
export interface SdsTabModel {
  readonly canView: boolean
  readonly chemical: Chemical | null
  readonly sheet: Sheet | null
  readonly pdf: { readonly bytes: Uint8Array; readonly fileName: string } | null
  readonly problem: string | null
}

/**
 * Plant › Chemicals & waste › SDS (PDF) (design plant.chemicals/tab:sds): the chemical, the sheet's version, revision day and
 * language (current, or superseded and kept), and the PDF in the DS PdfViewer — its download gives the file to print. A
 * superseded sheet says so above the PDF: the current one is the one to follow.
 */
export function SdsTabView({ model }: { model: SdsTabModel }) {
  return (
    <WithMessages namespaces={CHEMICALS_NAMESPACES}>
      <Tab model={model} />
    </WithMessages>
  )
}

function Tab({ model }: { model: SdsTabModel }) {
  const t = useWords()
  const shell = useT('shell')
  const ds = useDsWords()
  const day = useDay()
  if (!model.canView) return <NoChemicalsAccess />
  const { chemical, sheet } = model
  return (
    <article className="fw-ch-tab">
      <header className="fw-ch-head">
        <span className="fw-ch-head-title">
          <h1 className="fw-ch-h">{chemical ? t('sdsTab.title', { name: chemical.name }) : t('sdsTab.reading')}</h1>
          {chemical && <SignalWord word={chemical.signalWord} say={t} />}
        </span>
        <LawRef law={SDS_LAW} plain={t('law.sds')} labels={ds.lawRef} />
      </header>
      {sheet && (
        <p className="fw-ch-muted">
          {sheet.status === 'CURRENT'
            ? t('window.current', { version: sheet.versionLabel, language: t(`lang.${sheet.language}`), date: day(sheet.revisedOn) })
            : t('window.superseded', { version: sheet.versionLabel, language: t(`lang.${sheet.language}`), date: day(sheet.revisedOn), when: day(sheet.supersededAt), by: sheet.supersededBy ?? t('window.someone') })}
        </p>
      )}
      {sheet && sheet.status === 'SUPERSEDED' && <Banner tone="warning" title={t('sdsTab.superseded')} />}
      {model.problem ? (
        <Banner tone="danger" title={t('sdsTab.failed')}>
          {t(model.problem)}
        </Banner>
      ) : model.pdf ? (
        <div className="fw-ch-tab-pdf">
          <PdfViewer src={model.pdf.bytes} title={model.pdf.fileName} fileName={model.pdf.fileName} labels={pdfViewerLabels(shell)} height="80vh" />
        </div>
      ) : (
        <p className="fw-ch-muted" role="status">
          <Spinner size={14} /> {t('window.pdfLoading')}
        </p>
      )}
    </article>
  )
}
