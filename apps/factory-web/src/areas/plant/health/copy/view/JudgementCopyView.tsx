'use client'

import { useEffect, useState } from 'react'
import { Banner } from '@nexus/ui/components'
import { PdfViewer } from '@nexus/ui/components/PdfViewer/index'
import { PrivacyNote } from '@nexus/ui/components/PrivacyNote/index'
import { Spinner } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../lib/i18n/provider'
import { pdfViewerLabels } from '../../../../../lib/pdf/labels'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { JudgementCopyModel } from '../../view-model'
import '../../health.css'
import { HEALTH_NAMESPACES, NoHealthAccess, ProtectedLaw, useWhen, useWords } from '../../view/parts'

export type { JudgementCopyModel } from '../../view-model'

/**
 * SCR-212-copy — the doctor's copy of a judgement (design tab:copy "Judgement copy (PDF)"): the PrivacyNote (this opening was
 * recorded, GDPR art. 9), then the copy — a PDF in the DS PdfViewer (its own print), a picture of the paper as it is. A generic
 * title: the file's name may name the person. One view model, nothing fetched.
 */
export function JudgementCopyView({ model }: { model: JudgementCopyModel }) {
  return (
    <WithMessages namespaces={HEALTH_NAMESPACES}>
      <Copy model={model} />
    </WithMessages>
  )
}

function Copy({ model }: { model: JudgementCopyModel }) {
  const t = useWords()
  const shell = useT('shell')
  const ds = useDsWords()
  const when = useWhen()
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const bytes = model.kind === 'image' ? model.bytes : null
  useEffect(() => {
    if (!bytes || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return
    const url = URL.createObjectURL(new Blob([bytes as BlobPart]))
    setImageUrl(url)
    return () => {
      URL.revokeObjectURL(url)
      setImageUrl(null)
    }
  }, [bytes])
  if (!model.canView) return <NoHealthAccess />
  return (
    <article className="fw-hv-tab">
      <header className="fw-hv-head">
        <h1 className="fw-hv-h">{t('copyTab.title')}</h1>
      </header>
      <PrivacyNote level="protected" variant="panel" recorded text={model.at ? t('copyTab.recorded', { time: when.at(model.at) }) : t('copyTab.note')} law={<ProtectedLaw />} labels={ds.privacyNote} />
      {model.problem ? (
        <Banner tone="danger" title={t('copyTab.failed')}>
          {t(model.problem)}
        </Banner>
      ) : !model.bytes ? (
        <p className="fw-hv-muted" role="status">
          <Spinner size={14} /> {t('common.reading')}
        </p>
      ) : model.kind === 'pdf' ? (
        <PdfViewer src={model.bytes} title={t('copyTab.title')} fileName={t('copyTab.fileName')} labels={pdfViewerLabels(shell)} height="80vh" />
      ) : model.kind === 'image' ? (
        imageUrl ? <img className="fw-hv-copy-image" src={imageUrl} alt={t('copyTab.imageAlt')} /> : <p className="fw-hv-muted">{t('common.reading')}</p>
      ) : (
        <Banner tone="warning" title={t('copyTab.unknown')} />
      )}
    </article>
  )
}
