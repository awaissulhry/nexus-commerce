'use client'

import { ChevronDown, ChevronRight, Plus, ShieldAlert, Trash2 } from 'lucide-react'
import { Card, EmptyState, Field } from '@nexus/ui/components'
import { Button, Checkbox, Input, SegmentedControl, Select, Spinner, Tag } from '@nexus/ui/primitives'
import { INSTRUCTION_LIMITS } from '@nexus/factory-domain/production/instructions/rules'
import { Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { InstructionRecord, StepView } from '../../api'
import {
  ADDABLE_LANGUAGES,
  cleanWords,
  ICON_KEYS,
  languageName,
  languagesOf,
  missingIn,
  newStep,
  NS,
  problemsAt,
  problemsOf,
  stepDraftOf,
  valueOf,
  type Problem,
  type StepDraft,
  type VersionDraft,
} from '../../model'
import { LanguageChips, StepIcon, useSay, VersionPill } from '../../view/parts'
import type { RecordModel } from './InstructionRecordView'
import { OrderedList } from '../../../../../lib/i18n/ds-parts' // B-W2b-F41: the DS parts in the page's language

export interface StepsActions {
  onDraft?: (draft: VersionDraft) => void
  onOpenStep?: (key: string | null) => void
  onLanguage?: (language: string) => void
}

/**
 * Work instruction › Steps (design rec tab `steps`, sec wi-steps; PRD-117): the ordered steps with their words per language
 * (the floor's languages; a missing one marked per step), the critical point, the safety note, the icon the tablet draws and
 * whether the tablet asks a tick before Finish; reorder by drag or keys (the grip and ↑ ↓). A version is a document: ONE
 * save for every step, its photos and videos, the change note and the ask to look again (the EditModeBar, ⌘S). Beside it:
 * the version's facts, the languages written, what still stops the save, and the operation's machine settings.
 */
export function StepsTab({ model, record, editable, actions }: { model: RecordModel; record: InstructionRecord; editable: boolean; actions?: StepsActions }) {
  const t = useT(NS)
  const say = useSay()
  const locale = useLocale()
  const shown = valueOf(model.shown)
  if (model.shown?.status === 'error')
    return (
      <Card padded>
        <EmptyState title={t('steps.failed')} description={t(model.shown.problem)} />
      </Card>
    )
  if (!shown) {
    if (model.shown === null)
      return (
        <Card padded>
          <EmptyState title={t('steps.noVersion.title')} description={t('steps.noVersion.body')} />
        </Card>
      )
    return (
      <Card padded aria-busy="true">
        <p className="fw-wi-hint fw-wi-inline" role="status">
          <Spinner size={14} /> {t('common.loading')}
        </p>
      </Card>
    )
  }
  const draft: VersionDraft = model.draft ?? { steps: [...shown.steps].sort((a, b) => a.sortOrder - b.sortOrder).map((step: StepView) => stepDraftOf(step)), changeNote: shown.version.changeNote ?? '', acknowledgementRequired: shown.version.acknowledgementRequired }
  const steps = draft.steps
  const problems = problemsOf(draft)
  const shownProblems = model.showProblems ? problems : []
  const languages = languagesOf(draft, record.floorLanguages)
  const language = languages.includes(model.language) ? model.language : (languages[0] ?? 'it')
  const byKey = new Map(steps.map((step) => [step.key, step]))
  const setStep = (key: string, change: Partial<StepDraft>) => actions?.onDraft?.({ ...draft, steps: steps.map((step) => (step.key === key ? { ...step, ...change } : step)) })
  const refusedAt = (index: number) => model.refused.some((path) => path.startsWith(`steps/${index}/`) || path === `steps/${index}`)
  const add = () => {
    const step = newStep(steps, Date.now() % 1_000_000)
    actions?.onDraft?.({ ...draft, steps: [...steps, step] })
    actions?.onOpenStep?.(step.key)
  }
  const version = shown.version
  const written = (code: string) => steps.filter((step) => (cleanWords(step.text) ?? {})[code]).length

  const list = (
    <div className="fw-wi-steps">
      <div className="fw-wi-steps-head">
        <SegmentedControl
          size="sm"
          ariaLabel={t('steps.language')}
          value={language}
          onChange={(value) => actions?.onLanguage?.(value)}
          wrap
          options={languages.map((code) => ({ value: code, label: code.toUpperCase(), title: languageName(code, locale) }))}
        />
        {editable && (
          <Select
            size="sm"
            aria-label={t('steps.addLanguage')}
            value=""
            onChange={(event) => {
              if (event.target.value) actions?.onLanguage?.(event.target.value)
            }}
          >
            <option value="">{t('steps.addLanguage')}</option>
            {ADDABLE_LANGUAGES.filter((code) => !languages.includes(code)).map((code) => (
              <option key={code} value={code}>
                {languageName(code, locale)} ({code})
              </option>
            ))}
          </Select>
        )}
        <span className="fw-wi-hint">{t('steps.writing', { language: languageName(language, locale) })}</span>
      </div>
      {steps.length === 0 ? (
        <EmptyState title={t('steps.empty')} description={editable ? t('steps.emptyBody') : t('steps.emptyRead')} />
      ) : (
        <OrderedList
          label={t('steps.list')}
          keyboardGrip
          liveDrag
          disabled={!editable}
          draggable={editable}
          items={steps.map((step) => step.key)}
          itemLabel={(key) => {
            const step = byKey.get(key)
            return step ? t('steps.itemLabel', { n: steps.indexOf(step) + 1, code: step.code }) : key
          }}
          onChange={(keys) => actions?.onDraft?.({ ...draft, steps: keys.flatMap((key) => (byKey.has(key) ? [byKey.get(key)!] : [])) })}
          renderItem={(key) => {
            const step = byKey.get(key)
            if (!step) return null
            const index = steps.indexOf(step)
            return (
              <StepRow
                step={step}
                index={index}
                language={language}
                floorLanguages={record.floorLanguages}
                open={model.openStep === key}
                editable={editable}
                problems={problemsAt(shownProblems, `steps/${index}`)}
                refused={refusedAt(index)}
                onChange={(change) => setStep(key, change)}
                onToggle={() => actions?.onOpenStep?.(model.openStep === key ? null : key)}
                onRemove={() => actions?.onDraft?.({ ...draft, steps: steps.filter((entry) => entry.key !== key) })}
              />
            )
          }}
        />
      )}
      {editable && (
        <div className="fw-wi-actions">
          <Button size="sm" onClick={add} heldReason={steps.length >= INSTRUCTION_LIMITS.steps ? t('problem.steps.tooMany', { max: INSTRUCTION_LIMITS.steps }) : null}>
            <Plus size={14} aria-hidden /> {t('steps.add')}
          </Button>
        </div>
      )}
    </div>
  )

  const aside = (
    <div className="fw-wi-aside">
      <Card padded>
        <div className="fw-wi-stack">
          <h3 className="fw-wi-h3">
            {t('steps.version', { number: version.number })} <VersionPill status={version.status} />
          </h3>
          <dl className="fw-wi-facts-list">
            <div>
              <dt>{t('version.author')}</dt>
              <dd>
                {version.author.name || '—'} · {formatDateTime(version.createdAt, { locale })}
              </dd>
            </div>
            {version.approvedBy && (
              <div>
                <dt>{t('version.approvedBy')}</dt>
                <dd>
                  {version.approvedBy.name} {version.publishedAt ? `· ${formatDateTime(version.publishedAt, { locale })}` : ''}
                </dd>
              </div>
            )}
            <div>
              <dt>{t('version.seen')}</dt>
              <dd>{version.status === 'DRAFT' ? t('version.seenDraft') : t('version.seenCount', { count: version.seen })}</dd>
            </div>
          </dl>
          <Field label={t('note.label')} hint={version.number > 1 ? t('note.hintRequired') : t('note.hint')} error={say(problemsAt(shownProblems, 'changeNote')[0]) || undefined}>
            {editable ? (
              <Textarea value={draft.changeNote} rows={3} maxLength={INSTRUCTION_LIMITS.changeNote} onChange={(event) => actions?.onDraft?.({ ...draft, changeNote: event.target.value })} />
            ) : (
              <p className="fw-wi-readvalue">{draft.changeNote || '—'}</p>
            )}
          </Field>
          <Checkbox
            checked={draft.acknowledgementRequired}
            disabled={!editable}
            onChange={(event) => actions?.onDraft?.({ ...draft, acknowledgementRequired: event.target.checked })}
            label={
              <span className="fw-wi-cell">
                <span>{t('ack.required')}</span>
                <span className="fw-wi-sub">{t('ack.requiredHint')}</span>
              </span>
            }
          />
        </div>
      </Card>
      <Card padded>
        <div className="fw-wi-stack">
          <h3 className="fw-wi-h3">{t('steps.languages')}</h3>
          <ul className="fw-wi-plain">
            {languages.map((code) => {
              const count = written(code)
              const floor = record.floorLanguages.includes(code)
              return (
                <li key={code} className="fw-wi-row-between">
                  <span>
                    {languageName(code, locale)} <span className="fw-wi-sub">({code.toUpperCase()})</span>
                  </span>
                  <span className={floor && count < steps.length ? 'fw-wi-warn' : 'fw-wi-hint'}>{t('steps.languageCount', { count, total: steps.length })}</span>
                </li>
              )
            })}
          </ul>
          <p className="fw-wi-hint">{t('steps.floorLanguages', { languages: record.floorLanguages.map((code) => code.toUpperCase()).join(', ') })}</p>
        </div>
      </Card>
      {editable && (
        <Card padded>
          <div className="fw-wi-stack">
            <h3 className="fw-wi-h3">{t('steps.problems')}</h3>
            {problems.length === 0 ? (
              <p className="fw-wi-hint fw-wi-ok">{t('steps.noProblems')}</p>
            ) : (
              <ul className="fw-wi-plain">
                {problems.map((problem) => (
                  <li key={`${problem.path}:${problem.key}`} className="fw-wi-warn">
                    {say(problem)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      )}
      {record.settings.length > 0 && (
        <Card padded>
          <div className="fw-wi-stack">
            <h3 className="fw-wi-h3">{t('settings.title')}</h3>
            {record.settings.map((setting) => (
              <dl key={setting.seq} className="fw-wi-facts-list">
                {setting.machineClass && (
                  <div>
                    <dt>{t('settings.machine')}</dt>
                    <dd>{locale === 'it' ? setting.machineClass.labelIt : setting.machineClass.labelEn}</dd>
                  </div>
                )}
                {(['stitchType', 'needle', 'thread', 'stitchesPerCm', 'tension', 'foot', 'notes'] as const).map((field) =>
                  setting[field] ? (
                    <div key={field}>
                      <dt>{t(`settings.${field}`)}</dt>
                      <dd>{setting[field]}</dd>
                    </div>
                  ) : null,
                )}
              </dl>
            ))}
          </div>
        </Card>
      )}
    </div>
  )

  return (
    <div className="fw-wi-two">
      {list}
      {aside}
    </div>
  )
}

/** One step: closed, its line (number, icon, code, words, marks, missing languages); open, its fields. */
function StepRow({
  step,
  index,
  language,
  floorLanguages,
  open,
  editable,
  problems,
  refused,
  onChange,
  onToggle,
  onRemove,
}: {
  step: StepDraft
  index: number
  language: string
  floorLanguages: readonly string[]
  open: boolean
  editable: boolean
  problems: readonly Problem[]
  refused: boolean
  onChange: (change: Partial<StepDraft>) => void
  onToggle: () => void
  onRemove: () => void
}) {
  const t = useT(NS)
  const say = useSay()
  const locale = useLocale()
  const words = step.text[language] ?? ''
  const fallback = !words.trim() ? (Object.entries(step.text).find(([, text]) => text.trim()) ?? null) : null
  const missing = missingIn(step, floorLanguages)
  const written = Object.keys(cleanWords(step.text) ?? {})
  const codeProblem = problems.find((problem) => problem.path.endsWith('/code'))
  const textProblem = problems.find((problem) => problem.path.includes('/text'))
  const safetyProblem = problems.find((problem) => problem.path.includes('/safety'))
  const id = `fw-wi-step-${step.key}`
  return (
    <div className="fw-wi-step" data-open={open ? 'true' : undefined} data-problem={problems.length > 0 || refused ? 'true' : undefined}>
      <div className="fw-wi-step-line">
        <Button size="sm" variant="quiet" aria-expanded={open} aria-controls={id} onClick={onToggle} aria-label={t(open ? 'steps.close' : 'steps.openStep', { n: index + 1, code: step.code })}>
          {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
        </Button>
        <span className="fw-wi-step-n" aria-hidden>
          {index + 1}
        </span>
        <StepIcon icon={step.icon} />
        <span className="fw-wi-cell fw-wi-grow">
          <span className="fw-wi-mono">{step.code || '—'}</span>
          <span className={words.trim() ? undefined : 'fw-wi-sub'}>{words.trim() ? words : fallback ? t('steps.onlyIn', { language: fallback[0].toUpperCase(), words: fallback[1] }) : t('steps.noWords', { language: language.toUpperCase() })}</span>
        </span>
        <span className="fw-wi-chips">
          {step.critical && <Tag tone="danger">{t('steps.critical')}</Tag>}
          {Object.keys(cleanWords(step.safety) ?? {}).length > 0 && (
            <Tag tone="warning">
              <ShieldAlert size={12} aria-hidden /> {t('steps.safety')}
            </Tag>
          )}
          <Tag tone={step.requiredTick ? 'info' : 'neutral'}>{step.requiredTick ? t('steps.tickRequired') : t('steps.tickOptional')}</Tag>
          {step.media.length > 0 && <Tag tone="neutral">{t('steps.mediaCount', { count: step.media.length })}</Tag>}
          <LanguageChips written={written} missing={missing} />
        </span>
      </div>
      {(problems.length > 0 || refused) && !open && <p className="fw-wi-hint fw-wi-warn">{problems.length > 0 ? say(problems[0]) : t('steps.refused')}</p>}
      {open && (
        <div id={id} className="fw-wi-step-body">
          <div className="fw-wi-form-grid">
            <Field label={t('steps.code')} required hint={t('steps.codeHint')} error={say(codeProblem) || undefined}>
              {editable ? <Input value={step.code} maxLength={40} onChange={(event) => onChange({ code: event.target.value.toUpperCase().replace(/\s+/g, '_') })} /> : <p className="fw-wi-readvalue fw-wi-mono">{step.code}</p>}
            </Field>
            <Field label={t('steps.icon')} hint={t('steps.iconHint')}>
              {editable ? (
                <span className="fw-wi-inline">
                  <StepIcon icon={step.icon} size={20} />
                  <Select value={step.icon ?? ''} onChange={(event) => onChange({ icon: event.target.value || null })}>
                    <option value="">{t('icon.none')}</option>
                    {ICON_KEYS.map((key) => (
                      <option key={key} value={key}>
                        {t(`icon.${key}`)}
                      </option>
                    ))}
                  </Select>
                </span>
              ) : (
                <span className="fw-wi-inline">
                  <StepIcon icon={step.icon} size={20} /> {step.icon ? t(`icon.${step.icon}`) : t('icon.none')}
                </span>
              )}
            </Field>
            <div className="fw-wi-span">
              <Field label={t('steps.words', { language: languageName(language, locale) })} required hint={t('steps.wordsHint')} error={say(textProblem) || undefined}>
                {editable ? (
                  <Textarea value={words} rows={3} maxLength={INSTRUCTION_LIMITS.words} onChange={(event) => onChange({ text: { ...step.text, [language]: event.target.value } })} />
                ) : (
                  <p className="fw-wi-readvalue">{words || '—'}</p>
                )}
              </Field>
            </div>
            <div className="fw-wi-span">
              <Field label={t('steps.safetyNote', { language: languageName(language, locale) })} hint={t('steps.safetyHint')} error={say(safetyProblem) || undefined}>
                {editable ? (
                  <Textarea value={step.safety[language] ?? ''} rows={2} maxLength={INSTRUCTION_LIMITS.safety} onChange={(event) => onChange({ safety: { ...step.safety, [language]: event.target.value } })} />
                ) : (
                  <p className="fw-wi-readvalue">{step.safety[language] || '—'}</p>
                )}
              </Field>
            </div>
            <Checkbox
              checked={step.critical}
              disabled={!editable}
              onChange={(event) => onChange({ critical: event.target.checked })}
              label={
                <span className="fw-wi-cell">
                  <span>{t('steps.criticalLabel')}</span>
                  <span className="fw-wi-sub">{t('steps.criticalHint')}</span>
                </span>
              }
            />
            <Checkbox
              checked={step.requiredTick}
              disabled={!editable}
              onChange={(event) => onChange({ requiredTick: event.target.checked })}
              label={
                <span className="fw-wi-cell">
                  <span>{t('steps.tickLabel')}</span>
                  <span className="fw-wi-sub">{t('steps.tickHint')}</span>
                </span>
              }
            />
          </div>
          {missing.length > 0 && <p className="fw-wi-hint fw-wi-warn">{t('steps.missing', { languages: missing.map((code) => languageName(code, locale)).join(', ') })}</p>}
          {editable && (
            <div className="fw-wi-actions">
              <Button size="sm" variant="danger-outline" onClick={onRemove}>
                <Trash2 size={13} aria-hidden /> {t('steps.remove')}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
