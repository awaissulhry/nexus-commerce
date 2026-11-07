'use client'

import { Printer, Stamp } from 'lucide-react'
import { Banner, EmptyState } from '@nexus/ui/components'
import { DocumentSeal } from '@nexus/ui/components/DocumentSeal/index'
import { PdfViewer } from '@nexus/ui/components/PdfViewer/index'
import { Button, SegmentedControl, Spinner } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../lib/i18n/provider'
import { pdfViewerLabels } from '../../../../../lib/pdf/labels'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { Assessment, DvrVersion } from '../../api'
import { byRole, versionNo, type Problem } from '../../model'
import { RISK_NAMESPACES, useDay, useWhen, useWords, VersionStatePill } from '../../view/parts'
import '../../risk.css'

/** SCR-209-dvr — "DVR (frozen PDF)": one view model, nothing fetched. */
export interface DvrTabModel {
  /** safety.view. */
  canView: boolean
  /** files.read: the frozen PDF and a kept seal are files. */
  canReadFiles: boolean
  /** safety.risk.manage: Keep the seal. */
  canKeep: boolean
  assessment: Assessment | null
  version: DvrVersion | null
  /** pdf = the frozen document; seal = the kept seal (or its preview while none is kept). */
  show: 'pdf' | 'seal'
  bytes: Uint8Array | null
  /** A read that failed (a message key). */
  problem: string | null
  keeping: boolean
  keepProblem: Problem | null
}

export interface DvrTabActions {
  onShow?: (show: 'pdf' | 'seal') => void
  onKeep?: () => void
  onRetry?: () => void
}

/**
 * tab:dvr-pdf — "DVR (frozen PDF)" (design plant.risk new tab: "The signed document, printable."): the frozen PDF exactly as it
 * was frozen, in the DS PdfViewer (its own download and print), or its seal — the kept one (GeneratedDocument DVR_FROZEN),
 * else the preview the API makes ("awaiting signatures" while they wait); beside it the DocumentSeal (the fingerprint, when
 * and by whom it was frozen, the signers with their days; Verify a file on this device). Keep the seal once it is signed.
 */
export function DvrTabView({ model, actions }: { model: DvrTabModel; actions?: DvrTabActions }) {
  return (
    <WithMessages namespaces={RISK_NAMESPACES}>
      <Dvr model={model} actions={actions} />
    </WithMessages>
  )
}

function Dvr({ model, actions }: { model: DvrTabModel; actions?: DvrTabActions | undefined }) {
  const t = useWords()
  const shell = useT('shell')
  const ds = useDsWords()
  const day = useDay()
  const when = useWhen()
  if (!model.canView) return <EmptyState title={t('access.title')} description={t('access.body')} />
  const { version, assessment } = model
  const title = version && assessment ? `${assessment.name} · ${versionNo(version)}${version.label ? ` · ${version.label}` : ''}` : t('dvr.title')
  const keepHeld = !model.canKeep ? t('held.manage') : model.keeping ? t('held.saving') : version && version.status !== 'SIGNED' ? t('refusal.NOT_SIGNED') : null
  return (
    <div className="fw-rk-pdf">
      <div className="fw-rk-band fw-rk-noprint">
        <span className="fw-rk-head-title">
          <h1 className="fw-rk-h">{title}</h1>
          {version && <VersionStatePill version={version} />}
          {version?.certainDateOn && <span className="fw-rk-strong">{t('version.certainDate', { date: day(version.certainDateOn) })}</span>}
        </span>
        <span className="fw-rk-actions">
          <SegmentedControl
            size="sm"
            ariaLabel={t('dvr.show')}
            value={model.show}
            onChange={(value) => actions?.onShow?.(value === 'seal' ? 'seal' : 'pdf')}
            options={[
              { value: 'pdf', label: t('dvr.pdf') },
              { value: 'seal', label: t('dvr.seal') },
            ]}
          />
          {version && version.status === 'SIGNED' && !version.sealed && (
            <Button size="sm" heldReason={keepHeld} onClick={() => actions?.onKeep?.()}>
              {model.keeping ? <Spinner size={14} /> : <Stamp size={13} aria-hidden />} {t('version.keepSeal')}
            </Button>
          )}
          <Button size="sm" variant="primary" heldReason={model.bytes ? null : t('dvr.held')} onClick={() => window.print()}>
            <Printer size={13} aria-hidden /> {t('dvr.print')}
          </Button>
        </span>
      </div>
      {model.show === 'seal' && version && !version.sealed && <p className="fw-rk-muted fw-rk-noprint">{t(version.status === 'SIGNED' ? 'dvr.sealPreview' : 'dvr.sealWaiting')}</p>}
      {model.keepProblem && <Banner tone="danger" title={t(model.keepProblem.key)} />}
      {!model.canReadFiles && model.show === 'pdf' ? (
        <Banner tone="info" title={t('held.files')} />
      ) : model.problem ? (
        <Banner
          tone="danger"
          title={t(model.problem)}
          action={
            <Button size="sm" onClick={() => actions?.onRetry?.()}>
              {t('common.retry')}
            </Button>
          }
        />
      ) : model.bytes ? (
        <div className="fw-rk-pdf-grid">
          <PdfViewer src={model.bytes} title={title} fileName={model.show === 'pdf' && version ? version.file.name : `${title}.pdf`} labels={pdfViewerLabels(shell)} height="min(80vh, 1000px)" />
          {version && (
            <div className="fw-rk-noprint">
              <DocumentSeal
                title={title}
                version={versionNo(version)}
                sha256={version.sha256}
                sealedAt={when(version.frozenAt)}
                timestampSource={t('seal.clock')}
                sealedBy={version.frozenBy ?? undefined}
                signers={byRole(version.signers).map((signer) => ({ id: signer.role, name: signer.signature?.signerName ?? signer.holder?.name ?? t('signers.nobody'), role: t(`role.${signer.role}`), signedAt: signer.signature ? day(signer.signature.signedOn) : null }))}
                labels={ds.documentSeal}
              />
            </div>
          )}
        </div>
      ) : (
        <p className="fw-rk-muted" role="status">
          <Spinner size={14} /> {t('common.reading')}
        </p>
      )}
    </div>
  )
}
