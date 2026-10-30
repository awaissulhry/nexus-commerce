'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Banner, Card, Field, SummaryTable } from '@nexus/ui/components'
import { Input, Pill, Spinner, Toggle } from '@nexus/ui/primitives'
import { CR6_LEGAL_LIMIT_MG_KG } from '@nexus/factory-domain/product/materials/rules'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { editText } from '../../../styles/model'
import { CR_VI_TONE, LOT_TONE } from '../../../../quality/_shared/lots'
import { refusedField } from '../../../library/model'
import { ReadField, SaveBar } from '../../../library/parts'
import { LOTS_READ, type MaterialView } from '../../api'
import { numberText, plain } from '../../model'
import type { MaterialRecordActions, MaterialRecordViewModel } from '../record-model'

/** A Cr VI limit as typed: '' (none), a plain decimal ≤ 3, or why not (REACH Annex XVII entry 47). */
export function limitProblem(text: string): 'empty' | 'number' | 'law' | null {
  const value = plain(text)
  if (value === '') return 'empty'
  if (!/^\d+(?:\.\d{1,3})?$/.test(value) || Number(value) <= 0) return 'number'
  return Number(value) > Number(CR6_LEGAL_LIMIT_MG_KG) ? 'law' : null
}

/**
 * SCR-048 Compliance: what every lot must prove before release — Cr VI evidence and its limit (never above the legal
 * 3 mg/kg: refused at the field with the law; a brand may ask lower), animal origin (the label phrase), PPE component (an
 * EN 1621 protector) — then the certificates that cover it (for a PPE component) and its lots' recent test results, each
 * a link into Compliance. Explicit save.
 */
export function ComplianceTab({ material, model, actions }: { material: MaterialView; model: MaterialRecordViewModel; actions?: MaterialRecordActions }) {
  const t = useT('library')
  const locale = useLocale()
  const base = { requiresCrViTest: material.requiresCrViTest, crViLimitMgKg: editText(material.crViLimitMgKg, locale), isPpeComponent: material.isPpeComponent, animalOrigin: material.animalOrigin }
  const [draft, setDraft] = useState(base)
  const editable = model.can.materialsManage && material.status === 'ACTIVE'
  const limit = draft.requiresCrViTest ? limitProblem(draft.crViLimitMgKg) : null
  const patch: Record<string, unknown> = {}
  if (draft.requiresCrViTest !== base.requiresCrViTest) patch.requiresCrViTest = draft.requiresCrViTest
  if (draft.requiresCrViTest !== base.requiresCrViTest || plain(draft.crViLimitMgKg) !== plain(base.crViLimitMgKg)) patch.crViLimitMgKg = draft.requiresCrViTest ? plain(draft.crViLimitMgKg) || null : null
  if (draft.isPpeComponent !== base.isPpeComponent) patch.isPpeComponent = draft.isPpeComponent
  if (draft.animalOrigin !== base.animalOrigin) patch.animalOrigin = draft.animalOrigin
  const count = Object.keys(patch).length
  const held = limit ? t(`material.cp.limit.${limit}`) : null
  const refused = (field: string) => (model.refused && refusedField(model.refused.paths, field) ? t('newMaterial.refused') : undefined)

  return (
    <div className="fw-lib-stack">
      <div className="fw-lib-pair">
        <Card header={t('material.cp.rules')} description={editable ? t('material.cp.rulesHint') : t('material.readOnly')}>
          {editable ? (
            <div className="fw-lib-stack">
              <div className="fw-lib-form-grid">
                <Field label={t('material.requiresCrVi')} hint={t('material.requiresCrViHint')} error={refused('requiresCrViTest')}>
                  <span className="fw-lib-inline">
                    <Toggle checked={draft.requiresCrViTest} onChange={(next) => setDraft((now) => ({ ...now, requiresCrViTest: next, crViLimitMgKg: next ? now.crViLimitMgKg || CR6_LEGAL_LIMIT_MG_KG : '' }))} aria-label={t('material.requiresCrVi')} />
                    {t(draft.requiresCrViTest ? 'common.yes' : 'common.no')}
                  </span>
                </Field>
                {draft.requiresCrViTest && (
                  <Field label={t('material.crViLimit')} hint={t('material.crViLimitHint')} error={limit ? t(`material.cp.limit.${limit}`) : refused('crViLimitMgKg')}>
                    <Input inputMode="decimal" value={draft.crViLimitMgKg} onChange={(event) => setDraft((now) => ({ ...now, crViLimitMgKg: event.target.value }))} />
                  </Field>
                )}
                <Field label={t('material.animalOrigin')} hint={t('material.animalOriginHint')} error={refused('animalOrigin')}>
                  <span className="fw-lib-inline">
                    <Toggle checked={draft.animalOrigin} onChange={(next) => setDraft((now) => ({ ...now, animalOrigin: next }))} aria-label={t('material.animalOrigin')} />
                    {t(draft.animalOrigin ? 'common.yes' : 'common.no')}
                  </span>
                </Field>
                <Field label={t('material.ppe')} hint={t('material.ppeHint')} error={refused('isPpeComponent') ?? refused('tracking')}>
                  <span className="fw-lib-inline">
                    <Toggle checked={draft.isPpeComponent} onChange={(next) => setDraft((now) => ({ ...now, isPpeComponent: next }))} aria-label={t('material.ppe')} />
                    {t(draft.isPpeComponent ? 'common.yes' : 'common.no')}
                  </span>
                </Field>
              </div>
              {count > 0 && <SaveBar count={count} onDiscard={() => setDraft(base)} onSave={() => void actions?.onSave?.(patch)} held={held} busy={model.busy} saveLabel={t('material.save')} />}
            </div>
          ) : (
            <div className="fw-lib-form-grid">
              <ReadField label={t('material.requiresCrVi')} value={material.requiresCrViTest ? t('material.cp.limitWords', { limit: numberText(Number(material.crViLimitMgKg ?? 0), locale, 3) }) : t('common.no')} />
              <ReadField label={t('material.animalOrigin')} value={t(material.animalOrigin ? 'common.yes' : 'common.no')} />
              <ReadField label={t('material.ppe')} value={t(material.isPpeComponent ? 'common.yes' : 'common.no')} />
            </div>
          )}
        </Card>
        <CertificatesCard material={material} model={model} />
      </div>
      <TestsCard material={material} model={model} />
    </div>
  )
}

function CertificatesCard({ material, model }: { material: MaterialView; model: MaterialRecordViewModel }) {
  const t = useT('library')
  const locale = useLocale()
  const read = model.certificates
  return (
    <Card header={t('material.cp.certificates')}>
      {!material.isPpeComponent ? (
        <p className="fw-lib-hint">{t('material.cp.notPpe')}</p>
      ) : !model.can.certificates || read === null ? (
        <p className="fw-lib-hint">{t('material.cp.noCertificatesRight')}</p>
      ) : read.problem ? (
        <Banner tone="danger" title={t('material.cp.certificatesFailed')}>
          {t(read.problem)}
        </Banner>
      ) : read.value === null ? (
        <p className="fw-lib-hint fw-lib-inline" role="status">
          <Spinner size={12} /> {t('record.loading')}
        </p>
      ) : read.value.length === 0 ? (
        <p className="fw-lib-hint fw-lib-warn">{t('material.cp.noCertificates')}</p>
      ) : (
        <SummaryTable
          label={t('material.cp.certificates')}
          stackOnPhone
          columns={[t('material.cp.col.certificate'), t('material.cp.col.standard'), t('material.cp.col.validTo')]}
          rows={read.value.map((certificate) => ({
            id: certificate.id,
            cells: [
              <Link key="n" className="fw-lib-link" href={`${model.prefix}/compliance/certificates/${certificate.id}`}>
                {certificate.number}
              </Link>,
              `${certificate.standard}${certificate.ppeClass ? ` · ${certificate.ppeClass}` : ''}`,
              <span key="v" className={certificate.daysToExpiry < 0 ? 'fw-lib-danger' : certificate.daysToExpiry <= 90 ? 'fw-lib-warn' : undefined}>
                {formatDate(`${certificate.validTo}T12:00:00Z`, { locale })} · {t(`certStatus.${certificate.status}`)}
              </span>,
            ],
          }))}
        />
      )}
    </Card>
  )
}

function TestsCard({ material, model }: { material: MaterialView; model: MaterialRecordViewModel }) {
  const t = useT('library')
  const locale = useLocale()
  const read = model.lots
  return (
    <Card header={t('material.cp.tests')} description={t('material.cp.testsIntro')}>
      {!model.can.lots || read === null ? (
        <p className="fw-lib-hint">{t('material.cp.noLotsRight')}</p>
      ) : read.problem ? (
        <Banner tone="danger" title={t('material.cp.testsFailed')}>
          {t(read.problem)}
        </Banner>
      ) : read.value === null ? (
        <p className="fw-lib-hint fw-lib-inline" role="status">
          <Spinner size={12} /> {t('record.loading')}
        </p>
      ) : read.value.lots.length === 0 ? (
        <p className="fw-lib-hint">{read.value.capped ? t('material.cp.noTestsCapped', { count: LOTS_READ }) : t('material.cp.noTests')}</p>
      ) : (
        <div className="fw-lib-stack">
          <SummaryTable
            label={t('material.cp.tests')}
            stackOnPhone
            columns={[t('material.cp.col.lot'), t('material.cp.col.crvi'), t('material.cp.col.tested'), t('material.cp.col.state')]}
            rows={read.value.lots.slice(0, 20).map((lot) => ({
              id: lot.id,
              cells: [
                <Link key="l" className="fw-lib-link" href={`${model.prefix}/compliance/tests/${lot.id}`}>
                  {lot.code}
                </Link>,
                !lot.crVi.required ? (
                  t('material.cp.crviNotRequired')
                ) : (
                  <span key="c" className="fw-lib-inline">
                    <Pill tone={CR_VI_TONE[lot.crVi.status]}>{t(`crViStatus.${lot.crVi.status}`)}</Pill>
                    {lot.crVi.valueMgKg !== null ? `${numberText(Number(lot.crVi.valueMgKg), locale, 3)} / ${numberText(Number(lot.crVi.limitMgKg ?? material.crViLimitMgKg ?? 0), locale, 3)} mg/kg` : ''}
                  </span>
                ),
                lot.crVi.testedOn ? formatDate(`${lot.crVi.testedOn}T12:00:00Z`, { locale }) : '—',
                <Pill key="s" tone={LOT_TONE[lot.qualityStatus]}>
                  {t(`lotStatus.${lot.qualityStatus}`)}
                </Pill>,
              ],
            }))}
          />
          {read.value.capped && <p className="fw-lib-hint">{t('material.cp.testsCapped', { count: LOTS_READ })}</p>}
        </div>
      )}
    </Card>
  )
}
