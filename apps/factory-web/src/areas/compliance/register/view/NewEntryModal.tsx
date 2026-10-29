'use client'

import { useEffect } from 'react'
import { MapPin } from 'lucide-react'
import { Banner, DateField, Field, Modal } from '@nexus/ui/components'
import { Button, RadioCard, Select, Spinner, TagInput, Textarea } from '@nexus/ui/primitives'
import { useLocale, useScopedT, useT } from '../../../../lib/i18n/provider'
import { REGISTER_KINDS, REGISTER_RISKS } from '../api'
import { canTrace, draftProblems, type NewEntryDraft, type NewEntryModel } from '../model'
import { TraceTables } from './parts'

export interface NewEntryActions {
  onDraft?: (draft: NewEntryDraft) => void
  /** Ask where the named garments are now (`POST /compliance/register/trace`). */
  onTrace?: () => void
  /** Add the entry (the container opens its record). */
  onCreate?: () => void
  onClose?: () => void
}

/**
 * New entry (design rg-new; SCR-113): what kind of event, which style and which batches or serials (as reported or
 * found), when, who reported it, what happened, whether it may present a risk, and any action already taken. "Where are
 * these garments?" previews the trace (work orders, shipments that left with their DDTs, customers) before Add, so the
 * person sees what the entry will concern. The reference is given by the company's PPE register series on Add.
 * ⌘↵ adds; Add is held with the first missing thing, never silently disabled.
 */
export function NewEntryModal({ open, model, actions }: { open: boolean; model: NewEntryModel | undefined; actions?: NewEntryActions }) {
  const t = useT('register')
  const q = useT('quality')
  // Keys of either catalogue: a refusal of the API is a `quality:problem.*` key.
  const s = useScopedT('register')
  const locale = useLocale()
  const draft = model?.draft
  const set = (patch: Partial<NewEntryDraft>) => draft && actions?.onDraft?.({ ...draft, ...patch })
  const problems = draft ? draftProblems(draft) : []
  const held = !model ? null : model.busy ? t('new.adding') : problems.length > 0 ? t(problems[0]!) : null

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !held) {
        event.preventDefault()
        actions?.onCreate?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, held, actions])

  if (!model || !draft) return null
  const styles = model.styles
  const parties = model.parties
  const traceHeld = canTrace(draft) ? (model.trace && model.trace.value === null && model.trace.problem === null ? t('new.tracing') : null) : t('new.traceNeeds')

  return (
    <Modal
      open={open}
      onClose={() => actions?.onClose?.()}
      title={t('new.title')}
      subtitle={t('new.subtitle')}
      size="lg"
      footer={
        <>
          <Button onClick={() => actions?.onClose?.()}>{q('common.cancel')}</Button>
          <Button variant="primary" heldReason={held} onClick={() => actions?.onCreate?.()}>
            {model.busy ? <Spinner size={14} /> : null} {t('new.add')}
          </Button>
        </>
      }
    >
      <div className="fw-q-form">
        {model.problem && <Banner tone="danger" title={s(model.problem)} />}
        {model.showProblems && problems.length > 0 && (
          <Banner tone="warning" title={t('new.problemsTitle')}>
            <ul className="fw-q-lines">
              {problems.map((key) => (
                <li key={key}>{t(key)}</li>
              ))}
            </ul>
          </Banner>
        )}
        {model.companies.length > 1 && (
          <Field label={t('new.company')} required>
            <Select value={draft.companyId} onChange={(event) => set({ companyId: event.target.value, styleId: '' })}>
              <option value="">{t('new.chooseCompany')}</option>
              {model.companies.map((company) => (
                <option key={company.id} value={company.id}>
                  {company.name} ({company.code})
                </option>
              ))}
            </Select>
          </Field>
        )}
        <fieldset className="fw-q-choices">
          <legend className="fw-q-hint">{t('new.kind')}</legend>
          <div className="fw-reg-kinds">
            {REGISTER_KINDS.map((kind) => (
              <RadioCard
                key={kind}
                name="register-kind"
                value={kind}
                checked={draft.kind === kind}
                selected={draft.kind === kind}
                onChange={() => set({ kind })}
                title={t(`kind.${kind}`)}
                description={t(`kindHint.${kind}`)}
              />
            ))}
          </div>
        </fieldset>
        <div className="fw-q-form-two">
          <Field
            label={t('new.style')}
            required
            hint={styles === null ? t('new.styleNoRight') : styles.problem ? s(styles.problem) : t('new.styleHint')}
          >
            <Select value={draft.styleId} onChange={(event) => set({ styleId: event.target.value })} disabled={!styles?.value}>
              <option value="">{styles?.value ? t('new.chooseStyle') : styles === null ? t('new.styleUnavailable') : styles.problem ? t('new.styleUnavailable') : q('common.loading')}</option>
              {(styles?.value ?? [])
                .filter((style) => !draft.companyId || style.companyId === null || style.companyId === draft.companyId)
                .map((style) => (
                  <option key={style.id} value={style.id}>
                    {style.code} · {style.name}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label={t('new.reportedOn')} hint={t('new.reportedOnHint')}>
            <DateField value={draft.reportedOn} onChange={(value) => set({ reportedOn: value })} max={model.today} locale={locale === 'it' ? 'it-IT' : 'en-GB'} clearable clearLabel={t('new.clearDate')} ariaLabel={t('new.reportedOn')} />
          </Field>
          <Field label={t('new.batches')} hint={t('new.batchesHint')}>
            <TagInput value={[...draft.batchNumbers]} onChange={(batchNumbers) => set({ batchNumbers })} placeholder={t('new.batchesPlaceholder')} aria-label={t('new.batches')} maxTags={50} />
          </Field>
          <Field label={t('new.serials')} hint={t('new.serialsHint')}>
            <TagInput value={[...draft.serials]} onChange={(serials) => set({ serials })} placeholder={t('new.serialsPlaceholder')} aria-label={t('new.serials')} maxTags={500} />
          </Field>
        </div>
        <div className="fw-q-actions">
          <Button size="sm" onClick={() => actions?.onTrace?.()} heldReason={traceHeld}>
            <MapPin size={14} aria-hidden /> {t('new.trace')}
          </Button>
          <span className="fw-q-hint">{t('new.traceHint')}</span>
        </div>
        {model.trace?.problem && <Banner tone="danger" title={t('new.traceFailed')}>{s(model.trace.problem)}</Banner>}
        {model.trace?.value && <TraceTables trace={model.trace.value} compact />}
        <Field label={t('new.description')} required hint={t('new.descriptionHint')}>
          <Textarea value={draft.description} onChange={(event) => set({ description: event.target.value })} rows={3} limit={4000} />
        </Field>
        <Field label={t('new.reporter')} hint={parties === null ? t('new.reporterNoRight') : parties.problem ? s(parties.problem) : t('new.reporterHint')}>
          <Select value={draft.partyId} onChange={(event) => set({ partyId: event.target.value })} disabled={!parties?.value}>
            <option value="">{t('new.noReporter')}</option>
            {(parties?.value ?? []).map((party) => (
              <option key={party.id} value={party.id}>
                {party.tradeName ?? party.legalName} ({party.code})
              </option>
            ))}
          </Select>
        </Field>
        <fieldset className="fw-q-choices">
          <legend className="fw-q-hint">{t('new.risk')}</legend>
          <div className="fw-reg-risks">
            {REGISTER_RISKS.map((risk) => (
              <RadioCard key={risk} name="register-risk" value={risk} checked={draft.risk === risk} selected={draft.risk === risk} onChange={() => set({ risk })} title={t(`risk.${risk}`)} variant="row" />
            ))}
          </div>
        </fieldset>
        <Field label={t('new.actionTaken')} hint={t('new.actionTakenHint')}>
          <Textarea value={draft.actionTaken} onChange={(event) => set({ actionTaken: event.target.value })} rows={2} limit={4000} />
        </Field>
        <p className="fw-q-hint">{t('new.reference')}</p>
      </div>
    </Modal>
  )
}
