'use client'

import Link from 'next/link'
import { Lock } from 'lucide-react'
import { Banner, Card, EmptyState, Field } from '@nexus/ui/components'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { Button, Input, Radio, Select, Toggle } from '@nexus/ui/primitives'
import { INSPECTION_LEVELS, type InspectionLevel } from '@nexus/factory-domain/quality/aql/iso2859'
import { SAFETY_LAW } from '@nexus/factory-domain/quality/defects/severity'
import { EditModeBar, Modal, useDsWords } from '../../../../lib/i18n/ds-parts'
import { formatNumber } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { ReadState } from '../../_shared/parts'
import type { PickOption, Profile } from '../api'
import { aqlText, profileChanges, profilePlan, profilesProblems, retireProfileHeld, type ProfileDraft } from '../model'
import { AddIcon, problemAt, SectionHead, useSay } from './parts'
import type { PlansModel } from './PlansView'

export interface AqlActions {
  onProfiles?: (drafts: ProfileDraft[]) => void
  onAddProfile?: () => void
  onDiscardProfiles?: () => void
  onApplyProfiles?: () => void
  onRetryProfiles?: () => void
  onOpenAssignments?: (profileId: string) => void
  onCloseAssignments?: () => void
  onAssignSearch?: (kind: 'CUSTOMER' | 'STYLE', q: string) => void
  onAssignPick?: (kind: 'CUSTOMER' | 'STYLE', option: PickOption | null) => void
  onAssign?: () => void
  onEndAssignment?: (assignmentId: string) => void
}

const PPE_REGULATION = 'https://eur-lex.europa.eu/eli/reg/2016/425/oj'

/**
 * AQL profiles (design pl-aql, QHS-021): the saved sets per customer and style, as ONE form card with its EditModeBar
 * (⌘S): code, name, inspection level (I, II, III, S-1 … S-4), critical — always 0, locked with the law (QHS-002) —,
 * major, minor, the company's default, active; and where each applies (customers, styles, a style of one customer: its
 * own dialog, each assignment one write). The engine's sample for a lot is the AQL calculator's.
 */
export function AqlTab({ model, actions }: { model: PlansModel; actions?: AqlActions }) {
  const t = useT('quality-plans')
  const say = useSay()
  const ds = useDsWords()
  const locale = useLocale()
  const answer = model.profiles.value
  const drafts = model.profileDrafts
  if (!answer || !drafts) return <ReadState loading={!model.profiles.problem} problem={model.profiles.problem} onRetry={() => actions?.onRetryProfiles?.()} failedTitle={t('aql.failed')} rows={4} />
  const mayManage = model.can.aqlManage && !!model.companyId && answer.manageCompanyIds.includes(model.companyId)
  const plan = profilePlan(answer.profiles, drafts)
  const count = profileChanges(plan)
  const problems = profilesProblems(drafts)
  const byId = new Map(answer.profiles.map((profile) => [profile.id, profile]))
  const set = (index: number, change: Partial<ProfileDraft>) => actions?.onProfiles?.(drafts.map((draft, at) => (at === index ? { ...draft, ...change } : draft)))
  const makeDefault = (index: number) => actions?.onProfiles?.(drafts.map((draft, at) => ({ ...draft, isDefault: at === index })))
  const values = answer.aqlValues.map(aqlText)
  const held = problems.length > 0 ? t('aql.heldProblems', { count: problems.length }) : model.live === 'offline' ? t('held.offline') : null
  return (
    <section className="fw-qp-tab" aria-labelledby="fw-qp-aql">
      <Card padded>
        <SectionHead
          id="fw-qp-aql"
          title={t('aql.title')}
          sub={t('aql.sub')}
          actions={
            mayManage ? (
              <Button size="sm" onClick={() => actions?.onAddProfile?.()} heldReason={drafts.length >= 200 ? t('aql.tooMany') : null}>
                <AddIcon /> {t('aql.add')}
              </Button>
            ) : null
          }
        />
        {!mayManage && <Banner tone="info" title={t('aql.readOnly')} />}
        <p className="fw-qp-lock">
          <Lock size={12} aria-hidden /> {t('aql.criticalLocked')} <LawRef law={SAFETY_LAW} plain={t('aql.criticalLaw')} href={PPE_REGULATION} labels={ds.lawRef} />
        </p>
        {problemAt(problems, 'profiles') && problemAt(problems, 'profiles')!.path === 'profiles' && <Banner tone="warning" title={say(problemAt(problems, 'profiles'))} />}
        {drafts.length === 0 ? (
          <EmptyState title={t('aql.empty')} description={t('aql.emptyBody')} />
        ) : (
          <div className="fw-qp-profiles" role="list" aria-label={t('aql.list')}>
            {drafts.map((draft, index) => {
              const profile = draft.id ? (byId.get(draft.id) ?? null) : null
              const at = `profiles/${index}`
              const retireHeld = say(retireProfileHeld(profile, draft)) || null
              const used = profile ? profile.usedBy.customers + profile.usedBy.styles + profile.usedBy.pairs : 0
              return (
                <fieldset key={draft.key} className="fw-qp-profile" role="listitem" disabled={!mayManage}>
                  <legend className="fw-qp-profile-head">
                    <span className="fw-q-code">{draft.code || t('aql.newCode')}</span>
                    {draft.isDefault && <span className="fw-qp-muted"> · {t('aql.isDefault')}</span>}
                    {!draft.active && <span className="fw-qp-muted"> · {t('aql.retired')}</span>}
                  </legend>
                  <div className="fw-qp-profile-fields">
                    {draft.id === null ? (
                      <Field label={t('aql.code')} hint={t('aql.codeHint')} error={say(problemAt(problems, `${at}/code`)) || undefined} required>
                        <Input value={draft.code} maxLength={40} onChange={(event) => set(index, { code: event.target.value.toUpperCase() })} />
                      </Field>
                    ) : null}
                    <Field label={t('aql.name')} error={say(problemAt(problems, `${at}/name`)) || undefined} required>
                      <Input value={draft.name} maxLength={100} onChange={(event) => set(index, { name: event.target.value })} />
                    </Field>
                    <Field label={t('aql.level')}>
                      <Select value={draft.level} onChange={(event) => set(index, { level: event.target.value as InspectionLevel })}>
                        {INSPECTION_LEVELS.map((level) => (
                          <option key={level} value={level}>
                            {t(`level.${level}`)}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label={t('aql.critical')} hint={t('aql.criticalHint')}>
                      <Input value="0" readOnly aria-readonly="true" />
                    </Field>
                    <Field label={t('aql.major')} error={say(problemAt(problems, `${at}/major`)) || undefined}>
                      <Select value={draft.major} onChange={(event) => set(index, { major: event.target.value })}>
                        {values.map((value) => (
                          <option key={value} value={value}>
                            {value}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label={t('aql.minor')} error={say(problemAt(problems, `${at}/minor`)) || undefined}>
                      <Select value={draft.minor} onChange={(event) => set(index, { minor: event.target.value })}>
                        {values.map((value) => (
                          <option key={value} value={value}>
                            {value}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </div>
                  <div className="fw-qp-profile-foot">
                    <label className="fw-qp-inline">
                      <Radio name="aql-default" checked={draft.isDefault} disabled={!draft.active} onChange={() => makeDefault(index)} /> {t('aql.default')}
                    </label>
                    <span className="fw-qp-inline">
                      <Toggle
                        checked={draft.active}
                        aria-label={t('aql.active', { code: draft.code || t('aql.newCode') })}
                        disabled={!!retireHeld && draft.active}
                        title={retireHeld ?? undefined}
                        onChange={(next) => set(index, { active: next })}
                      />
                      {draft.active ? t('aql.activeOn') : t('aql.activeOff')}
                    </span>
                    {retireHeld && <span className="fw-qp-muted">{retireHeld}</span>}
                    {profile && (
                      <span className="fw-qp-used">
                        {t('aql.usedBy', {
                          customers: formatNumber(profile.usedBy.customers, locale),
                          styles: formatNumber(profile.usedBy.styles, locale),
                          pairs: formatNumber(profile.usedBy.pairs, locale),
                          inspections: formatNumber(profile.inspections, locale),
                        })}
                      </span>
                    )}
                    {profile && (
                      <Button size="sm" variant="ghost" onClick={() => actions?.onOpenAssignments?.(profile.id)} aria-label={t('aql.whereFor', { code: profile.code })}>
                        {used > 0 ? t('aql.where') : mayManage ? t('aql.assign') : t('aql.where')}
                      </Button>
                    )}
                    {!profile && (
                      <Button size="sm" variant="ghost" onClick={() => actions?.onProfiles?.(drafts.filter((_, at) => at !== index))}>
                        {t('aql.removeNew')}
                      </Button>
                    )}
                  </div>
                </fieldset>
              )
            })}
          </div>
        )}
      </Card>
      {mayManage && count > 0 && (
        <EditModeBar
          count={count}
          onDiscard={() => actions?.onDiscardProfiles?.()}
          onApply={() => actions?.onApplyProfiles?.()}
          applyLabel={model.busy === 'aql' ? t('common.saving') : t('aql.apply', { count })}
          busy={model.busy === 'aql'}
          applyHeldReason={held}
          saveShortcut
        />
      )}
      {model.assignments && <AssignmentsDialog model={model} profile={byId.get(model.assignments.profileId) ?? null} mayManage={mayManage} actions={actions} />}
    </section>
  )
}

/** Where a profile applies: its customers, styles and styles of one customer; assign it, end an assignment (one write each). */
function AssignmentsDialog({ model, profile, mayManage, actions }: { model: PlansModel; profile: Profile | null; mayManage: boolean; actions?: AqlActions }) {
  const t = useT('quality-plans')
  const dialog = model.assignments!
  const rows = dialog.read.value
  const busy = model.busy === 'assign'
  const held = !mayManage ? t('aql.readOnly') : !profile?.active ? t('aql.assignRetired') : !dialog.customer && !dialog.style ? t('aql.assignPick') : model.live === 'offline' ? t('held.offline') : null
  const picker = (kind: 'CUSTOMER' | 'STYLE', read: typeof dialog.customers, chosen: PickOption | null) => (
    <div className="fw-qp-two">
      <Field label={t(kind === 'CUSTOMER' ? 'aql.findCustomer' : 'aql.findStyle')}>
        <Input placeholder={t('chips.findHint')} onChange={(event) => actions?.onAssignSearch?.(kind, event.target.value)} />
      </Field>
      <Field label={t(kind === 'CUSTOMER' ? 'aql.customer' : 'aql.style')}>
        <Select value={chosen?.id ?? ''} onChange={(event) => actions?.onAssignPick?.(kind, read?.value?.find((option) => option.id === event.target.value) ?? null)}>
          <option value="">{read === null ? t('aql.anyKind', { kind: t(kind === 'CUSTOMER' ? 'aql.anyCustomer' : 'aql.anyStyle') }) : read.problem ? t(read.problem) : read.value === null ? t('chips.searching') : t('aql.anyKind', { kind: t(kind === 'CUSTOMER' ? 'aql.anyCustomer' : 'aql.anyStyle') })}</option>
          {chosen && !(read?.value ?? []).some((option) => option.id === chosen.id) && <option value={chosen.id}>{chosen.label}</option>}
          {(read?.value ?? []).map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </Select>
      </Field>
    </div>
  )
  return (
    <Modal
      open
      size="lg"
      title={t('aql.whereTitle', { code: profile?.code ?? '' })}
      subtitle={t('aql.whereSub')}
      onClose={() => actions?.onCloseAssignments?.()}
      footer={<Button onClick={() => actions?.onCloseAssignments?.()}>{t('common.close')}</Button>}
    >
      <div className="fw-qp-form">
        {dialog.problem && <Banner tone="danger" title={t(dialog.problem)} />}
        <ReadState loading={rows === null && !dialog.read.problem} problem={dialog.read.problem} rows={2} empty={rows && rows.length === 0 ? { title: t('aql.noAssignments'), body: t('aql.noAssignmentsBody') } : null} />
        {rows && rows.length > 0 && (
          <ul className="fw-qp-assignments" aria-label={t('aql.assignments')}>
            {rows.map((row) => (
              <li key={row.id}>
                <span>
                  {row.customer && row.style
                    ? t('aql.pair', { style: [row.style.code, row.style.name].filter(Boolean).join(' · '), customer: row.customer.name ?? '—' })
                    : row.customer
                      ? t('aql.forCustomer', { customer: row.customer.name ?? '—' })
                      : t('aql.forStyle', { style: [row.style?.code, row.style?.name].filter(Boolean).join(' · ') })}
                </span>
                {row.customer && (
                  <Link className="fw-q-link" href={`${model.prefix}/sales/customers/${encodeURIComponent(row.customer.id)}`}>
                    {t('aql.openCustomer')}
                  </Link>
                )}
                {mayManage && (
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => actions?.onEndAssignment?.(row.id)}>
                    {t('aql.end')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {mayManage && (
          <section className="fw-qp-form" aria-labelledby="fw-qp-assign">
            <h3 id="fw-qp-assign" className="fw-qp-h3">
              {t('aql.assignTitle')}
            </h3>
            <p className="fw-qp-muted">{t('aql.assignSub')}</p>
            {model.can.parties ? picker('CUSTOMER', dialog.customers, dialog.customer) : <p className="fw-qp-muted">{t('chips.kindHeld', { kind: t('kind.CUSTOMER') })}</p>}
            {model.can.styles ? picker('STYLE', dialog.styles, dialog.style) : <p className="fw-qp-muted">{t('chips.kindHeld', { kind: t('kind.STYLE') })}</p>}
            <div className="fw-qp-actions">
              <Button variant="primary" size="sm" disabled={busy} heldReason={held} onClick={() => actions?.onAssign?.()}>
                {busy ? t('common.working') : t('aql.assignDo', { code: profile?.code ?? '' })}
              </Button>
            </div>
          </section>
        )}
      </div>
    </Modal>
  )
}
