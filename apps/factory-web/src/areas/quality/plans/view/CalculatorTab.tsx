'use client'

import { Card, Field } from '@nexus/ui/components'
import { NumberStepper, Select } from '@nexus/ui/primitives'
import { INSPECTION_LEVELS, type InspectionLevel } from '@nexus/factory-domain/quality/aql/iso2859'
import { useT } from '../../../../lib/i18n/provider'
import { AqlSummary } from '../../_shared/aql/AqlSummary'
import { aqlText, type CalcAsk } from '../model'
import { SectionHead } from './parts'
import type { PlansModel } from './PlansView'

export interface CalculatorActions {
  onCalc?: (ask: CalcAsk) => void
  onRetryCalc?: () => void
}

/**
 * The AQL calculator (design pl-calc, QHS-020): try a lot size and a level — or a profile — and read the code letter, the
 * sample and each class's accept and reject numbers in words (AqlSummary). A read-only tool: nothing is saved; the asks
 * stay in the address, so a link shows the same answer.
 */
export function CalculatorTab({ model, actions }: { model: PlansModel; actions?: CalculatorActions }) {
  const t = useT('quality-plans')
  const ask = model.address.calc
  const set = (change: Partial<CalcAsk>) => actions?.onCalc?.({ ...ask, ...change })
  const profiles = (model.profiles.value?.profiles ?? []).filter((profile) => profile.active)
  const values = (model.profiles.value?.aqlValues ?? ['0', '0.65', '1.0', '1.5', '2.5', '4.0', '6.5', '10']).map(aqlText)
  const chosen = profiles.find((profile) => profile.id === ask.profile) ?? null
  const pickProfile = (id: string) => {
    const profile = profiles.find((entry) => entry.id === id)
    set(profile ? { profile: profile.id, level: profile.inspectionLevel, major: aqlText(profile.aqlMajor), minor: aqlText(profile.aqlMinor) } : { profile: null })
  }
  const typed = chosen && (chosen.inspectionLevel !== ask.level || aqlText(chosen.aqlMajor) !== ask.major || aqlText(chosen.aqlMinor) !== ask.minor)
  const answer = model.calc.value
  const source = answer?.profile ? (typed ? t('calc.sourceTyped', { code: answer.profile.code }) : t('calc.sourceProfile', { code: answer.profile.code, name: answer.profile.name })) : t('calc.sourceNone')
  return (
    <section className="fw-qp-tab fw-qp-calc" aria-labelledby="fw-qp-calc">
      <Card padded>
        <SectionHead id="fw-qp-calc" title={t('calc.title')} sub={t('calc.sub')} />
        <div className="fw-qp-calc-grid">
          <div className="fw-qp-form" role="group" aria-label={t('calc.inputs')}>
            <Field label={t('calc.lot')} hint={t('calc.lotHint')}>
              <NumberStepper value={ask.lot} min={1} max={10_000_000} decrementLabel={t('common.less')} incrementLabel={t('common.more')} onChange={(value) => set({ lot: Math.max(1, Math.min(10_000_000, Math.round(value || 1))) })} />
            </Field>
            <Field label={t('calc.profile')} hint={t('calc.profileHint')}>
              <Select value={ask.profile ?? ''} onChange={(event) => pickProfile(event.target.value)}>
                <option value="">{t('calc.noProfile')}</option>
                {profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {t(profile.isDefault ? 'calc.profileDefault' : 'calc.profileOption', { code: profile.code, name: profile.name })}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('calc.level')}>
              <Select value={ask.level} onChange={(event) => set({ level: event.target.value as InspectionLevel })}>
                {INSPECTION_LEVELS.map((level) => (
                  <option key={level} value={level}>
                    {t(`level.${level}`)}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="fw-qp-two">
              <Field label={t('aql.major')}>
                <Select value={ask.major} onChange={(event) => set({ major: event.target.value })}>
                  {values.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('aql.minor')}>
                <Select value={ask.minor} onChange={(event) => set({ minor: event.target.value })}>
                  {values.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            {typed && <p className="fw-qp-muted">{t('calc.typedWins')}</p>}
          </div>
          <AqlSummary plan={answer?.plan ?? null} source={answer ? source : undefined} problem={model.calc.problem ? t(model.calc.problem) : null} onRetry={() => actions?.onRetryCalc?.()} headingLevel={3} />
        </div>
        <p className="fw-qp-muted">{t('calc.nothingSaved')}</p>
      </Card>
    </section>
  )
}
