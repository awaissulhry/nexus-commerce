'use client'

import { Camera, Lock } from 'lucide-react'
import { EmptyState, Field, OrderedList } from '@nexus/ui/components'
import { Builder } from '@nexus/ui/patterns'
import { Button, Checkbox, Input, Pill, Select } from '@nexus/ui/primitives'
import { EditModeBar, Textarea } from '../../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { PlanRecord } from '../../api'
import { CHECK_CLASSES, CHECK_TYPES, MEASURE_UOMS, PLAN_LIMITS, takesResult, type CheckClass, type CheckType } from '../../constants'
import { checksSummary, newCheck, specOf, versionProblems, withType, type CheckDraft, type Problem } from '../../model'
import { AddIcon, problemAt, useSay } from '../../view/parts'
import type { PlanRecordModel } from './PlanRecordView'

export interface ChecksActions {
  onChecks?: (checks: CheckDraft[]) => void
  onOpenCheck?: (key: string | null) => void
  onChangeNote?: (note: string) => void
  onDiscardVersion?: () => void
  onSaveVersion?: () => void
}

/** The id of a field on the page, for "Show me" (a problem's path → its control). */
export const fieldId = (path: string): string => `fw-qp-${path.replace(/[^a-zA-Z0-9]+/g, '-')}`

/**
 * Checks (design rec tab "checks", QHS-009) in Builder page mode: the ordered checks (drag or the grip's arrow keys), each
 * a line — code, words in Italian and English, type (pass/fail, measurement against nominal ± tolerance or the size chart,
 * count, choice, free text, photo, signature, instruction only), class, mandatory, photo — opened in place to change; the
 * note for the approver; on the side what the bench will see and what still stops the approval. Its save is the version's
 * (the same EditModeBar as Sampling).
 */
export function ChecksTab({ model, record, editable, count, actions }: { model: PlanRecordModel; record: PlanRecord; editable: boolean; count: number; actions?: ChecksActions }) {
  const t = useT('quality-plans')
  const say = useSay()
  const locale = useLocale()
  const draft = model.draft
  if (!draft) return null
  const checks = draft.checks
  const problems = versionProblems(draft)
  const shownProblems = model.shown ? problems : []
  const summary = checksSummary(checks)
  const byKey = new Map(checks.map((check) => [check.key, check]))
  const setCheck = (key: string, change: Partial<CheckDraft>) => actions?.onChecks?.(checks.map((check) => (check.key === key ? { ...check, ...change } : check)))
  const label = (check: CheckDraft) => (locale === 'it' ? check.labelIt : check.labelEn) || check.labelEn || check.labelIt || check.code
  const add = (type: CheckType) => {
    const next = newCheck(checks, Date.now() % 1_000_000, type)
    actions?.onChecks?.([...checks, next])
    actions?.onOpenCheck?.(next.key)
  }
  const list = (
    <div className="fw-qp-checks">
      {checks.length === 0 ? (
        <EmptyState title={t('checks.empty')} description={editable ? t('checks.emptyBody') : t('checks.emptyRead')} />
      ) : (
        <OrderedList
          label={t('checks.list')}
          keyboardGrip
          liveDrag
          disabled={!editable}
          draggable={editable}
          items={checks.map((check) => check.key)}
          itemLabel={(key) => {
            const check = byKey.get(key)
            return check ? t('checks.itemLabel', { code: check.code, label: label(check) }) : key
          }}
          onChange={(keys) => actions?.onChecks?.(keys.flatMap((key) => (byKey.has(key) ? [byKey.get(key)!] : [])))}
          renderItem={(key) => {
            const check = byKey.get(key)
            if (!check) return null
            const index = checks.indexOf(check)
            return (
              <CheckRow
                check={check}
                index={index}
                open={model.openCheck === key && editable}
                editable={editable}
                problems={problems.filter((entry) => entry.path.startsWith(`checks/${index}/`))}
                shown={model.shown}
                onChange={(change) => setCheck(key, change)}
                onToggle={() => actions?.onOpenCheck?.(model.openCheck === key ? null : key)}
                onRemove={() => actions?.onChecks?.(checks.filter((entry) => entry.key !== key))}
              />
            )
          }}
        />
      )}
      {editable && (
        <div className="fw-qp-actions">
          <Button size="sm" onClick={() => add('PASS_FAIL')} heldReason={checks.length >= PLAN_LIMITS.checks ? t('checks.tooMany', { max: PLAN_LIMITS.checks }) : null}>
            <AddIcon /> {t('checks.add')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => add('MEASUREMENT')}>
            {t('checks.addMeasure')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => add('INSTRUCTION')}>
            {t('checks.addInstruction')}
          </Button>
        </div>
      )}
    </div>
  )
  const note = (
    <Field label={t('note.label')} hint={t('note.hint')} error={say(problemAt(shownProblems, 'changeNote')) || undefined}>
      <Textarea id={fieldId('changeNote')} value={draft.changeNote} rows={3} maxLength={PLAN_LIMITS.changeNote} readOnly={!editable} onChange={(event) => actions?.onChangeNote?.(event.target.value)} />
    </Field>
  )
  const aside = (
    <div className="fw-qp-aside">
      <h3 className="fw-qp-h3">{t('bench.title')}</h3>
      <dl className="fw-qp-facts">
        <div>
          <dt>{t('bench.checks')}</dt>
          <dd>{summary.total}</dd>
        </div>
        <div>
          <dt>{t('bench.results')}</dt>
          <dd>{summary.results}</dd>
        </div>
        <div>
          <dt>{t('bench.mandatory')}</dt>
          <dd>{summary.mandatory}</dd>
        </div>
        <div>
          <dt>{t('bench.critical')}</dt>
          <dd>{summary.critical}</dd>
        </div>
        <div>
          <dt>{t('bench.photos')}</dt>
          <dd>{summary.photos}</dd>
        </div>
        <div>
          <dt>{t('bench.measures')}</dt>
          <dd>{summary.measures}</dd>
        </div>
      </dl>
      {summary.results === 0 && <p className="fw-qp-problem">{t('bench.nothingToCheck')}</p>}
      <ProblemList problems={problems} record={record} dirty={count > 0} />
    </div>
  )
  return (
    <div className="fw-qp-builder">
      <Builder
        mode="page"
        navLabel={t('builder.sections')}
        asideLabel={t('bench.title')}
        sections={[
          { id: 'checks', label: t('checks.title'), title: t('checks.title'), content: list, badge: <Pill tone="neutral">{checks.length}</Pill> },
          { id: 'note', label: t('note.title'), title: t('note.title'), content: note },
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

/** What still stops the approval (ours, then the API's own count), each with "Show me". */
export function ProblemList({ problems, record, dirty = false }: { problems: readonly Problem[]; record: PlanRecord; dirty?: boolean }) {
  const t = useT('quality-plans')
  const say = useSay()
  const apiCount = record.current.problems?.length ?? 0
  // Unsaved changes with nothing wrong here: what the server counted was before them.
  if (problems.length === 0 && apiCount > 0 && dirty) return <p className="fw-qp-muted">{t('bench.saveToCheck')}</p>
  if (problems.length === 0 && apiCount === 0) return <p className="fw-qp-muted">{record.current.status === 'DRAFT' ? t('bench.ready') : t('bench.frozen')}</p>
  return (
    <div className="fw-qp-problems" role="status">
      <p className="fw-qp-h4">{t('bench.problems', { count: Math.max(problems.length, apiCount) })}</p>
      <ul>
        {problems.slice(0, 8).map((entry) => (
          <li key={`${entry.path}-${entry.key}`}>
            <span>{t('bench.at', { where: whereOf(entry.path, t), what: say(entry) })}</span>{' '}
            <Button
              size="xs"
              variant="link"
              onClick={() => {
                const element = typeof document !== 'undefined' ? document.getElementById(fieldId(entry.path)) : null
                element?.focus()
              }}
            >
              {t('bench.showMe')}
            </Button>
          </li>
        ))}
        {problems.length === 0 && apiCount > 0 && <li>{t('bench.apiProblems', { count: apiCount })}</li>}
      </ul>
    </div>
  )
}

/** "Check 3", "Sampling", "Note": where a path points. */
function whereOf(path: string, t: (key: string, params?: Record<string, string | number>) => string): string {
  const check = /^checks\/(\d+)/.exec(path)
  if (check) return t('bench.whereCheck', { n: Number(check[1]) + 1 })
  if (path.startsWith('sampling')) return t('bench.whereSampling')
  if (path.startsWith('changeNote')) return t('bench.whereNote')
  return t('bench.whereList')
}

function CheckRow({
  check,
  index,
  open,
  editable,
  problems,
  shown,
  onChange,
  onToggle,
  onRemove,
}: {
  check: CheckDraft
  index: number
  open: boolean
  editable: boolean
  problems: readonly Problem[]
  shown: boolean
  onChange: (change: Partial<CheckDraft>) => void
  onToggle: () => void
  onRemove: () => void
}) {
  const t = useT('quality-plans')
  const say = useSay()
  const locale = useLocale()
  const at = (field: string) => `checks/${index}/${field}`
  const error = (field: string) => say(problemAt(shown ? problems : [], at(field))) || undefined
  const spec = specOf(check)
  const instruction = check.type === 'INSTRUCTION'
  const others = Object.keys(check.labelI18n)
  const main = locale === 'it' ? check.labelIt : check.labelEn
  return (
    <div className="fw-qp-check">
      <div className="fw-qp-check-line">
        <span className="fw-q-code">{check.code}</span>
        <span className="fw-qp-check-label">{main || <span className="fw-qp-muted">{t('checks.noWords')}</span>}</span>
        <span className="fw-qp-check-tags">
          <Pill tone="neutral">{t(`type.${check.type}`)}</Pill>
          {!instruction && check.checkClass && <Pill tone={check.checkClass === 'CRITICAL' ? 'danger' : check.checkClass === 'MAJOR' ? 'warning' : 'neutral'}>{t(`class.${check.checkClass}`)}</Pill>}
          {!instruction && (check.mandatory ? <span className="fw-qp-muted">{t('checks.mandatory')}</span> : <span className="fw-qp-muted">{t('checks.optional')}</span>)}
          {!instruction && check.photoRequired && (
            <span className="fw-qp-muted">
              <Camera size={12} aria-hidden /> {t('checks.photo')}
            </span>
          )}
          {spec && <span className="fw-qp-muted">{say(spec)}</span>}
          {!takesResult(check.type) && (
            <span className="fw-qp-muted">
              <Lock size={12} aria-hidden /> {t('checks.readOnly')}
            </span>
          )}
          {problems.length > 0 && (shown || !open) && <Pill tone="danger">{t('checks.problems', { count: problems.length })}</Pill>}
        </span>
        {editable && (
          <span className="fw-qp-check-buttons">
            <Button size="sm" variant="ghost" aria-expanded={open} onClick={onToggle} aria-label={t(open ? 'checks.closeFor' : 'checks.editFor', { code: check.code })}>
              {open ? t('checks.close') : t('checks.edit')}
            </Button>
            <Button size="sm" variant="ghost" onClick={onRemove} aria-label={t('checks.removeFor', { code: check.code })}>
              {t('checks.remove')}
            </Button>
          </span>
        )}
      </div>
      {open && (
        <div className="fw-qp-check-edit">
          <div className="fw-qp-three">
            <Field label={t('checks.code')} hint={t('checks.codeHint')} error={error('code')} required>
              <Input id={fieldId(at('code'))} value={check.code} maxLength={40} onChange={(event) => onChange({ code: event.target.value.toUpperCase().replace(/[\s-]+/g, '_') })} />
            </Field>
            <Field label={t('checks.type')}>
              <Select id={fieldId(at('type'))} value={check.type} onChange={(event) => onChange(withType(check, event.target.value as CheckType))}>
                {CHECK_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {t(`type.${type}`)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('checks.class')} hint={instruction ? t('checks.instructionHint') : t('checks.classHint')}>
              <Select value={check.checkClass ?? ''} disabled={instruction} onChange={(event) => onChange({ checkClass: (event.target.value || null) as CheckClass | null })}>
                <option value="">{t('checks.noClass')}</option>
                {CHECK_CLASSES.map((klass) => (
                  <option key={klass} value={klass}>
                    {t(`class.${klass}`)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="fw-qp-two">
            <Field label={t('checks.labelIt')} error={error('labelIt')} required>
              <Input id={fieldId(at('labelIt'))} value={check.labelIt} maxLength={PLAN_LIMITS.label} lang="it" onChange={(event) => onChange({ labelIt: event.target.value })} />
            </Field>
            <Field label={t('checks.labelEn')} error={error('labelEn')} required>
              <Input id={fieldId(at('labelEn'))} value={check.labelEn} maxLength={PLAN_LIMITS.label} lang="en" onChange={(event) => onChange({ labelEn: event.target.value })} />
            </Field>
          </div>
          {others.length > 0 && <p className="fw-qp-muted">{t('checks.otherLanguages', { languages: others.join(', ') })}</p>}
          {!instruction && (
            <div className="fw-qp-inline-row">
              <label className="fw-qp-inline">
                <Checkbox checked={check.mandatory} onChange={(event) => onChange({ mandatory: event.target.checked })} /> {t('checks.mandatoryLabel')}
              </label>
              <label className="fw-qp-inline">
                <Checkbox checked={check.photoRequired} onChange={(event) => onChange({ photoRequired: event.target.checked })} /> {t('checks.photoLabel')}
              </label>
            </div>
          )}
          {check.type === 'MEASUREMENT' && (
            <div className="fw-qp-three">
              <Field label={t('checks.nominal')} hint={t('checks.nominalHint')} error={error('nominal')}>
                <Input id={fieldId(at('nominal'))} inputMode="decimal" value={check.nominal} onChange={(event) => onChange({ nominal: event.target.value.replace(',', '.') })} />
              </Field>
              <Field label={t('checks.tolerance')} error={error('tolerance')}>
                <Input id={fieldId(at('tolerance'))} inputMode="decimal" value={check.tolerance} onChange={(event) => onChange({ tolerance: event.target.value.replace(',', '.') })} />
              </Field>
              <Field label={t('checks.uom')}>
                <Select value={check.uom || 'CM'} onChange={(event) => onChange({ uom: event.target.value })}>
                  {MEASURE_UOMS.map((uom) => (
                    <option key={uom} value={uom}>
                      {t(`uom.${uom}`)}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          )}
          {check.type === 'CHOICE' && (
            <fieldset className="fw-qp-choices" id={fieldId(at('choices'))} tabIndex={-1}>
              <legend className="fw-qp-legend">{t('checks.choices')}</legend>
              {error('choices') && <p className="fw-qp-problem">{error('choices')}</p>}
              {check.choices.map((choice, position) => (
                <div key={position} className="fw-qp-choice">
                  <Input aria-label={t('checks.choiceN', { n: position + 1 })} value={choice} maxLength={PLAN_LIMITS.choice} onChange={(event) => onChange({ choices: check.choices.map((entry, at2) => (at2 === position ? event.target.value : entry)) })} />
                  <Button size="sm" variant="ghost" aria-label={t('checks.choiceRemove', { n: position + 1 })} onClick={() => onChange({ choices: check.choices.filter((_, at2) => at2 !== position) })}>
                    {t('checks.remove')}
                  </Button>
                </div>
              ))}
              <Button size="sm" onClick={() => onChange({ choices: [...check.choices, ''] })} heldReason={check.choices.length >= PLAN_LIMITS.choices ? t('checks.choicesMax', { max: PLAN_LIMITS.choices }) : null}>
                <AddIcon /> {t('checks.choiceAdd')}
              </Button>
            </fieldset>
          )}
        </div>
      )}
    </div>
  )
}

