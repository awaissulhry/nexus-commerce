'use client'

import { useId, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Plus, Save, Trash2 } from 'lucide-react'
import { Banner, Card, Field } from '@nexus/ui/components'
import { Button, Checkbox, Input, Kbd, Select, Spinner } from '@nexus/ui/primitives'
import { useExtras } from '../../../../../sales/mtm/photos/words'
import type { RulesPoint, TemplateRules } from '../../api'
import { useWords } from '../../parts'
import { changeCount, draftProblems, RULE_KINDS, RULE_SEVERITIES, saveRulesHeld, TIES, type RuleDraft, type RulesDraft } from '../model'
import type { RulesEditActions, RulesEditModel } from '../use-rules'

/**
 * Measurement template › Made-to-measure › Edit rules (B-W2b-371, XF2:05; B-W2b-248's plausibility and ratio rules, typed): each rule
 * — its code, what it compares (Order of two points: the point never above the other; Ratio: the point ÷ the other within factors;
 * Range: the point within values, in its unit), Blocks or Warns, its words in Italian and English (what the rider and the office
 * read when it breaks), kept or not checked, removed —; the base size rule (the points it is read from, in the template's order,
 * the tie); each point's inspection tolerance and alteration limits. Saved as ONE change at the template's version (⌘↵); every
 * field's problem said where it is, Save held with why before the click. Editing is open while made-to-measure is off: that is
 * when the rules are made. Fetches nothing.
 */
export function RulesEditor({ rules, model, actions, offline = false }: { rules: TemplateRules; model: RulesEditModel; actions?: RulesEditActions; offline?: boolean }) {
  const { t, say } = useExtras()
  const draft = model.draft
  if (!draft) return null
  const problems = { ...draftProblems(draft, rules.points), ...model.fields }
  const held = say(saveRulesHeld(rules, draft, model.busy, offline))
  const count = changeCount(rules, draft)
  const active = rules.points.filter((point) => point.status === 'ACTIVE')
  const onKey = (event: ReactKeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !held) {
      event.preventDefault()
      actions?.onSave?.()
    }
  }
  return (
    <div className="fw-lib-stack" onKeyDown={onKey}>
      {model.notice && <Banner tone={model.notice.tone} title={say(model.notice)} />}
      <Card padded>
        <section className="fw-lib-stack" aria-labelledby="mtx-rules">
          <div className="fw-mtt-switch">
            <h2 id="mtx-rules" className="fw-lib-title">
              {t('rules.title')}
            </h2>
            <Button size="sm" variant="secondary" heldReason={draft.rules.length >= 60 ? t('rules.held.full') : null} onClick={() => actions?.onAddRule?.()}>
              <Plus size={13} aria-hidden /> {t('rules.add')}
            </Button>
          </div>
          <p className="fw-lib-hint">{t('rules.intro')}</p>
          {problems.rules && <Banner tone="danger" title={say(problems.rules)} />}
          {draft.rules.length === 0 ? <p className="fw-lib-hint">{t('rules.none')}</p> : draft.rules.map((rule, index) => <RuleRow key={rule.key} rule={rule} index={index} points={rules.points} problems={problems} actions={actions} />)}
        </section>
      </Card>
      <Card padded>
        <section className="fw-lib-stack" aria-labelledby="mtx-base">
          <h2 id="mtx-base" className="fw-lib-title">
            {t('rules.base.title')}
          </h2>
          <p className="fw-lib-hint">{t('rules.base.intro')}</p>
          <div className="fw-mtx-limits" role="group" aria-label={t('rules.base.points')}>
            {active.map((point) => (
              <Checkbox
                key={point.code}
                checked={draft.basePoints.includes(point.code)}
                label={pointLabel(point)}
                onChange={(event) => actions?.onBasePoints?.(event.target.checked ? active.map((each) => each.code).filter((code) => code === point.code || draft.basePoints.includes(code)) : draft.basePoints.filter((code) => code !== point.code))}
              />
            ))}
          </div>
          {problems.base && <Banner tone="danger" title={say(problems.base)} />}
          <Field label={t('rules.base.tie')}>
            <Select size="sm" value={draft.tie} disabled={draft.basePoints.length === 0} onChange={(event) => actions?.onTie?.(event.target.value as RulesDraft['tie'])}>
              {TIES.map((tie) => (
                <option key={tie} value={tie}>
                  {t(`rules.tie.${tie}`)}
                </option>
              ))}
            </Select>
          </Field>
        </section>
      </Card>
      <Card padded>
        <section className="fw-lib-stack" aria-labelledby="mtx-limits">
          <h2 id="mtx-limits" className="fw-lib-title">
            {t('rules.limits.title')}
          </h2>
          <p className="fw-lib-hint">{t('rules.limits.intro')}</p>
          {draft.limits.map((limit) => {
            const point = rules.points.find((entry) => entry.code === limit.code)
            return (
              <div key={limit.code} className="fw-mtx-rule">
                <strong className="fw-mtx-rule-words">{point ? pointLabel(point) : limit.code}</strong>
                {(['tolerance', 'alterationMinus', 'alterationPlus'] as const).map((field) => (
                  <Field key={field} label={t(`rules.limits.${field}`, { unit: point?.uom.toLowerCase() ?? '' })} error={say(problems[`limit/${limit.code}/${field}`]) ?? undefined}>
                    <Input size="sm" inputMode="decimal" value={limit[field]} onChange={(event) => actions?.onLimit?.(limit.code, { [field]: event.target.value })} />
                  </Field>
                ))}
              </div>
            )
          })}
        </section>
      </Card>
      <div className="fw-mtx-rule-foot">
        <span className="fw-lib-hint">{count === 0 ? t('rules.noChange') : t('rules.changes', { count })}</span>
        <span className="fw-lib-inline">
          <Button size="sm" onClick={() => actions?.onCancel?.()}>
            {t('rules.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.onSave?.()} aria-keyshortcuts="Meta+Enter">
            {model.busy ? <Spinner size={12} /> : <Save size={13} aria-hidden />} {t('rules.save')} <Kbd>⌘↵</Kbd>
          </Button>
        </span>
      </div>
    </div>
  )
}

const pointLabel = (point: Pick<RulesPoint, 'code' | 'name' | 'uom'>): string => `${point.name} (${point.code}, ${point.uom.toLowerCase()})`

function RuleRow({ rule, index, points, problems, actions }: { rule: RuleDraft; index: number; points: readonly RulesPoint[]; problems: Readonly<Record<string, { key: string; params?: Readonly<Record<string, string | number>> }>>; actions?: RulesEditActions }) {
  const { t, say } = useExtras()
  const { t: tt } = useWords()
  const ids = { code: useId(), kind: useId(), point: useId(), other: useId(), min: useId(), max: useId(), severity: useId(), it: useId(), en: useId() }
  const problem = (field: string) => say(problems[`${rule.key}/${field}`]) ?? undefined
  const unit = points.find((point) => point.code === rule.pointCode)?.uom.toLowerCase() ?? ''
  const pointOptions = points.map((point) => (
    <option key={point.code} value={point.code}>
      {pointLabel(point)}
      {point.status === 'ACTIVE' ? '' : ` · ${t('rules.archivedPoint')}`}
    </option>
  ))
  const set = (patch: Partial<RuleDraft>) => actions?.onRule?.(rule.key, patch)
  return (
    <div className="fw-mtx-rule" role="group" aria-label={t('rules.rowLabel', { n: index + 1, code: rule.code || t('rules.newCode') })}>
      <Field label={t('rules.code')} htmlFor={ids.code} required error={problem('code')}>
        <Input id={ids.code} size="sm" value={rule.code} maxLength={60} onChange={(event) => set({ code: event.target.value })} />
      </Field>
      <Field label={t('rules.kind')} htmlFor={ids.kind} error={problem('kind')}>
        <Select id={ids.kind} size="sm" value={rule.kind} onChange={(event) => set({ kind: event.target.value as RuleDraft['kind'] })}>
          {RULE_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {tt(`kind.${kind}`)}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t('rules.point')} htmlFor={ids.point} required error={problem('pointCode')}>
        <Select id={ids.point} size="sm" value={rule.pointCode} onChange={(event) => set({ pointCode: event.target.value })}>
          <option value="">{t('rules.pick')}</option>
          {pointOptions}
        </Select>
      </Field>
      {rule.kind !== 'RANGE' && (
        <Field label={t(rule.kind === 'ORDER' ? 'rules.otherOrder' : 'rules.otherRatio')} htmlFor={ids.other} required error={problem('otherPointCode')}>
          <Select id={ids.other} size="sm" value={rule.otherPointCode} onChange={(event) => set({ otherPointCode: event.target.value })}>
            <option value="">{t('rules.pick')}</option>
            {pointOptions}
          </Select>
        </Field>
      )}
      {rule.kind === 'RATIO' && (
        <>
          <Field label={t('rules.minFactor')} htmlFor={ids.min} error={problem('minFactor')}>
            <Input id={ids.min} size="sm" inputMode="decimal" value={rule.minFactor} onChange={(event) => set({ minFactor: event.target.value })} />
          </Field>
          <Field label={t('rules.maxFactor')} htmlFor={ids.max}>
            <Input id={ids.max} size="sm" inputMode="decimal" value={rule.maxFactor} onChange={(event) => set({ maxFactor: event.target.value })} />
          </Field>
        </>
      )}
      {rule.kind === 'RANGE' && (
        <>
          <Field label={t('rules.minValue', { unit })} htmlFor={ids.min} error={problem('minValue')}>
            <Input id={ids.min} size="sm" inputMode="decimal" value={rule.minValue} onChange={(event) => set({ minValue: event.target.value })} />
          </Field>
          <Field label={t('rules.maxValue', { unit })} htmlFor={ids.max}>
            <Input id={ids.max} size="sm" inputMode="decimal" value={rule.maxValue} onChange={(event) => set({ maxValue: event.target.value })} />
          </Field>
        </>
      )}
      <Field label={t('rules.severity')} htmlFor={ids.severity}>
        <Select id={ids.severity} size="sm" value={rule.severity} onChange={(event) => set({ severity: event.target.value as RuleDraft['severity'] })}>
          {RULE_SEVERITIES.map((severity) => (
            <option key={severity} value={severity}>
              {tt(`severity.${severity}`)}
            </option>
          ))}
        </Select>
      </Field>
      <div className="fw-mtx-rule-words">
        <Field label={t('rules.wordsIt')} htmlFor={ids.it} required error={problem('messageI18n')}>
          <Input id={ids.it} size="sm" value={rule.it} maxLength={500} onChange={(event) => set({ it: event.target.value })} />
        </Field>
        <Field label={t('rules.wordsEn')} htmlFor={ids.en}>
          <Input id={ids.en} size="sm" value={rule.en} maxLength={500} onChange={(event) => set({ en: event.target.value })} />
        </Field>
      </div>
      <div className="fw-mtx-rule-foot">
        <span className="fw-lib-hint">{t(`rules.means.${rule.kind}`)}</span>
        <span className="fw-lib-inline">
          <Checkbox checked={rule.archived} label={t('rules.archived')} onChange={(event) => set({ archived: event.target.checked })} />
          <Button size="sm" variant="danger-outline" onClick={() => actions?.onRemoveRule?.(rule.key)} aria-label={t('rules.removeAria', { code: rule.code || t('rules.newCode') })}>
            <Trash2 size={13} aria-hidden /> {t('rules.remove')}
          </Button>
        </span>
      </div>
    </div>
  )
}
