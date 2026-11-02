'use client'

import { useId } from 'react'
import Link from 'next/link'
import { Banner, Card, Field, KeyValue } from '@nexus/ui/components'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { LegalGate, type LegalGateItem } from '@nexus/ui/components/LegalGate/index'
import { Button, CheckboxCard, Input, NumberStepper, RadioCard, Select, Toggle } from '@nexus/ui/primitives'
import { EditModeBar, Modal, StepUpModal, Textarea, useDsWords } from '../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../lib/i18n/format'
import { useLocale } from '../../../../lib/i18n/provider'
import type { StepUpState } from '../../../quality/_shared/hooks'
import type { CompanyPrivacy, GatePurpose, MonitoringBasis, PurposeView, SitePrivacy } from '../api'
import { basisCanCoverLeads, gateReasonHeld, MAX_GROUP, MIN_GROUP, noteWords, privacyDirty, privacyHeld, privacyWidens, TIME_ZONE, type PrivacyDraft } from '../model'
import { CardHead, SectionState, useRoleName, useSaid, useSettingsWords, type Section, type SettingsModel, type SettingsProblem } from './SettingsView'

export type GateDialog =
  | { kind: 'on'; site: SitePrivacy['site']; purpose: GatePurpose; siteBasis: SitePrivacy['siteBasis']; basisKind: MonitoringBasis | ''; reference: string; coversLeads: boolean; leads: boolean; reason: string; busy: boolean; problem: SettingsProblem | null }
  | { kind: 'off'; site: SitePrivacy['site']; purpose: GatePurpose; version: number; reason: string; busy: boolean; problem: SettingsProblem | null }
  | { kind: 'leads'; site: SitePrivacy['site']; version: number; reason: string; busy: boolean; problem: SettingsProblem | null }

export interface PrivacyState {
  company: Section<CompanyPrivacy>
  draft: PrivacyDraft | null
  busy: boolean
  problem: SettingsProblem | null
  sites: Section<SitePrivacy[]>
  dialog: GateDialog | null
  stepUp: StepUpState
}

export interface PrivacyActions {
  onDraft?: (patch: Partial<PrivacyDraft>) => void
  onSave?: () => void
  onDiscard?: () => void
  onSwitchOn?: (site: SitePrivacy, purpose: GatePurpose) => void
  onSwitchOff?: (site: SitePrivacy, entry: PurposeView) => void
  onLeads?: (site: SitePrivacy, entry: PurposeView, next: boolean) => void
  onDialog?: (patch: Record<string, unknown>) => void
  onDialogClose?: () => void
  onDialogConfirm?: () => void
  onStepUpSubmit?: (code: string) => void
  onStepUpCancel?: () => void
}

const BASES: readonly MonitoringBasis[] = ['UNION_AGREEMENT', 'INL_AUTHORISATION', 'NOT_REQUIRED']

/**
 * Privacy of people data (design people.settings sec:privacy; PLT-209, ANA-075, MES-249): the smallest group shown and who is
 * HR for one person's figures, then per site the legal basis read from Production › Settings, the retention link, and the
 * two legal gates (DS LegalGate): each switch held until its conditions are on record, with a fresh code to switch on. Who
 * sees one person's figures: widening needs a reason and a code, narrowing never asks.
 */
export function PrivacyCard({ model, actions, onRetry }: { model: SettingsModel; actions?: PrivacyActions; onRetry?: () => void }) {
  const t = useSettingsWords()
  const say = useSaid()
  const { company, draft, busy, problem, sites } = model.privacy
  const manage = model.can.managePrivacy
  const id = useId()
  const roleName = useRoleName()
  return (
    <Card padded>
      <div className="fw-ps-stack">
        <CardHead title={t('privacy.title')} purpose={t('privacy.purpose')} />
        <SectionState read={company} title={t('privacy.title')} onRetry={onRetry}>
          {(value) => {
            const current = draft ?? { minimumGroupSize: value.settings.minimumGroupSize, figureRoleKeys: value.settings.figureRoleKeys, reason: '' }
            const dirty = privacyDirty(value, current)
            const widens = privacyWidens(value, current)
            const held = privacyHeld(value, current)
            return (
              <div className="fw-ps-stack">
                {problem && <Banner tone="danger" title={say(problem) ?? ''} />}
                {!manage && <p className="fw-ps-hint">{t('held.noPrivacy')}</p>}
                <div className="fw-ps-fields">
                  <Field label={t('privacy.group')} hint={t('privacy.groupHint', { min: MIN_GROUP })}>
                    <NumberStepper value={current.minimumGroupSize} min={MIN_GROUP} max={MAX_GROUP} suffix={t('common.people')} disabled={!manage} onChange={(next) => actions?.onDraft?.({ minimumGroupSize: next })} />
                  </Field>
                  <fieldset className="fw-ps-roles" disabled={!manage}>
                    <legend>{t('privacy.roles')}</legend>
                    {value.roles.map((role) => (
                      <CheckboxCard
                        key={role.key}
                        variant="row"
                        title={roleName(role)}
                        selected={current.figureRoleKeys.includes(role.key)}
                        checked={current.figureRoleKeys.includes(role.key)}
                        onChange={(event) => actions?.onDraft?.({ figureRoleKeys: event.target.checked ? [...current.figureRoleKeys, role.key] : current.figureRoleKeys.filter((key) => key !== role.key) })}
                      />
                    ))}
                    <p className="fw-ps-hint">{t('privacy.rolesHint')}</p>
                  </fieldset>
                </div>
                {dirty && widens && (
                  <Field label={t('common.reason')} required htmlFor={`${id}-reason`} hint={t('privacy.widenHint')}>
                    <Textarea id={`${id}-reason`} rows={2} value={current.reason} maxLength={500} onChange={(event) => actions?.onDraft?.({ reason: event.target.value })} />
                  </Field>
                )}
                {dirty && <EditModeBar message={t('card.unsaved')} count={1} busy={busy} applyHeldReason={held ? t(held) : null} saveShortcut onDiscard={() => actions?.onDiscard?.()} onApply={() => actions?.onSave?.()} />}
              </div>
            )
          }}
        </SectionState>
        <SectionState read={sites} title={t('privacy.sites')} lines={3} onRetry={onRetry}>
          {(value) => (
            <div className="fw-ps-sites">
              {value.map((site) => (
                <SiteGates key={site.site.id} site={site} model={model} {...(actions ? { actions } : {})} />
              ))}
            </div>
          )}
        </SectionState>
      </div>
    </Card>
  )
}

function SiteGates({ site, model, actions }: { site: SitePrivacy; model: SettingsModel; actions?: PrivacyActions }) {
  const t = useSettingsWords()
  const ds = useDsWords()
  const locale = useLocale()
  const manage = model.can.managePrivacy
  const place = { locale, timeZone: TIME_ZONE }
  const day = (text: string | null | undefined) => (text ? formatDate(text.length === 10 ? `${text}T12:00:00Z` : text, place) : undefined)
  const production = `${model.prefix}/production/settings?site=${encodeURIComponent(site.site.id)}`
  const privacy = `${model.prefix}/admin/privacy`
  return (
    <section className="fw-ps-site" aria-labelledby={`fw-ps-site-${site.site.id}`}>
      <h3 id={`fw-ps-site-${site.site.id}`}>{site.site.name}</h3>
      <KeyValue
        columns={2}
        dense
        items={[
          { label: t('privacy.basis'), value: site.siteBasis ? `${t(`basis.${site.siteBasis.kind}`)} · ${site.siteBasis.reference}` : t('privacy.noBasis'), hint: <Link href={production}>{t('privacy.basisLink')}</Link> },
          { label: t('privacy.retention'), value: <Link href={privacy}>{t('privacy.retentionLink')}</Link> },
        ]}
      />
      {site.purposes.map((entry) => {
        const gate = entry.gate
        const missing = (code: string) => entry.readiness.missing.some((item) => item.code === code)
        const noticeLabel = gate?.notice.label ?? site.workerNotice?.label
        const dpia = gate?.dpia ?? site.dpia
        const onRecord = t('gate.item.onRecord')
        const items: LegalGateItem[] = [
          { id: 'notice', label: t('gate.item.notice'), state: gate || !missing('WORKER_NOTICE') ? 'met' : 'missing', law: { law: t('gate.law.notice'), plain: t('gate.law.noticePlain') }, ...(noticeLabel ? { detail: noticeLabel, recordedBy: onRecord } : {}), href: privacy, linkLabel: t('gate.item.privacyLink') },
          { id: 'dpia', label: t('gate.item.dpia'), state: gate || !missing('DPIA') ? 'met' : 'missing', law: { law: t('gate.law.dpia'), plain: t('gate.law.dpiaPlain') }, ...(dpia ? { detail: t('gate.item.dpiaVersion', { version: dpia.versionNo }), recordedBy: dpia.signedByName ?? onRecord } : {}), ...(day(dpia?.signedOn) ? { recordedAt: day(dpia?.signedOn)! } : {}), href: privacy, linkLabel: t('gate.item.privacyLink') },
          ...(entry.purpose === 'PERFORMANCE'
            ? [{ id: 'basis', label: t('gate.item.basis'), state: gate || !missing('SITE_BASIS') ? ('met' as const) : ('missing' as const), law: { law: t('gate.law.PERFORMANCE'), plain: t('gate.law.PERFORMANCEPlain') }, ...(site.siteBasis ? { detail: `${t(`basis.${site.siteBasis.kind}`)} · ${site.siteBasis.reference}`, recordedBy: onRecord } : {}), href: production, linkLabel: t('gate.item.basisLink') }]
            : gate
              ? [{ id: 'basis', label: t('gate.item.attendanceBasis'), state: 'met' as const, law: { law: t('gate.law.ATTENDANCE'), plain: t('gate.law.ATTENDANCEPlain') }, detail: `${t(`basis.${gate.basis.kind}`)} · ${gate.basis.reference}`, ...(gate.switchedOnByName ? { recordedBy: gate.switchedOnByName } : {}), ...(day(gate.switchedOnAt) ? { recordedAt: day(gate.switchedOnAt)! } : {}) }]
              : []),
        ]
        const control = entry.open ? (
          <Button size="sm" heldReason={manage ? null : t('held.noPrivacy')} onClick={() => actions?.onSwitchOff?.(site, entry)}>
            {t('gate.switchOff')}
          </Button>
        ) : !manage ? (
          <Button size="sm" heldReason={t('held.noPrivacy')}>
            {t('gate.switchOn')}
          </Button>
        ) : null
        const notes = [...entry.readiness.notes, ...entry.notes].map(noteWords)
        return (
          <div key={entry.purpose} className="fw-ps-stack tight">
            <LegalGate
              title={t(`gate.title.${entry.purpose}`)}
              items={items}
              on={entry.open}
              {...(gate ? { onSince: day(gate.switchedOnAt)! } : {})}
              {...(!entry.open && manage ? { action: { label: t('gate.switchOn'), onClick: () => actions?.onSwitchOn?.(site, entry.purpose) } } : {})}
              labels={{ ...ds.legalGate, recordedBy: (who, when) => (when ? `${who} · ${when}` : who) }}
              lawLabels={ds.lawRef}
              headingLevel={4}
            >
              {control}
            </LegalGate>
            {notes.map((note) => (
              <p key={note.key} className="fw-ps-hint">
                {t(note.key, note.params)}
              </p>
            ))}
            {entry.purpose === 'PERFORMANCE' && gate && (
              <fieldset className="fw-ps-who" disabled={!manage}>
                <legend>{t('gate.who')}</legend>
                <RadioCard name={`who-${site.site.id}`} title={t('gate.whoHr')} description={t('gate.whoHrHint')} selected={!gate.leadsSeeFigures} checked={!gate.leadsSeeFigures} onChange={() => gate.leadsSeeFigures && actions?.onLeads?.(site, entry, false)} />
                <RadioCard name={`who-${site.site.id}`} title={t('gate.whoLead')} description={gate.basisCoversLeads ? t('gate.whoLeadHint') : t('gate.whoLeadHeld')} selected={gate.leadsSeeFigures} checked={gate.leadsSeeFigures} disabled={!gate.basisCoversLeads} onChange={() => !gate.leadsSeeFigures && actions?.onLeads?.(site, entry, true)} />
              </fieldset>
            )}
          </div>
        )
      })}
    </section>
  )
}

/** Switch on (a reason, the basis; a fresh code when asked), switch off (a reason, never a code), leads see figures (a reason and a code). */
export function GateDialogs({ model, actions }: { model: SettingsModel; actions?: PrivacyActions }) {
  const t = useSettingsWords()
  const say = useSaid()
  const ds = useDsWords()
  const id = useId()
  const { dialog, stepUp } = model.privacy
  const reason = dialog ? gateReasonHeld(dialog.reason) : null
  const needsBasis = dialog?.kind === 'on' && dialog.purpose === 'ATTENDANCE'
  const held = !dialog ? null : needsBasis && (!dialog.basisKind || !dialog.reference.trim()) ? 'gate.problem.basis' : reason
  return (
    <>
      {dialog && (
        <Modal
          open
          onClose={() => actions?.onDialogClose?.()}
          title={dialog.kind === 'leads' ? t('gate.leadsTitle', { site: dialog.site.name }) : t(dialog.kind === 'on' ? 'gate.onTitle' : 'gate.offTitle', { purpose: t(`gate.title.${dialog.purpose}`), site: dialog.site.name })}
          size="md"
          footer={
            <>
              <Button variant="quiet" onClick={() => actions?.onDialogClose?.()}>
                {t('common.cancel')}
              </Button>
              <Button variant={dialog.kind === 'off' ? 'danger' : 'primary'} disabled={dialog.busy} heldReason={held ? t(held) : null} onClick={() => actions?.onDialogConfirm?.()}>
                {t(dialog.kind === 'on' ? 'gate.switchOn' : dialog.kind === 'off' ? 'gate.switchOff' : 'gate.leadsConfirm')}
              </Button>
            </>
          }
        >
          <div className="fw-ps-stack">
            {dialog.problem && <Banner tone="danger" title={say(dialog.problem) ?? ''} />}
            {dialog.kind === 'on' && (
              <>
                <p>{t(`gate.onBody.${dialog.purpose}`)}</p>
                <LawRef law={t(`gate.law.${dialog.purpose}`)} plain={t(`gate.law.${dialog.purpose}Plain`)} labels={ds.lawRef} />
                {dialog.purpose === 'ATTENDANCE' ? (
                  <div className="fw-ps-fields">
                    <Field label={t('gate.basisKind')} required htmlFor={`${id}-kind`}>
                      <Select id={`${id}-kind`} value={dialog.basisKind} onChange={(event) => actions?.onDialog?.({ basisKind: event.target.value })}>
                        <option value="">{t('gate.basisPick')}</option>
                        {BASES.map((kind) => (
                          <option key={kind} value={kind}>
                            {t(`basis.${kind}`)}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label={t('gate.basisReference')} required htmlFor={`${id}-ref`} hint={t('gate.basisReferenceHint')}>
                      <Input id={`${id}-ref`} value={dialog.reference} maxLength={1000} onChange={(event) => actions?.onDialog?.({ reference: event.target.value })} />
                    </Field>
                  </div>
                ) : (
                  <>
                    <p className="fw-ps-hint">{t('gate.siteBasis', { basis: dialog.siteBasis ? `${t(`basis.${dialog.siteBasis.kind}`)} · ${dialog.siteBasis.reference}` : t('privacy.noBasis') })}</p>
                    {basisCanCoverLeads(dialog.siteBasis?.kind) && (
                      <div className="fw-ps-fields">
                        <Field label={t('gate.covers')} hint={t('gate.coversHint')}>
                          <Toggle checked={dialog.coversLeads} aria-label={t('gate.covers')} onChange={(next) => actions?.onDialog?.({ coversLeads: next, leads: next ? dialog.leads : false })} />
                        </Field>
                        {dialog.coversLeads && (
                          <Field label={t('gate.leads')}>
                            <Toggle checked={dialog.leads} aria-label={t('gate.leads')} onChange={(next) => actions?.onDialog?.({ leads: next })} />
                          </Field>
                        )}
                      </div>
                    )}
                  </>
                )}
              </>
            )}
            {dialog.kind === 'off' && <p>{t(`gate.offBody.${dialog.purpose}`)}</p>}
            {dialog.kind === 'leads' && <p>{t('gate.leadsBody')}</p>}
            <Field label={t('common.reason')} required htmlFor={`${id}-reason`} hint={t('gate.reasonHint')}>
              <Textarea id={`${id}-reason`} rows={3} value={dialog.reason} maxLength={500} onChange={(event) => actions?.onDialog?.({ reason: event.target.value })} />
            </Field>
          </div>
        </Modal>
      )}
      <StepUpDialog state={stepUp} {...(actions ? { actions } : {})} />
    </>
  )
}

function StepUpDialog({ state, actions }: { state: StepUpState; actions?: PrivacyActions }) {
  const t = useSettingsWords()
  return <StepUpModal open={state.open} title={t('stepUp.title')} sentence={state.sentence ? t(state.sentence) : ''} busy={state.busy} error={state.problem ? t(state.problem) : null} onSubmit={(code) => actions?.onStepUpSubmit?.(code)} onClose={() => actions?.onStepUpCancel?.()} confirmLabel={t('stepUp.confirm')} />
}
