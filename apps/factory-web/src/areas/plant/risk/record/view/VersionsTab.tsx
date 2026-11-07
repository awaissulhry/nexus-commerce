'use client'

import { Archive, ExternalLink, FileSignature, PenLine, Stamp, Undo2 } from 'lucide-react'
import { Banner, Card, EmptyState } from '@nexus/ui/components'
import { DocumentSeal } from '@nexus/ui/components/DocumentSeal/index'
import { Button, Spinner } from '@nexus/ui/primitives'
import { FileRow, useDsWords } from '../../../../../lib/i18n/ds-parts'
import type { AssessmentRecord, DvrVersion } from '../../api'
import { byRole, dvrHref, newVersionHeld, signerActs, versionNo } from '../../model'
import type { RiskRecordActions, RiskRecordModel } from '../../view-model'
import { Law, useDay, useWhen, useWords, VersionStatePill } from '../../view/parts'

/**
 * The Versions tab (design rec tab versions; QHS-230, art. 28 c.2): every DVR version with the proof of its date, newest
 * first — its number, label, effective date, author (consultant or in-house), the summary of changes, its seal (the DS
 * DocumentSeal: the frozen PDF's SHA-256, when and by whom it was frozen, the signers with their days; Verify a file on this
 * device), the frozen PDF (opened in its own tab with the seal), and each signer: signed (how, when, who recorded it), Sign
 * here (the holder, in the office) or Record paper signature (with its scan). A version waiting may be withdrawn with the
 * reason; a signed one keeps its seal. Never deleted: superseded and withdrawn versions stay.
 */
export function VersionsTab({ model, record, actions }: { model: RiskRecordModel; record: AssessmentRecord; actions?: RiskRecordActions | undefined }) {
  const t = useWords()
  const held = newVersionHeld(record)
  if (record.versions.length === 0) {
    return (
      <Card padded>
        <EmptyState
          icon={<FileSignature size={22} aria-hidden />}
          title={t('versions.emptyTitle')}
          description={t('versions.empty')}
          action={
            <Button size="sm" variant="primary" heldReason={held ? t(held) : null} onClick={() => actions?.onAddress?.({ add: 'version' })}>
              {t('assessments.addCurrent')}
            </Button>
          }
        />
      </Card>
    )
  }
  return (
    <div className="fw-rk-stack">
      <p className="fw-rk-row fw-rk-muted">
        {t('versions.lead')} <Law law={record.law.versions} plain={t('law.versions')} />
      </p>
      {record.versions.map((version) => (
        <VersionCard key={version.id} model={model} record={record} version={version} actions={actions} />
      ))}
    </div>
  )
}

function VersionCard({ model, record, version, actions }: { model: RiskRecordModel; record: AssessmentRecord; version: DvrVersion; actions?: RiskRecordActions | undefined }) {
  const t = useWords()
  const ds = useDsWords()
  const day = useDay()
  const when = useWhen()
  const signers = byRole(version.signers)
  const waiting = version.status === 'AWAITING_SIGNATURES'
  const title = `${versionNo(version)}${version.label ? ` · ${version.label}` : ''}`
  const keepHeld = !record.may.manage ? t('held.manage') : model.keeping === version.id ? t('held.saving') : null
  return (
    <Card padded>
      <article className="fw-rk-stack" aria-labelledby={`fw-rk-version-${version.id}`}>
        <div className="fw-rk-head">
          <span className="fw-rk-head-title">
            <h3 id={`fw-rk-version-${version.id}`} className="fw-rk-h">
              {title}
            </h3>
            <VersionStatePill version={version} />
            {version.certainDateOn && <span className="fw-rk-strong">{t('version.certainDate', { date: day(version.certainDateOn) })}</span>}
          </span>
          <span className="fw-rk-row">
            {waiting && (
              <Button size="sm" heldReason={record.may.manage ? null : t('held.manage')} onClick={() => actions?.onAddress?.({ withdraw: version.id })}>
                <Undo2 size={13} aria-hidden /> {t('version.withdraw')}
              </Button>
            )}
            {version.status === 'SIGNED' && !version.sealed && (
              <Button size="sm" heldReason={keepHeld} onClick={() => actions?.onKeepSeal?.(version.id)}>
                {model.keeping === version.id ? <Spinner size={14} /> : <Stamp size={13} aria-hidden />} {t('version.keepSeal')}
              </Button>
            )}
            <Button size="sm" asChild>
              <a href={dvrHref(model.prefix, record.assessment.id, version.id)} target="_blank" rel="noopener">
                <ExternalLink size={13} aria-hidden /> {t('version.openPdf')}
              </a>
            </Button>
          </span>
        </div>
        <p className="fw-rk-muted">
          {t('version.facts', { effective: day(version.effectiveOn), author: version.authorName, kind: t(`author.${version.authorKind}`) })}
          {version.measures > 0 ? ` · ${t('version.measures', { count: version.measures })}` : ''}
        </p>
        {version.changeSummary && <p>{version.changeSummary}</p>}
        {version.status === 'WITHDRAWN' && (
          <Banner tone="info" title={t('version.withdrawnOn', { date: when(version.withdrawnAt) })}>
            {version.withdrawnReason ?? ''}
          </Banner>
        )}
        <div className="fw-rk-version-grid">
          <div className="fw-rk-stack">
            <FileRow
              name={version.file.name}
              status={t('version.frozenFile', { date: when(version.frozenAt) })}
              actions={
                <Button size="sm" variant="quiet" asChild>
                  <a href={dvrHref(model.prefix, record.assessment.id, version.id)} target="_blank" rel="noopener">
                    {t('common.open')}
                  </a>
                </Button>
              }
            />
            {version.sealed ? (
              <FileRow
                name={t('version.sealName', { version: versionNo(version), number: version.sealed.version })}
                status={t('version.sealKept', { date: when(version.sealed.createdAt) })}
                actions={
                  <Button size="sm" variant="quiet" asChild>
                    <a href={dvrHref(model.prefix, record.assessment.id, version.id, 'seal')} target="_blank" rel="noopener">
                      {t('common.open')}
                    </a>
                  </Button>
                }
              />
            ) : version.status === 'SIGNED' ? (
              <p className="fw-rk-muted">{t('version.sealNotKept')}</p>
            ) : null}
            <DocumentSeal
              title={`${record.assessment.name} · ${title}`}
              version={versionNo(version)}
              sha256={version.sha256}
              sealedAt={when(version.frozenAt)}
              timestampSource={t('seal.clock')}
              sealedBy={version.frozenBy ?? undefined}
              signers={signers.map((signer) => ({ id: signer.role, name: signer.signature?.signerName ?? signer.holder?.name ?? t('signers.nobody'), role: t(`role.${signer.role}`), signedAt: signer.signature ? day(signer.signature.signedOn) : null }))}
              labels={ds.documentSeal}
            />
          </div>
          <section className="fw-rk-stack" aria-labelledby={`fw-rk-signers-${version.id}`}>
            <h4 id={`fw-rk-signers-${version.id}`} className="fw-rk-h3">
              {t('signers.title')}
            </h4>
            <ul className="fw-rk-signer-list">
              {signers.map((signer) => {
                const acts = signerActs(version, signer, record.may)
                return (
                  <li key={signer.role} className="fw-rk-signer">
                    <span className="fw-rk-cell">
                      <b>{t(`role.${signer.role}`)}</b>
                      <span>{signer.signature?.signerName ?? signer.holder?.name ?? t('signers.nobodyHolds')}</span>
                      {signer.signature ? (
                        <span className="fw-rk-muted">
                          {t(`signed.${signer.signature.method}`, { date: day(signer.signature.signedOn), person: signer.signature.recordedBy ?? '—' })}
                        </span>
                      ) : waiting ? (
                        <span className="fw-rk-warn">{t('signers.notYet')}</span>
                      ) : null}
                      {signer.signature?.scan && (
                        <Button size="sm" variant="quiet" onClick={() => actions?.onOpenFile?.(signer.signature!.scan!.fileId)}>
                          <Archive size={12} aria-hidden /> {t('signers.scan')}
                        </Button>
                      )}
                    </span>
                    <span className="fw-rk-row">
                      {acts.map((act) =>
                        act.kind === 'office' ? (
                          <Button key="office" size="sm" variant="primary" onClick={() => actions?.onAddress?.({ sign: version.id, role: signer.role, method: 'office' })}>
                            <PenLine size={13} aria-hidden /> {t('signers.signHere')}
                          </Button>
                        ) : act.kind === 'paper' ? (
                          <Button key="paper" size="sm" onClick={() => actions?.onAddress?.({ sign: version.id, role: signer.role, method: 'paper' })}>
                            {t('signers.paper')}
                          </Button>
                        ) : act.kind === 'held' && waiting ? (
                          <Button key="held" size="sm" heldReason={t(act.key)}>
                            {t('signers.signHere')}
                          </Button>
                        ) : null,
                      )}
                    </span>
                  </li>
                )
              })}
            </ul>
            {waiting && <p className="fw-rk-muted">{t('signers.floorLater')}</p>}
          </section>
        </div>
      </article>
    </Card>
  )
}
