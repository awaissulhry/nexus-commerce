'use client'

import { Banner, Field } from '@nexus/ui/components'
import { Builder } from '@nexus/ui/patterns'
import { NumberStepper, RadioCard, Select } from '@nexus/ui/primitives'
import { samplingPlan, samplingProblems as aqlAskProblems } from '@nexus/factory-domain/quality/aql/sampling'
import { EditModeBar } from '../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../lib/i18n/provider'
import { AqlSummary } from '../../../_shared/aql/AqlSummary'
import type { PlanRecord, Profile } from '../../api'
import { FREQUENCIES, FREQUENCY_TAKES_VALUE, PLAN_LIMITS, type Frequency } from '../../constants'
import { aqlText, frequencyWords, versionProblems, type SamplingDraft, type StopRule } from '../../model'
import { problemAt, useSay } from '../../view/parts'
import { fieldId, ProblemList } from './ChecksTab'
import type { PlanRecordModel } from './PlanRecordView'

export interface SamplingActions {
  onSampling?: (sampling: SamplingDraft) => void
  onExampleLot?: (lot: number) => void
  onDiscardVersion?: () => void
  onSaveVersion?: () => void
}

/** The profile the example uses: the one named, else the company's default (what applies with no style or customer). */
export function exampleProfile(profiles: readonly Profile[], sampling: SamplingDraft): { profile: Profile; named: boolean } | null {
  if (sampling.method !== 'AQL_PROFILE') return null
  const named = sampling.profileId ? profiles.find((profile) => profile.id === sampling.profileId) : null
  if (named) return { profile: named, named: true }
  const fallback = profiles.find((profile) => profile.isDefault && profile.active)
  return fallback ? { profile: fallback, named: false } : null
}

/**
 * Sampling (design rec tab "sampling"): how much to inspect — an AQL profile (the one named, or the one that applies when a
 * record opens: the style's for this customer, the style's, the customer's, the company default) or a fixed number of
 * units —, how often (every lot, a share of the operations, the first piece, every Nth bundle; none: each record a person
 * opens), and when to stop (at the reject number, or the whole sample, or the company's quality setting). On the side the
 * AqlSummary of an example lot with that profile, from factory-domain's own engine. Its save is the version's.
 */
export function SamplingTab({ model, record, editable, count, actions }: { model: PlanRecordModel; record: PlanRecord; editable: boolean; count: number; actions?: SamplingActions }) {
  const t = useT('quality-plans')
  const say = useSay()
  const draft = model.draft
  if (!draft) return null
  const sampling = draft.sampling
  const set = (change: Partial<SamplingDraft>) => actions?.onSampling?.({ ...sampling, ...change })
  const problems = versionProblems(draft)
  const shownProblems = model.shown ? problems : []
  const profiles = model.profiles?.value?.profiles ?? []
  const named = sampling.profileId ? (profiles.find((profile) => profile.id === sampling.profileId) ?? null) : null
  const savedProfile = record.current.sampling.profile
  const example = exampleProfile(profiles, sampling)
  const ask = example ? { lotSize: model.exampleLot, level: example.profile.inspectionLevel, aqlMajor: aqlText(example.profile.aqlMajor), aqlMinor: aqlText(example.profile.aqlMinor) } : null
  const plan = ask && aqlAskProblems(ask).length === 0 ? samplingPlan(ask) : null
  const exampleWhy =
    sampling.method === 'FIXED'
      ? t('sampling.exampleFixed', { n: sampling.fixedSize === '' ? '—' : sampling.fixedSize })
      : model.profiles === null || model.profiles.problem
        ? t('sampling.exampleNoRead')
        : !example
          ? t('sampling.exampleNoDefault')
          : null
  const howMuch = (
    <div className="fw-qp-form">
      <fieldset className="fw-qp-radios">
        <legend className="fw-qp-legend">{t('sampling.method')}</legend>
        <RadioCard name="method" title={t('sampling.aql')} description={t('sampling.aqlHint')} checked={sampling.method === 'AQL_PROFILE'} selected={sampling.method === 'AQL_PROFILE'} disabled={!editable} onChange={() => set({ method: 'AQL_PROFILE', fixedSize: '' })} />
        <RadioCard name="method" title={t('sampling.fixed')} description={t('sampling.fixedHint')} checked={sampling.method === 'FIXED'} selected={sampling.method === 'FIXED'} disabled={!editable} onChange={() => set({ method: 'FIXED', profileId: null })} />
      </fieldset>
      {sampling.method === 'AQL_PROFILE' ? (
        <Field label={t('sampling.profile')} hint={sampling.profileId ? t('sampling.profileNamedHint') : t('sampling.profileChainHint')} error={say(problemAt(shownProblems, 'sampling/aqlProfileId')) || undefined}>
          <Select id={fieldId('sampling/aqlProfileId')} value={sampling.profileId ?? ''} disabled={!editable} onChange={(event) => set({ profileId: event.target.value || null })}>
            <option value="">{t('sampling.profileChain')}</option>
            {profiles
              .filter((profile) => profile.active || profile.id === sampling.profileId)
              .map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {t(profile.active ? 'sampling.profileOption' : 'sampling.profileRetired', { code: profile.code, name: profile.name, level: t(`level.${profile.inspectionLevel}`), major: aqlText(profile.aqlMajor), minor: aqlText(profile.aqlMinor) })}
                </option>
              ))}
            {sampling.profileId && !named && savedProfile && <option value={savedProfile.id}>{t('sampling.profileOption', { code: savedProfile.code, name: savedProfile.name, level: savedProfile.inspectionLevel, major: aqlText(savedProfile.aqlMajor), minor: aqlText(savedProfile.aqlMinor) })}</option>}
          </Select>
        </Field>
      ) : (
        <Field label={t('sampling.fixedSize')} hint={t('sampling.fixedSizeHint')} error={say(problemAt(shownProblems, 'sampling/fixedSampleSize')) || undefined}>
          <NumberStepper id={fieldId('sampling/fixedSampleSize')} value={sampling.fixedSize} min={1} max={PLAN_LIMITS.fixedSample} disabled={!editable} decrementLabel={t('common.less')} incrementLabel={t('common.more')} onChange={(value) => set({ fixedSize: value })} />
        </Field>
      )}
      {model.profiles?.problem && <Banner tone="warning" title={t(model.profiles.problem === 'problem.forbidden' ? 'sampling.profilesForbidden' : model.profiles.problem)} />}
      {named && !named.active && <Banner tone="warning" title={t('sampling.namedRetired', { code: named.code })} />}
    </div>
  )
  const often = (
    <div className="fw-qp-form">
      <div className="fw-qp-two">
        <Field label={t('sampling.frequency')} hint={t('sampling.frequencyHint')}>
          <Select value={sampling.frequency ?? ''} disabled={!editable} onChange={(event) => set({ frequency: (event.target.value || null) as Frequency | null, frequencyValue: '' })}>
            <option value="">{t('frequency.none')}</option>
            {FREQUENCIES.map((frequency) => (
              <option key={frequency} value={frequency}>
                {t(`frequencyForm.${frequency}`)}
              </option>
            ))}
          </Select>
        </Field>
        {sampling.frequency && FREQUENCY_TAKES_VALUE[sampling.frequency] && (
          <Field label={t(sampling.frequency === 'PERCENT_OF_OPERATIONS' ? 'rules.percent' : 'rules.everyN')} error={say(problemAt(shownProblems, 'sampling/frequencyValue')) || undefined}>
            <NumberStepper
              id={fieldId('sampling/frequencyValue')}
              value={sampling.frequencyValue}
              min={1}
              max={sampling.frequency === 'PERCENT_OF_OPERATIONS' ? 100 : PLAN_LIMITS.everyNth}
              suffix={sampling.frequency === 'PERCENT_OF_OPERATIONS' ? '%' : undefined}
              disabled={!editable}
              decrementLabel={t('common.less')}
              incrementLabel={t('common.more')}
              onChange={(value) => set({ frequencyValue: value })}
            />
          </Field>
        )}
      </div>
      <p className="fw-qp-muted">{t('sampling.frequencyNow', { words: say(frequencyWords(sampling.frequency, sampling.frequencyValue)) })}</p>
      {record.rules > 0 && <p className="fw-qp-muted">{t('sampling.rulesWin', { count: record.rules })}</p>}
    </div>
  )
  const stop = (
    <fieldset className="fw-qp-radios">
      <legend className="fw-qp-legend">{t('sampling.stop')}</legend>
      {(['SETTING', 'STOP', 'FINISH'] as StopRule[]).map((rule) => (
        <RadioCard key={rule} name="stop" title={t(`sampling.stop${rule}`)} description={t(`sampling.stop${rule}Hint`)} checked={sampling.stop === rule} selected={sampling.stop === rule} disabled={!editable} onChange={() => set({ stop: rule })} />
      ))}
    </fieldset>
  )
  const aside = (
    <div className="fw-qp-aside">
      <Field label={t('sampling.exampleLot')} hint={t('sampling.exampleLotHint')}>
        <NumberStepper value={model.exampleLot} min={1} max={10_000_000} decrementLabel={t('common.less')} incrementLabel={t('common.more')} onChange={(value) => actions?.onExampleLot?.(Math.max(1, Math.round(value || 1)))} />
      </Field>
      {exampleWhy ? (
        <p className="fw-qp-muted">{exampleWhy}</p>
      ) : (
        <AqlSummary
          plan={plan}
          compact
          title={t('sampling.exampleTitle')}
          source={example ? t(example.named ? 'sampling.exampleNamed' : 'sampling.exampleDefault', { code: example.profile.code, name: example.profile.name }) : undefined}
        />
      )}
      <ProblemList problems={problems.filter((entry) => entry.path.startsWith('sampling'))} record={record} dirty={count > 0} />
    </div>
  )
  return (
    <div className="fw-qp-builder">
      <Builder
        mode="page"
        navLabel={t('builder.sections')}
        asideLabel={t('sampling.exampleTitle')}
        sections={[
          { id: 'how-much', label: t('sampling.howMuch'), title: t('sampling.howMuch'), content: howMuch },
          { id: 'how-often', label: t('sampling.howOften'), title: t('sampling.howOften'), content: often },
          { id: 'stop', label: t('sampling.stopTitle'), title: t('sampling.stopTitle'), content: stop },
        ]}
        aside={aside}
        footer={
          editable && count > 0 ? (
            <EditModeBar
              count={count}
              onDiscard={() => actions?.onDiscardVersion?.()}
              onApply={() => actions?.onSaveVersion?.()}
              applyLabel={model.busy === 'save' ? t('common.saving') : t('builder.save', { number: record.current.number })}
              busy={model.busy === 'save'}
              applyHeldReason={problems.length > 0 && model.shown ? t('builder.heldProblems', { count: problems.length }) : model.live === 'offline' ? t('held.offline') : null}
              saveShortcut
            />
          ) : undefined
        }
      />
    </div>
  )
}
