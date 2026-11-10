'use client'

import Link from 'next/link'
import { Lock } from 'lucide-react'
import { Banner, Card, Field, SummaryTable } from '@nexus/ui/components'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { Button, Pill, RadioCard, SegmentedControl, Skeleton } from '@nexus/ui/primitives'
import { EVIDENCE_RULES, type EvidenceRule } from '@nexus/factory-domain/quality/lab/rules'
import { EditModeBar, Modal, Textarea, useDsWords } from '../../../../lib/i18n/ds-parts'
import { formatTime } from '../../../../lib/i18n/format'
import { useLocale } from '../../../../lib/i18n/provider'
import { crViHeld, crViLoosens, isLowerLimit, valueOf } from '../model'
import type { Cr6Actions, Cr6State, RulesMarketsModel } from '../view-model'
import { NoTabAccess, SectionFailed, SectionLoading, WriteProblem, useWords } from './parts'

const REACH_HREF = 'https://eur-lex.europa.eu/eli/reg/2006/1907/oj'

/** A limit in mg/kg as the API keeps it ("3.000") in the page's language ("3", "1,5"). */
export const limitText = (value: string | null | undefined, locale: string): string => {
  const number = Number(value)
  return value === null || value === undefined || !Number.isFinite(number) ? '—' : number.toLocaleString(locale === 'it' ? 'it-IT' : 'en-GB', { maximumFractionDigits: 3 })
}

/**
 * Chromium VI evidence (design rm-cr6; W1 B-W1-34, Owner Q14; moved here from the tests page, same rule and step-up): what
 * counts as Cr VI evidence — a supplier's report that covers the article and the period (the default) or a lab report for every
 * lot — for this company or every company; the legal limit 3 mg/kg locked with its LawRef (REACH Annex XVII entry 47); the
 * brands' lower limits as the materials keep them; which materials need the test (a link to Products › Materials). One save
 * model: the EditModeBar (⌘S); a looser rule asks the confirm in words with the reason, then a fresh code.
 */
export function Cr6Tab({ model, state, actions }: { model: RulesMarketsModel; state: Cr6State | undefined; actions?: Cr6Actions | undefined }) {
  const t = useWords()
  const ds = useDsWords()
  const locale = useLocale()
  if (!model.can.crViView) return <NoTabAccess title={t('access.cr6Title')} body={t('access.cr6Body')} />
  const settings = state ? valueOf(state.settings) : null
  const scope = model.address.scope
  const rule = state?.draft ?? settings?.crViEvidenceRule ?? null
  const changed = !!settings && !!state?.draft && state.draft !== settings.crViEvidenceRule
  const loosens = changed && settings ? crViLoosens(settings.crViEvidenceRule, state!.draft!) : false
  const held = crViHeld({ mayManage: model.can.crViManage, changed, busy: state?.writing.busy ?? false })
  const offline = model.live === 'offline'

  const body = () => {
    if (!state || state.settings.status === 'loading') return <SectionLoading rows={3} height={56} />
    if (state.settings.status === 'error') return <SectionFailed title={t('cr6.failed')} problem={state.settings.problem} onRetry={actions?.onRetry} />
    const value = state.settings.value
    return (
      <div className="fw-rm-stack">
        {!model.can.crViManage && <p className="fw-rm-held">{t('held.crViManage')}</p>}
        <fieldset className="fw-rm-choices" disabled={!model.can.crViManage || state.writing.busy}>
          <legend className="fw-rm-question">{t('cr6.question')}</legend>
          {EVIDENCE_RULES.map((option) => (
            <RadioCard
              key={option}
              name="rm-cr6"
              checked={rule === option}
              selected={rule === option}
              onChange={() => actions?.onDraft?.(option === value.crViEvidenceRule ? null : option)}
              title={t(`cr6.option.${option}`)}
              description={t(`cr6.hint.${option}`)}
            />
          ))}
        </fieldset>
        <div className="fw-rm-inforce">
          <Pill tone={value.crViEvidenceRule === 'LOT_REPORT_REQUIRED' ? 'info' : 'neutral'}>{t(`cr6.short.${value.crViEvidenceRule}`)}</Pill>
          <span className="fw-rm-muted">{t(`cr6.source.${value.source}`)}</span>
        </div>
        {loosens && (
          <Banner tone="warning" title={t('cr6.loosens')}>
            {t('cr6.loosensBody')}
          </Banner>
        )}
        <WriteProblem writing={state.writing} />
        <p className="fw-rm-changed">{value.updatedAt ? t('common.changedAt', { time: formatTime(value.updatedAt, { locale }) }) : value.source === 'DEFAULT' ? t('common.neverChanged') : t('cr6.noOwnRow')}</p>
        {changed && (
          <EditModeBar
            count={1}
            busy={state.writing.busy}
            applyHeldReason={offline ? t('held.offline') : held && held !== 'held.busy' ? t(held) : null}
            applyLabel={loosens ? t('cr6.applyLoosen') : t('common.apply')}
            onDiscard={() => actions?.onDraft?.(null)}
            onApply={() => actions?.onApply?.()}
            saveShortcut
          />
        )}
      </div>
    )
  }

  return (
    <div className="fw-rm-grid">
      <Card
        header={t('cr6.title')}
        description={t('cr6.description')}
        headingLevel={2}
        className="fw-rm-card"
        headerAction={
          <SegmentedControl
            size="sm"
            ariaLabel={t('cr6.scope')}
            value={scope}
            onChange={(next) => actions?.onScope?.(next as 'company' | 'all')}
            options={[
              { value: 'company', label: t('cr6.scopeCompany', { company: model.companyName || t('cr6.thisCompany') }) },
              { value: 'all', label: t('cr6.scopeAll') },
            ]}
          />
        }
      >
        {body()}
      </Card>
      <div className="fw-rm-side">
        <Card header={t('cr6.limitTitle')} headingLevel={2} className="fw-rm-card">
          <div className="fw-rm-stack">
            <p className="fw-rm-locked">
              <Lock size={14} aria-hidden /> <b>{t('cr6.limit', { limit: limitText(settings?.legalLimitMgKg ?? '3', locale) })}</b> · {t('cr6.limitLocked')}
            </p>
            <LawRef law={settings?.law ?? 'REACH Annex XVII entry 47'} plain={t('cr6.lawPlain')} href={REACH_HREF} labels={ds.lawRef} />
          </div>
        </Card>
        <MaterialsCard model={model} state={state} />
      </div>
      {state?.loosen && <LoosenCr6 state={state} actions={actions} from={settings?.crViEvidenceRule ?? null} to={state.draft} />}
    </div>
  )
}

/** The brands' lower limits (the materials keep them) and which materials need the test. */
function MaterialsCard({ model, state }: { model: RulesMarketsModel; state: Cr6State | undefined }) {
  const t = useWords()
  const locale = useLocale()
  const link = (
    <Link className="fw-rm-link" href={`${model.prefix}/products/materials?view=crvi`}>
      {t('cr6.materialsLink')}
    </Link>
  )
  const body = () => {
    if (!state?.materials) return <p className="fw-rm-held">{t('cr6.materialsNoRight')}</p>
    if (state.materials.status === 'loading') return <Skeleton height={96} />
    if (state.materials.status === 'error') return <p className="fw-rm-held">{t(state.materials.problem)}</p>
    const { materials, count } = state.materials.value
    const lower = materials.filter((material) => isLowerLimit(material.crViLimitMgKg))
    return (
      <div className="fw-rm-stack">
        <p>{t('cr6.materialsCount', { count })}</p>
        {lower.length === 0 ? (
          <p className="fw-rm-muted">{t('cr6.noLowerLimits')}</p>
        ) : (
          <SummaryTable
            label={t('cr6.lowerTitle')}
            columns={[t('cr6.col.material'), t('cr6.col.limit')]}
            rows={lower.map((material) => ({ id: material.id, cells: [`${material.code} · ${material.name}`, t('cr6.mgKg', { value: limitText(material.crViLimitMgKg, locale) })] }))}
            stackOnPhone
          />
        )}
        {link}
      </div>
    )
  }
  return (
    <Card header={t('cr6.materialsTitle')} description={t('cr6.materialsDescription')} headingLevel={2} className="fw-rm-card">
      {body()}
    </Card>
  )
}

/** Confirm a looser rule (rm-loosen): what changes in words, the reason; Apply then asks a fresh code. */
function LoosenCr6({ state, actions, from, to }: { state: Cr6State; actions?: Cr6Actions | undefined; from: EvidenceRule | null; to: EvidenceRule | null }) {
  const t = useWords()
  const reason = state.loosen?.reason ?? ''
  const held = reason.trim() === '' ? t('held.reason') : null
  return (
    <Modal
      open
      onClose={() => actions?.onCancel?.()}
      title={t('loosen.title')}
      size="md"
      footer={
        <>
          <Button onClick={() => actions?.onCancel?.()}>{t('common.cancel')}</Button>
          <Button variant="primary" heldReason={state.writing.busy ? t('held.busy') : held} onClick={() => actions?.onConfirm?.()}>
            {t('loosen.apply')}
          </Button>
        </>
      }
    >
      <div className="fw-rm-form">
        <ul className="fw-rm-lines">
          <li>{t('cr6.fromNow', { from: from ? t(`cr6.short.${from}`) : '—', to: to ? t(`cr6.short.${to}`) : '—' })}</li>
        </ul>
        <p className="fw-rm-muted">{t('loosen.stepUpNote')}</p>
        <Field label={t('loosen.reason')} hint={t('loosen.reasonHint')} required>
          <Textarea value={reason} rows={3} maxLength={500} onChange={(event) => actions?.onReason?.(event.target.value)} />
        </Field>
        <WriteProblem writing={state.writing} />
      </div>
    </Modal>
  )
}
