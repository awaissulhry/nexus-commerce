'use client'

import Link from 'next/link'
import { FileCheck2, Lock } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { DocumentSeal } from '@nexus/ui/components/DocumentSeal/index'
import { Button, Input, SegmentedControl, Select, Spinner } from '@nexus/ui/primitives'
import { DateField, FileDropzone, FileRow, Modal, Textarea, useDsWords } from '../../../../lib/i18n/ds-parts'
import type { Assessment } from '../api'
import { atField, byRole, freezeHeld, MAX_DVR_BYTES, newAssessmentHeld, recordHref, type VersionDraft } from '../model'
import type { RiskFrame, VersionActions, VersionDialogState } from '../view-model'
import { InForcePill, Law, useDay, useWhen, useWords } from './parts'

/**
 * New DVR version (design pop:version, from the band's primary; "Add the current DVR" on an empty list): the assessment —
 * or a new one for a site without — the consultant's PDF (its SHA-256 computed on this device first, the very value the
 * freeze seals), the version's label, effective date and author, the summary of changes, and who signs: the employer and
 * the RSPP, the RLS (or territorial RLS) and the occupational doctor the company has, as the safety organisation stands
 * today (one person holding two roles signs once). "Freeze and send for signature" uploads the PDF to the assessment, then
 * freezes it: the frozen PDF, its fingerprint and the time make the version's seal (the DS DocumentSeal). Building a version
 * from structured hazards stays Later. Composed as a Modal: the DS Builder overlay speaks English ("Close") and its primary
 * button cannot say why it waits.
 */
export function VersionDialog({ frame, state, assessments, fixed, actions }: { frame: RiskFrame; state: VersionDialogState; assessments: readonly Assessment[] | null; fixed: boolean; actions?: VersionActions | undefined }) {
  const t = useWords()
  const ds = useDsWords()
  const day = useDay()
  const when = useWhen()
  const { draft } = state
  const set = (change: Partial<VersionDraft>) => actions?.onVersionDraft?.({ ...draft, ...change })
  const record = state.record?.status === 'ready' ? state.record.value : null
  const assessment = record?.assessment ?? assessments?.find((row) => row.id === draft.assessmentId) ?? null
  const held = freezeHeld(draft, record, frame.today, state.busy)
  const error = (...fields: string[]) => {
    const key = atField(state.problem, ...fields)
    return key ? t(key) : undefined
  }
  const close = () => actions?.onVersionClose?.()
  const takenSites = new Set((assessments ?? []).map((row) => row.siteId))
  const freeSites = frame.scope.sites.filter((site) => !takenSites.has(site.id))
  const frozen = state.frozen

  if (frozen) {
    const signers = byRole(frozen.signers)
    return (
      <Modal
        open
        onClose={close}
        title={t('version.frozenTitle', { version: `v${frozen.versionNo}` })}
        size="lg"
        footer={
          <>
            <Button onClick={close}>{t('common.close')}</Button>
            <Button variant="primary" asChild>
              <Link href={recordHref(frame.prefix, frozen.assessmentId, { tab: 'versions' })} onClick={close}>
                {t('version.openVersions')}
              </Link>
            </Button>
          </>
        }
      >
        <div className="fw-rk-form">
          <Banner tone="success" title={t('version.frozen', { version: `v${frozen.versionNo}`, count: frozen.missing.length })}>
            {t('version.sendNote')}
          </Banner>
          <DocumentSeal
            title={assessment ? `${assessment.name} · v${frozen.versionNo}${frozen.label ? ` · ${frozen.label}` : ''}` : `v${frozen.versionNo}`}
            version={`v${frozen.versionNo}`}
            sha256={frozen.sha256}
            sealedAt={when(frozen.frozenAt)}
            timestampSource={t('seal.clock')}
            sealedBy={frozen.frozenBy ?? undefined}
            signers={signers.map((signer) => ({ id: signer.role, name: signer.holder?.name ?? t('signers.nobody'), role: t(`role.${signer.role}`), signedAt: signer.signature ? day(signer.signature.signedOn) : null }))}
            labels={ds.documentSeal}
          />
        </div>
      </Modal>
    )
  }

  return (
    <Modal
      open
      onClose={close}
      title={t('version.title')}
      subtitle={assessment ? `${assessment.name} · ${assessment.site.name}` : t('version.subtitle')}
      size="xl"
      footer={
        <>
          <Button onClick={close}>{t('common.cancel')}</Button>
          <Button variant="primary" heldReason={held ? t(held) : null} onClick={() => actions?.onVersionFreeze?.()}>
            {state.busy ? <Spinner size={14} /> : <Lock size={14} aria-hidden />} {state.step === 'uploading' ? t('version.uploading') : state.step === 'freezing' ? t('version.freezing') : t('version.freeze')}
          </Button>
        </>
      }
    >
      <div className="fw-rk-form fw-rk-builder">
        {state.problem && !state.problem.field && <Banner tone="danger" title={t(state.problem.key)} />}

        <section className="fw-rk-step" aria-labelledby="fw-rk-v1">
          <h3 id="fw-rk-v1" className="fw-rk-h3">
            {t('version.step1')}
          </h3>
          {fixed && assessment ? (
            <p className="fw-rk-row">
              <b>{assessment.name}</b> <span className="fw-rk-muted">{assessment.site.name}</span> <InForcePill version={assessment.inForce} />
            </p>
          ) : (
            <>
              <Field label={t('version.assessment')} error={error('assessmentId')}>
                <Select value={draft.assessmentId ?? (draft.newSiteId !== null ? 'new' : '')} aria-label={t('version.assessment')} onChange={(event) => (event.target.value === 'new' ? set({ assessmentId: null, newSiteId: freeSites[0]?.id ?? null, newName: freeSites[0]?.name ?? '' }) : set({ assessmentId: event.target.value || null, newSiteId: null }))}>
                  <option value="">{t('version.chooseAssessment')}</option>
                  {(assessments ?? []).map((row) => (
                    <option key={row.id} value={row.id}>{`${row.name} · ${row.site.name}`}</option>
                  ))}
                  {freeSites.length > 0 && <option value="new">{t('version.newAssessment')}</option>}
                </Select>
              </Field>
              {draft.assessmentId === null && draft.newSiteId !== null && (
                <div className="fw-rk-fieldset">
                  <p className="fw-rk-muted">{t('version.newAssessmentHint')}</p>
                  <div className="fw-rk-form-row">
                    <Field label={t('version.site')} required error={error('siteId')}>
                      <Select value={draft.newSiteId ?? ''} aria-label={t('version.site')} onChange={(event) => set({ newSiteId: event.target.value || null })}>
                        {freeSites.map((site) => (
                          <option key={site.id} value={site.id}>
                            {site.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label={t('version.assessmentName')} required hint={t('version.assessmentNameHint')} error={error('name')}>
                      <Input value={draft.newName} maxLength={200} onChange={(event) => set({ newName: event.target.value })} />
                    </Field>
                    <Field label={t('version.nextReview')} hint={t('version.nextReviewHint')} error={error('nextReviewOn')}>
                      <DateField value={draft.newReviewOn} clearable onChange={(value) => set({ newReviewOn: value })} ariaLabel={t('version.nextReview')} />
                    </Field>
                  </div>
                  <span>
                    <Button size="sm" heldReason={(() => { const why = !frame.can.manage ? 'held.manage' : newAssessmentHeld(draft, frame.today, state.addingAssessment); return why ? t(why) : null })()} onClick={() => actions?.onVersionAddAssessment?.()}>
                      {state.addingAssessment ? <Spinner size={14} /> : null} {t('version.addAssessment')}
                    </Button>
                  </span>
                </div>
              )}
            </>
          )}
          {state.record?.status === 'loading' && (
            <p className="fw-rk-muted" role="status">
              <Spinner size={14} /> {t('common.reading')}
            </p>
          )}
          {state.record?.status === 'error' && (
            <Banner
              tone="warning"
              title={t('version.recordFailed')}
              action={
                <Button size="sm" onClick={() => actions?.onVersionRetry?.()}>
                  {t('common.retry')}
                </Button>
              }
            >
              {t(state.record.problem)}
            </Banner>
          )}
          {record?.versions.some((version) => version.status === 'AWAITING_SIGNATURES') && (
            <Banner tone="warning" title={t('refusal.VERSION_WAITING')}>
              <Link href={recordHref(frame.prefix, record.assessment.id, { tab: 'versions' })}>{t('version.seeWaiting')}</Link>
            </Banner>
          )}
        </section>

        <section className="fw-rk-step" aria-labelledby="fw-rk-v2">
          <h3 id="fw-rk-v2" className="fw-rk-h3">
            {t('version.step2')}
          </h3>
          {draft.file ? (
            <FileRow
              name={draft.file.name}
              status={draft.sha256 ? t('version.fingerprint', { sha: `${draft.sha256.slice(0, 16)}…` }) : t('version.fingerprinting')}
              actions={
                <Button size="sm" variant="quiet" disabled={state.busy} onClick={() => actions?.onVersionFile?.(null)}>
                  {t('version.otherFile')}
                </Button>
              }
            />
          ) : (
            <FileDropzone onFiles={(files) => actions?.onVersionFile?.(files[0] ?? null)} accept=".pdf" maxBytes={MAX_DVR_BYTES} disabled={state.busy || (!record && !fixed)} hint={t('version.pdfHint')} />
          )}
          {error('fileId') && <p className="fw-rk-warn">{error('fileId')}</p>}
          <p className="fw-rk-muted">
            <FileCheck2 size={13} aria-hidden /> {t('version.hazardsLater')}
          </p>
        </section>

        <section className="fw-rk-step" aria-labelledby="fw-rk-v3">
          <h3 id="fw-rk-v3" className="fw-rk-h3">
            {t('version.step3')}
          </h3>
          <div className="fw-rk-form-row">
            <Field label={t('version.label')} hint={t('version.labelHint')} error={error('label')}>
              <Input value={draft.label} maxLength={60} onChange={(event) => set({ label: event.target.value })} />
            </Field>
            <Field label={t('version.effectiveOn')} required error={error('effectiveOn')}>
              <DateField value={draft.effectiveOn} onChange={(value) => set({ effectiveOn: value })} ariaLabel={t('version.effectiveOn')} />
            </Field>
          </div>
          <div className="fw-rk-form-row">
            <Field label={t('version.authorKind')}>
              <SegmentedControl
                size="sm"
                ariaLabel={t('version.authorKind')}
                value={draft.authorKind}
                onChange={(value) => set({ authorKind: value === 'IN_HOUSE' ? 'IN_HOUSE' : 'CONSULTANT' })}
                options={[
                  { value: 'CONSULTANT', label: t('author.CONSULTANT') },
                  { value: 'IN_HOUSE', label: t('author.IN_HOUSE') },
                ]}
              />
            </Field>
            <Field label={t('version.authorName')} required hint={t(draft.authorKind === 'CONSULTANT' ? 'version.authorConsultantHint' : 'version.authorInHouseHint')} error={error('authorName')}>
              <Input value={draft.authorName} maxLength={200} onChange={(event) => set({ authorName: event.target.value })} />
            </Field>
          </div>
          <Field label={t('version.summary')} hint={t('version.summaryHint')} error={error('changeSummary')}>
            <Textarea value={draft.changeSummary} rows={3} onChange={(event) => set({ changeSummary: event.target.value })} />
          </Field>
        </section>

        <section className="fw-rk-step" aria-labelledby="fw-rk-v4">
          <h3 id="fw-rk-v4" className="fw-rk-h3">
            {t('version.step4')}
          </h3>
          {!record ? (
            <p className="fw-rk-muted">{t('version.signersAfter')}</p>
          ) : record.next.missingEmployer ? (
            <Banner tone="danger" title={t('refusal.NO_EMPLOYER')}>
              <Link href={`${frame.prefix}/plant/calendar`}>{t('version.organisationLink')}</Link>
            </Banner>
          ) : (
            <>
              <ul className="fw-rk-list">
                {byRole(record.next.signers).map((signer) => (
                  <li key={signer.role}>
                    <b>{t(`role.${signer.role}`)}</b> — {signer.name}
                  </li>
                ))}
              </ul>
              {record.next.sameAs.map((same) => (
                <p key={`${same.role}-${same.as}`} className="fw-rk-muted">
                  {t('version.sameAs', { name: same.name, role: t(`role.${same.role}`), as: t(`role.${same.as}`) })}
                </p>
              ))}
              <p className="fw-rk-muted">{t('version.signersNote')}</p>
            </>
          )}
          <Law law={record?.law.versions ?? 'D.Lgs. 81/2008 art. 28 c.2'} plain={t('law.versions')} />
        </section>

        <section className="fw-rk-step" aria-labelledby="fw-rk-v5">
          <h3 id="fw-rk-v5" className="fw-rk-h3">
            {t('version.step5')}
          </h3>
          <p>{t('version.freezeExplain')}</p>
          <p className="fw-rk-muted">{t('version.sendNote')}</p>
        </section>
      </div>
    </Modal>
  )
}
