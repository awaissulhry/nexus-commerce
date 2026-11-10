'use client'

import { useId, useRef } from 'react'
import { FilePlus2, Wand2 } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { LawRef } from '@nexus/ui/components/LawRef/index'
import { Button, Input, Select } from '@nexus/ui/primitives'
import { CLAIM_LIMITS, CLAIMS_LAW, type ClaimKind, type ClaimScope, type WordingFinding } from '@nexus/factory-domain/compliance/claims/rules'
import { Combobox, DateField, FileRow, Modal, Textarea, useDsWords } from '../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../lib/i18n/provider'
import type { Choices } from '../api'
import { atField, CLAIM_KINDS, CLAIM_SCOPES, draftProblems, findingsOf, FORM_LANGUAGES, suggestedValidUntil, type ClaimDraft, type Problem } from '../model'
import type { NewState, Read, SourcingPageActions, SourcingPageModel } from '../view-model'
import { languageName, useDay, useWords } from './parts'

const ACCEPT = 'application/pdf,image/jpeg,image/png'

/** One line of words: a line break typed or pasted becomes a space (the database keeps a claim to one line per language). */
const oneLine = (text: string): string => text.replace(/[\r\n]+/g, ' ')

/**
 * A claim's fields (design pop:sc-new: "Wording with a checker; scope; evidence; expiry"), for New claim and a draft's Edit: the
 * code (new only), the kind, the words per language with the checker under each (a generic or offsetting claim is refused with
 * the reason and the wording that is allowed, one click to take it; a content claim without its share is advised), the phrase it
 * is printed from, what it covers (the company, a style or a material, and which part), the evidence (files already stored, or
 * files from this device uploaded onto the claim when it is saved), until when the evidence holds (the earliest expiry of the
 * files chosen offered) and a note.
 */
export function ClaimFields({
  draft,
  choices,
  problem,
  isNew,
  canUpload,
  onDraft,
  onFiles,
  onRetryChoices,
}: {
  draft: ClaimDraft
  choices: Read<Choices> | null
  problem: Problem | null
  isNew: boolean
  canUpload: boolean
  onDraft: (draft: ClaimDraft) => void
  onFiles: (files: File[]) => void
  onRetryChoices?: (() => void) | undefined
}) {
  const t = useWords()
  const ds = useDsWords()
  const day = useDay()
  const locale = useLocale()
  const ids = useId()
  const fileInput = useRef<HTMLInputElement | null>(null)
  const ready = choices?.status === 'ready' ? choices.value : null
  const findings = findingsOf(draft)
  const set = (change: Partial<ClaimDraft>) => onDraft({ ...draft, ...change })
  const languages = [...new Set([...FORM_LANGUAGES, ...Object.keys(draft.wording)])]
  const fieldWords = (field: string) => {
    const key = atField(problem, field)
    return key ? t(key) : undefined
  }
  const suggested = suggestedValidUntil(draft, ready)
  const fileName = (id: string) => ready?.files.find((file) => file.id === id)?.name ?? t('form.storedFile')
  const fileExpiry = (id: string) => ready?.files.find((file) => file.id === id)?.expiresOn ?? null
  const options = (rows: readonly { id: string; code: string; name: string }[]) => rows.map((row) => ({ value: row.id, label: `${row.code} · ${row.name}` }))

  return (
    <div className="fw-sc-form">
      {choices?.status === 'error' && (
        <Banner
          tone="warning"
          title={t('form.choicesFailed')}
          action={
            <Button size="sm" onClick={() => onRetryChoices?.()}>
              {t('common.retry')}
            </Button>
          }
        >
          {t(choices.problem)}
        </Banner>
      )}
      <div className="fw-sc-form-grid">
        {isNew && (
          <Field label={t('form.code')} required hint={ready ? t('form.codeHint', { code: ready.nextCode }) : undefined} error={fieldWords('code')}>
            <Input value={draft.code} maxLength={CLAIM_LIMITS.code} onChange={(event) => set({ code: event.target.value })} />
          </Field>
        )}
        <Field label={t('form.kind')} required error={fieldWords('kind')}>
          <Select value={draft.kind} onChange={(event) => set({ kind: event.target.value as ClaimKind | '' })}>
            <option value="">{t('form.chooseKind')}</option>
            {CLAIM_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {t(`kind.${kind}`)}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <fieldset className="fw-sc-fieldset">
        <legend className="fw-sc-legend">
          {t('form.wording')} <LawRef law={CLAIMS_LAW} plain={t('law.claims')} labels={ds.lawRef} />
        </legend>
        {languages.map((language) => (
          <div key={language} className="fw-sc-stack">
            <Field label={t('form.wordingIn', { language: languageName(language, locale) })}>
              <Input value={draft.wording[language] ?? ''} maxLength={CLAIM_LIMITS.wording} onChange={(event) => set({ wording: { ...draft.wording, [language]: oneLine(event.target.value) } })} />
            </Field>
            {(findings[language] ?? []).map((finding, index) => (
              <FindingLine key={`${finding.code}-${index}`} finding={finding} onUse={(suggestion) => set({ wording: { ...draft.wording, [language]: suggestion } })} />
            ))}
          </div>
        ))}
        {fieldWords('wording') && <p className="fw-sc-danger-text">{fieldWords('wording')}</p>}
        {ready && ready.phrases.length > 0 && (
          <Field label={t('form.phrase')} hint={t('form.phraseHint')}>
            <Select value={draft.phraseKey} onChange={(event) => set({ phraseKey: event.target.value })}>
              <option value="">{t('form.noPhrase')}</option>
              {ready.phrases.map((phrase) => (
                <option key={phrase.key} value={phrase.key}>{`${phrase.key} · ${phrase.text}`}</option>
              ))}
            </Select>
          </Field>
        )}
      </fieldset>

      <fieldset className="fw-sc-fieldset">
        <legend className="fw-sc-legend">{t('form.scope')}</legend>
        <div className="fw-sc-form-grid">
          <Field label={t('form.covers')} required>
            <Select value={draft.scope} onChange={(event) => set({ scope: event.target.value as ClaimScope, styleId: null, itemId: null })}>
              {CLAIM_SCOPES.map((scope) => (
                <option key={scope} value={scope}>
                  {t(`scopeKind.${scope}`)}
                </option>
              ))}
            </Select>
          </Field>
          {draft.scope === 'STYLE' && (
            <Field label={t('form.style')} required error={fieldWords('styleId')}>
              <span id={`${ids}-style`} className="fw-sc-vh">
                {t('form.style')}
              </span>
              <Combobox labelledBy={`${ids}-style`} options={options(ready?.styles ?? [])} value={draft.styleId ?? ''} onChange={(value) => set({ styleId: value || null })} />
            </Field>
          )}
          {draft.scope === 'MATERIAL' && (
            <Field label={t('form.material')} required error={fieldWords('itemId')}>
              <span id={`${ids}-material`} className="fw-sc-vh">
                {t('form.material')}
              </span>
              <Combobox labelledBy={`${ids}-material`} options={options(ready?.materials ?? [])} value={draft.itemId ?? ''} onChange={(value) => set({ itemId: value || null })} />
            </Field>
          )}
        </div>
        <Field label={t('form.scopeNote')} hint={t('form.scopeNoteHint')} error={fieldWords('scopeNote')}>
          <Input value={draft.scopeNote} maxLength={CLAIM_LIMITS.scopeNote} onChange={(event) => set({ scopeNote: event.target.value })} />
        </Field>
      </fieldset>

      <fieldset className="fw-sc-fieldset">
        <legend className="fw-sc-legend">{t('form.evidence')}</legend>
        <p className="fw-sc-muted">{t('form.evidenceHint')}</p>
        {draft.evidenceFileIds.length === 0 && draft.pending.length === 0 ? (
          <p className="fw-sc-muted">{t('form.noEvidence')}</p>
        ) : (
          <div className="fw-sc-files">
            {draft.evidenceFileIds.map((id) => (
              <FileRow key={id} name={fileName(id)} status={fileExpiry(id) ? t('form.fileExpires', { date: day(fileExpiry(id)) }) : t('form.fileStored')} onRemove={() => set({ evidenceFileIds: draft.evidenceFileIds.filter((value) => value !== id) })} />
            ))}
            {draft.pending.map((file, index) => (
              <FileRow key={`${file.name}-${index}`} name={file.name} size={file.size} status={t('form.fileToUpload')} onRemove={() => onDraft({ ...draft, pending: draft.pending.filter((_, at) => at !== index) })} />
            ))}
          </div>
        )}
        {fieldWords('evidenceFileIds') && <p className="fw-sc-danger-text">{fieldWords('evidenceFileIds')}</p>}
        <div className="fw-sc-form-grid">
          <Field label={t('form.addStored')}>
            <span id={`${ids}-file`} className="fw-sc-vh">
              {t('form.addStored')}
            </span>
            <Combobox
              labelledBy={`${ids}-file`}
              options={(ready?.files ?? []).filter((file) => !draft.evidenceFileIds.includes(file.id)).map((file) => ({ value: file.id, label: file.expiresOn ? `${file.name} · ${t('form.fileExpires', { date: day(file.expiresOn) })}` : file.name }))}
              value=""
              onChange={(value) => value && set({ evidenceFileIds: [...draft.evidenceFileIds, value] })}
            />
          </Field>
          <span className="fw-sc-upload">
            <input
              ref={fileInput}
              className="fw-sc-vh"
              type="file"
              accept={ACCEPT}
              multiple
              tabIndex={-1}
              aria-hidden
              onChange={(event) => {
                const files = Array.from(event.target.files ?? [])
                if (files.length > 0) onFiles(files)
                event.target.value = ''
              }}
            />
            <Button size="sm" heldReason={canUpload ? null : t('held.upload')} onClick={() => fileInput.current?.click()}>
              <FilePlus2 size={14} aria-hidden /> {t('form.upload')}
            </Button>
            <span className="fw-sc-muted">{t('form.uploadHint')}</span>
          </span>
        </div>
      </fieldset>

      <div className="fw-sc-form-grid">
        <Field label={t('form.validUntil')} hint={suggested ? t('form.validSuggested', { date: day(suggested) }) : t('form.validHint')} error={fieldWords('validUntil')}>
          <DateField value={draft.validUntil} locale={locale === 'it' ? 'it-IT' : 'en-GB'} clearable onChange={(value) => set({ validUntil: value })} />
        </Field>
        {suggested && suggested !== draft.validUntil && (
          <span className="fw-sc-upload">
            <Button size="sm" variant="quiet" onClick={() => set({ validUntil: suggested })}>
              {t('form.useSuggested', { date: day(suggested) })}
            </Button>
          </span>
        )}
      </div>
      <Field label={t('form.note')} error={fieldWords('note')}>
        <Textarea value={draft.note} rows={2} maxLength={CLAIM_LIMITS.note} onChange={(event) => set({ note: event.target.value })} />
      </Field>
    </div>
  )
}

/** One finding of the checker: refused (danger) or advice (info), with its law and the wording offered, one click to take it. */
function FindingLine({ finding, onUse }: { finding: WordingFinding; onUse: (suggestion: string) => void }) {
  const t = useWords()
  const ds = useDsWords()
  return (
    <Banner
      tone={finding.severity === 'refuse' ? 'danger' : 'info'}
      title={t(`finding.${finding.code}`, { words: finding.words })}
      action={
        finding.suggestion ? (
          <Button size="sm" onClick={() => onUse(finding.suggestion!)}>
            <Wand2 size={13} aria-hidden /> {t('finding.use')}
          </Button>
        ) : undefined
      }
    >
      <span className="fw-sc-row">
        <LawRef law={finding.law} plain={t(`law.${finding.code}`)} labels={ds.lawRef} />
        {finding.suggestion && <span>{t('finding.suggestion', { words: finding.suggestion })}</span>}
      </span>
    </Banner>
  )
}

/** New claim (design pop:sc-new): the fields; Create draft claim held with the reason until the draft is complete. */
export function NewClaimDialog({ model, state, actions }: { model: SourcingPageModel; state: NewState; actions?: SourcingPageActions | undefined }) {
  const t = useWords()
  const problems = draftProblems(state.draft, true)
  const held = state.busy ? t('held.busy') : problems[0] ? t(problems[0].key) : null
  const opened = model.open?.read.status === 'ready' ? model.open.read.value.claim : null
  const replaces = state.draft.supersedesId ? ((model.claims.status === 'ready' ? model.claims.value.claims.find((claim) => claim.id === state.draft.supersedesId)?.code : null) ?? (opened?.id === state.draft.supersedesId ? opened.code : null)) : null
  return (
    <Modal
      open
      size="lg"
      onClose={() => actions?.onAddress?.({ add: false })}
      title={state.draft.supersedesId ? t('new.replaceTitle', { code: replaces ?? '…' }) : t('new.title')}
      subtitle={state.draft.supersedesId ? t('new.replaceSubtitle') : t('new.subtitle')}
      footer={
        <>
          <Button onClick={() => actions?.onAddress?.({ add: false })}>{t('common.cancel')}</Button>
          <Button variant="primary" heldReason={held} onClick={() => actions?.onSaveNew?.()}>
            {t('new.save')}
          </Button>
        </>
      }
    >
      <div className="fw-sc-stack">
        {state.savedWithoutFile && (
          <Banner
            tone="warning"
            title={t('new.savedWithoutFile')}
            action={
              <Button size="sm" onClick={() => actions?.onAddress?.({ add: false, open: state.savedWithoutFile })}>
                {t('new.openDraft')}
              </Button>
            }
          />
        )}
        {state.problem && !state.problem.field && <Banner tone="danger" title={t(state.problem.key)} />}
        <ClaimFields
          draft={state.draft}
          choices={state.choices}
          problem={state.problem}
          isNew
          canUpload={model.can.upload}
          onDraft={(draft) => actions?.onNewDraft?.(draft)}
          onFiles={(files) => actions?.onNewFiles?.(files)}
          onRetryChoices={actions?.onRetryChoices}
        />
      </div>
    </Modal>
  )
}
