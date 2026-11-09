'use client'

import { Lock, PenLine } from 'lucide-react'
import { Banner, Card, EmptyState, Field } from '@nexus/ui/components'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { Button, Input, Pill, Skeleton } from '@nexus/ui/primitives'
import { EditModeBar, Textarea, useDsWords } from '../../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { Severity } from '../api'
import { changedCells, draftProblems, editable, editHeld, problemAt, SEVERITY_WORDS_LIMITS, standardOf, withCell, type SeverityEdit, type SeverityWordsActions, type TextPart } from '../model'
import '../severity.css'

/**
 * B-W2b-213: Quality › Defects & dispositions › Severity (design quality.defects df-severity: "Text per class; 'Critical =
 * safety or compliance failure; never accepted (AQL 0)' locked with LawRef to Reg. 2016/425" · "EditModeBar for the
 * texts"; QHS-002). Read: the three classes in the page's language with what each allows. Edit: per class and language the
 * words and the meaning, an empty cell keeping the standard text (shown as its placeholder); critical's meaning locked with
 * its law; the EditModeBar saves the whole set (⌘S), Save held with why. Fetches nothing.
 */

export const SEVERITY_NAMESPACE = 'defects-severity'
const VOCAB = 'defects-vocab'

export interface SeverityWordsModel {
  readonly read: { readonly value: Severity | null; readonly problem: string | null }
  readonly edit: SeverityEdit | null
}

const languageName = (code: string, locale: string): string => {
  try {
    return new Intl.DisplayNames([locale], { type: 'language' }).of(code) ?? code
  } catch {
    return code
  }
}

export function SeverityWordsView({ model, actions, onRetry }: { model: SeverityWordsModel; actions?: SeverityWordsActions; onRetry?: () => void }) {
  const t = useT(SEVERITY_NAMESPACE)
  const tv = useT(VOCAB)
  const locale = useLocale()
  const ds = useDsWords()
  const { read, edit } = model
  if (read.problem) {
    return (
      <EmptyState
        title={tv('read.failed')}
        description={tv(read.problem)}
        action={
          onRetry ? (
            <Button size="sm" onClick={onRetry}>
              {tv('common.retry')}
            </Button>
          ) : undefined
        }
      />
    )
  }
  if (!read.value) return <Skeleton height={220} />
  const severity = read.value
  const say = (words: { it: string; en: string }) => (locale === 'it' ? words.it : words.en)
  const held = editHeld(severity)
  const problems = edit ? draftProblems(edit.draft) : []
  const count = edit ? changedCells(severity, edit.draft) : 0
  const own = (row: Severity['classes'][number]) => new Set([...Object.keys(row.own.words), ...Object.keys(row.own.meaning)]).size
  const cell = (row: Severity['classes'][number], part: TextPart, language: string) => {
    const value = edit!.draft[row.class]?.[part]?.[language] ?? ''
    const problem = problemAt(problems, row.class, part, language)
    const label = t(part === 'words' ? 'col.wordsIn' : 'col.meaningIn', { klass: say(row.words), language: languageName(language, locale) })
    const common = { value, placeholder: standardOf(row, part, language), 'aria-label': label, disabled: edit!.busy, onChange: (event: { target: { value: string } }) => actions?.onDraft?.(withCell(edit!.draft, row.class, part, language, event.target.value)) }
    return (
      <Field label={t(part === 'words' ? 'col.words' : 'col.meaning')} error={problem ? t(problem.key, problem.params) : undefined}>
        {part === 'words' ? <Input {...common} maxLength={SEVERITY_WORDS_LIMITS.words * 2} /> : <Textarea {...common} rows={2} />}
      </Field>
    )
  }
  return (
    <div className="fw-sev">
      <div className="fw-sev-head">
        <p className="fw-sev-intro">{t('head.intro')}</p>
        {!edit && (
          <Button heldReason={held ? t(held) : null} onClick={() => actions?.onEdit?.()}>
            <PenLine size={15} aria-hidden /> {t('edit')}
          </Button>
        )}
      </div>
      <div className={edit ? 'fw-sev-cards fw-sev-cards-edit' : 'fw-sev-cards'}>
        {severity.classes.map((row) => (
          <Card key={row.class} header={say(row.words)} headingLevel={3} headerAction={row.locked ? <Pill tone="danger">{tv('severity.locked')}</Pill> : undefined} className="fw-sev-card">
            <div className="fw-sev-stack">
              {!edit && (
                <>
                  <p>{say(row.meaning)}</p>
                  <p className="fw-sev-sub">{row.acceptanceNumber === null ? tv('severity.aql') : tv('severity.acceptance', { count: row.acceptanceNumber })}</p>
                  <p className="fw-sev-sub">{tv('severity.defects', { count: row.defects })}</p>
                  <p className="fw-sev-sub">{own(row) > 0 ? t('own', { count: own(row) }) : t('standardOnly')}</p>
                </>
              )}
              {edit && (
                <div className="fw-sev-grid">
                  {severity.languages.map((language) => (
                    <div key={language} className="fw-sev-row" role="group" aria-label={t('group', { klass: say(row.words), language: languageName(language, locale) })}>
                      <span className="fw-sev-lang">{languageName(language, locale)}</span>
                      {cell(row, 'words', language)}
                      {editable(row, 'meaning') ? (
                        cell(row, 'meaning', language)
                      ) : (
                        <span className="fw-sev-locked">
                          <Lock size={13} aria-hidden /> {language === 'it' || language === 'en' ? standardOf(row, 'meaning', language) : t('lockedMeaning')}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {row.law && (
                <span className="fw-sev-row-inline">
                  <Lock size={13} aria-hidden />
                  <LawRef law={row.law} plain={say(severity.safetyRule)} labels={ds.lawRef} />
                  {edit && <span className="fw-sev-sub">{t('lockedMeaning')}</span>}
                </span>
              )}
            </div>
          </Card>
        ))}
      </div>
      <Banner tone="info" title={say(severity.safetyRule)}>
        {tv('severity.rule')}
      </Banner>
      {edit?.problem && (
        <Banner tone="danger" title={t('problem.title')}>
          {t(edit.problem.key, edit.problem.params)}
        </Banner>
      )}
      {edit && (
        <EditModeBar
          count={count}
          message={t('unsaved', { count })}
          applyLabel={t('save')}
          busy={edit.busy}
          applyHeldReason={problems.length > 0 ? t('fixFirst', { count: problems.length }) : count === 0 ? t('nothingChanged') : null}
          onDiscard={() => actions?.onDiscard?.()}
          onApply={() => actions?.onSave?.()}
          saveShortcut
        />
      )}
    </div>
  )
}
