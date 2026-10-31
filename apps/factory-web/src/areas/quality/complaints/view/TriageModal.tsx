'use client'

import { useEffect, useId, useRef } from 'react'
import Link from 'next/link'
import { ChevronDown, ChevronUp, ExternalLink, ShieldAlert } from 'lucide-react'
import { Banner, DateField, Field, KeyValue, Modal } from '@nexus/ui/components'
import { DetailModal } from '@nexus/ui/patterns'
import { Button, Kbd, RadioCard, Select, Spinner, Textarea } from '@nexus/ui/primitives'
import { formatDate } from '../../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../../lib/i18n/locales'
import { useLocale } from '../../../../lib/i18n/provider'
import { COMPLAINT_CATEGORIES, COMPLAINT_SEVERITIES, type Complaint, type ComplaintCategory, type ComplaintSeverity } from '../api'
import { dayAt, evidenceHref, garmentWords, recordHref, triageProblems, type TriageField } from '../model'
import type { TriageActions, TriageModel } from '../view-model'
import { CategoryTag, InstantText, say, StatusPill, useWords } from './parts'

/**
 * Triage complaint (design quality.complaints/pop:cmp-triage, a DetailModal: `?open=<id>` on the list, or the record's
 * own Triage): the customer's words and photos, the order and serial facts, then the triage — category as RadioCards
 * (Safety / Function / Cosmetic / Fit), severity, owner, answer due, the style when the complaint names none (a safety
 * complaint needs it for the PPE register). A first Safety triage asks first (ComplaintSafetyConfirm, below): it names who
 * is told and what happens. Save and next (⌘↵), J / K walk the queue of new complaints. Each held with its reason.
 */
export function TriageModal({ model, prefix, actions }: { model: TriageModel; prefix: string; actions?: TriageActions }) {
  const t = useWords()
  const locale = useLocale()
  const loaded = model.loaded
  const complaint = loaded.status === 'ready' ? loaded.value : null
  const at = model.queue.indexOf(model.id)
  const prev = at > 0 ? model.queue[at - 1]! : null
  const next = at >= 0 && at < model.queue.length - 1 ? model.queue[at + 1]! : null
  const problems = complaint ? triageProblems(model.draft, complaint) : []
  const problemOf = (field: TriageField) => (model.showProblems ? (problems.find((entry) => entry.field === field)?.key ?? null) : null)
  const triageStep = complaint?.actions.find((entry) => entry.action === 'triage')
  const saveHeld = !complaint
    ? t('common.working')
    : model.offline
      ? t('held.offline')
      : triageStep && !triageStep.allowed
        ? t(triageStep.held === 'NO_PERMISSION' ? 'held.NO_PERMISSION.triage' : `held.${triageStep.held}`)
        : model.busy
          ? t('common.working')
          : null
  const saveLabel = model.queue.length > 1 && next ? t('triage.saveNext') : t('triage.save')

  const latest = useRef({ actions, prev, next, saveHeld })
  latest.current = { actions, prev, next, saveHeld }
  const quiet = model.confirmSafety
  useEffect(() => {
    if (quiet) return
    const onKey = (event: KeyboardEvent) => {
      const now = latest.current
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault()
        if (!now.saveHeld) now.actions?.onTriageSave?.()
        return
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target && (target.closest('input, textarea, select, [contenteditable="true"], [role="menu"], [role="listbox"]') || target.isContentEditable)) return
      const key = event.key.toLowerCase()
      if (key === 'j' && now.next) {
        event.preventDefault()
        now.actions?.onTriageGo?.(now.next)
      } else if (key === 'k' && now.prev) {
        event.preventDefault()
        now.actions?.onTriageGo?.(now.prev)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [quiet])

  return (
    <>
      <DetailModal
        open
        onClose={() => actions?.onTriageClose?.()}
        title={complaint ? t('triage.title', { number: complaint.number }) : t('triage.titleUnknown')}
        subtitle={complaint ? `${complaint.party.legalName}${complaint.customerRef ? ` · ${t('row.theirRef', { ref: complaint.customerRef })}` : ''}` : undefined}
        meta={
          complaint ? (
            <>
              <StatusPill status={complaint.status} />
              {complaint.category && <CategoryTag category={complaint.category} />}
              {model.queue.length > 1 && at >= 0 && <span className="fw-q-hint">{t('triage.position', { n: at + 1, count: model.queue.length })}</span>}
            </>
          ) : undefined
        }
        loading={loaded.status === 'loading'}
        error={loaded.status === 'error' ? t(loaded.problem) : loaded.status === 'notFound' ? t('triage.notFound') : loaded.status === 'forbidden' ? t('quality:problem.forbidden') : undefined}
        onRetry={() => actions?.onTriageRetry?.()}
        actions={
          <>
            {model.queue.length > 1 && (
              <span className="fw-q-actions">
                <Button size="sm" variant="quiet" aria-label={t('triage.prev')} heldReason={prev ? null : t('triage.first')} onClick={() => prev && actions?.onTriageGo?.(prev)} aria-keyshortcuts="k">
                  <ChevronUp size={16} aria-hidden /> <Kbd>K</Kbd>
                </Button>
                <Button size="sm" variant="quiet" aria-label={t('triage.next')} heldReason={next ? null : t('triage.last')} onClick={() => next && actions?.onTriageGo?.(next)} aria-keyshortcuts="j">
                  <ChevronDown size={16} aria-hidden /> <Kbd>J</Kbd>
                </Button>
              </span>
            )}
            {complaint && (
              <Button size="sm" asChild>
                <Link href={recordHref(prefix, complaint.id)}>{t('triage.openRecord')}</Link>
              </Button>
            )}
            <Button size="sm" variant="primary" heldReason={saveHeld} onClick={() => actions?.onTriageSave?.()} aria-keyshortcuts="Meta+Enter">
              {model.busy ? <Spinner size={12} /> : null} {saveLabel} <Kbd>⌘↵</Kbd>
            </Button>
          </>
        }
      >
        {complaint && (
          <div className="fw-cmp-triage">
            <section className="fw-cmp-triage-facts" aria-labelledby="cmp-triage-words">
              <h3 className="fw-cmp-h3" id="cmp-triage-words">
                {t('triage.words')}
              </h3>
              <p className="fw-cmp-words">{complaint.description}</p>
              <TriagePhotos model={model} />
              <h3 className="fw-cmp-h3">{t('triage.facts')}</h3>
              <KeyValue
                dense
                labelCase="sentence"
                items={[
                  { label: t('field.received'), value: <InstantText value={complaint.receivedAt} />, hint: t(`channel.${complaint.channel}`) },
                  { label: t('field.order'), value: complaint.order?.number ?? '—' },
                  { label: t('field.shipment'), value: complaint.shipment?.number ?? complaint.garment?.shipment?.number ?? '—' },
                  { label: t('field.return'), value: complaint.return?.number ?? '—' },
                  { label: t('field.style'), value: complaint.style ? `${complaint.style.code} · ${complaint.style.name}` : '—', hint: complaint.size ? t('field.sizeValue', { size: complaint.size }) : undefined },
                  { label: t('field.garment'), value: say(t, garmentWords(complaint)) || '—', hint: garmentHint(complaint, t, locale) },
                ]}
              />
              {complaint.garment && !complaint.garment.forThisCustomer && <Banner tone="warning" title={t('garment.otherCustomer')} />}
              {evidenceHref(prefix, complaint.evidence) && (
                <a className="fw-q-link" href={evidenceHref(prefix, complaint.evidence)!} target="_blank" rel="noreferrer">
                  <ExternalLink size={13} aria-hidden /> {t('record.evidence')}
                </a>
              )}
            </section>
            <TriageForm model={model} complaint={complaint} actions={actions} problemOf={problemOf} />
          </div>
        )}
      </DetailModal>
      {complaint && model.confirmSafety && <ComplaintSafetyConfirm model={model} complaint={complaint} actions={actions} />}
    </>
  )
}

function garmentHint(complaint: Complaint, t: ReturnType<typeof useWords>, locale: ReturnType<typeof useLocale>): string | undefined {
  const garment = complaint.garment
  if (!garment) return complaint.serial ? t('garment.unknownSerial') : undefined
  return t('garment.found', { day: formatDate(dayAt(garment.madeOn), { locale }), workOrder: garment.workOrderNumber, batch: garment.batchNumber ?? '—' })
}

function TriagePhotos({ model }: { model: TriageModel }) {
  const t = useWords()
  if (model.photos.length === 0) return <p className="fw-q-hint">{t('photos.none')}</p>
  return (
    <div className="fw-cmp-photos" role="list" aria-label={t('photos.label', { count: model.photos.length })}>
      {model.photos.map((photo, at) =>
        photo.src ? (
          <a key={photo.id} role="listitem" className="fw-cmp-photo" href={photo.src} target="_blank" rel="noreferrer" aria-label={t('photos.open', { n: at + 1 })}>
            <img src={photo.src} alt={t('photos.alt', { n: at + 1 })} />
          </a>
        ) : (
          <span key={photo.id} role="listitem" className="fw-q-hint">
            {t('photos.unread', { name: photo.name })}
          </span>
        ),
      )}
    </div>
  )
}

function TriageForm({ model, complaint, actions, problemOf }: { model: TriageModel; complaint: Complaint; actions?: TriageActions; problemOf: (field: TriageField) => string | null }) {
  const t = useWords()
  const locale = useLocale()
  const ids = { severity: useId(), owner: useId(), due: useId(), style: useId(), note: useId(), risk: useId(), category: useId() }
  const draft = model.draft
  const set = (patch: Partial<TriageModel['draft']>) => actions?.onTriageDraft?.(patch)
  const owners = model.people?.owners ?? null
  const safety = draft.category === 'SAFETY'
  const error = (field: TriageField) => {
    const key = problemOf(field)
    return key ? t(key) : undefined
  }
  return (
    <form
      className="fw-cmp-triage-form"
      onSubmit={(event) => {
        event.preventDefault()
        actions?.onTriageSave?.()
      }}
    >
      {model.problem && <Banner tone="danger" title={t(model.problem)} />}
      <fieldset className="fw-cmp-fieldset" aria-describedby={problemOf('category') ? ids.category : undefined}>
        <legend className="fw-cmp-h3">{t('triage.category')}</legend>
        <div className="fw-cmp-radios">
          {COMPLAINT_CATEGORIES.map((category: ComplaintCategory) => (
            <RadioCard
              key={category}
              name="cmp-category"
              value={category}
              checked={draft.category === category}
              selected={draft.category === category}
              onChange={() => set({ category })}
              title={
                <span className="fw-q-cell-row">
                  {category === 'SAFETY' && <ShieldAlert size={14} aria-hidden />} {t(`category.${category}`)}
                </span>
              }
              description={t(`categoryHint.${category}`)}
            />
          ))}
        </div>
        {problemOf('category') && (
          <p className="fw-cmp-error" id={ids.category}>
            {t(problemOf('category')!)}
          </p>
        )}
      </fieldset>
      {complaint.safety.state !== 'NONE' && (
        <Banner tone={complaint.safety.state === 'RAISED' ? 'danger' : 'info'} title={t(complaint.safety.state === 'RAISED' ? 'triage.safetyRaised' : 'triage.safetyAcknowledged')}>
          {draft.category !== 'SAFETY' ? t('triage.safetyKept') : null}
        </Banner>
      )}
      {safety && complaint.safety.state === 'NONE' && <Banner tone="warning" title={t('triage.safetyWill')} />}
      <div className="fw-q-form-two">
        <Field label={t('triage.severity')} required error={error('severity')} htmlFor={ids.severity}>
          <Select id={ids.severity} value={draft.severity ?? ''} onChange={(event) => set({ severity: (event.target.value || null) as ComplaintSeverity | null })}>
            <option value="">{t('triage.choose')}</option>
            {COMPLAINT_SEVERITIES.map((severity) => (
              <option key={severity} value={severity}>
                {t(`severity.${severity}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('triage.owner')} required error={error('ownerId') ?? (model.peopleProblem ? t(model.peopleProblem) : undefined)} hint={t('triage.ownerHint')} htmlFor={ids.owner}>
          <Select id={ids.owner} value={draft.ownerId} onChange={(event) => set({ ownerId: event.target.value })} disabled={owners === null && !model.peopleProblem}>
            <option value="">{owners === null ? t('common.loading') : t('triage.choose')}</option>
            {(owners ?? []).map((owner) => (
              <option key={owner.id} value={owner.id}>
                {owner.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('triage.answerDue')} required error={error('answerDueOn')} hint={complaint.suggestedAnswerDueOn ? t('triage.answerDueHint', { day: formatDate(dayAt(complaint.suggestedAnswerDueOn), { locale }) }) : undefined} htmlFor={ids.due}>
          <DateField id={ids.due} value={draft.answerDueOn} onChange={(value) => set({ answerDueOn: value })} locale={INTL_LOCALE[locale]} ariaLabel={t('triage.answerDue')} placeholder={t('triage.choose')} clearable={false} />
        </Field>
        {!complaint.style && (
          <Field label={t('triage.style')} required={safety} error={error('styleId')} hint={model.styles === null ? t('triage.styleNoList') : t('triage.styleHint')} htmlFor={ids.style}>
            <Select id={ids.style} value={draft.styleId} onChange={(event) => set({ styleId: event.target.value })} disabled={model.styles === null}>
              <option value="">{t('triage.choose')}</option>
              {(model.styles ?? []).map((style) => (
                <option key={style.id} value={style.id}>
                  {`${style.code} · ${style.name}`}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {safety && complaint.safety.state === 'NONE' && (
          <Field label={t('triage.risk')} hint={t('triage.riskHint')} htmlFor={ids.risk}>
            <Select id={ids.risk} value={draft.risk} onChange={(event) => set({ risk: event.target.value as 'ASSESSING' | 'YES' })}>
              <option value="ASSESSING">{t('risk.ASSESSING')}</option>
              <option value="YES">{t('risk.YES')}</option>
            </Select>
          </Field>
        )}
      </div>
      <Field label={t('triage.note')} hint={t('triage.noteHint')} error={error('note')} htmlFor={ids.note}>
        <Textarea id={ids.note} rows={2} value={draft.note} onChange={(event) => set({ note: event.target.value })} />
      </Field>
    </form>
  )
}

/**
 * The first Safety triage asks first (design: ActionConfirm "This alerts the owner and quality now and opens a PPE
 * register entry draft"). Composed from the DS Modal: the DS ActionConfirm speaks English only and its Confirm is
 * disabled, not held (named in the step's notes). It NAMES who is told and says what happens and what does not.
 */
export function ComplaintSafetyConfirm({ model, complaint, actions }: { model: TriageModel; complaint: Complaint; actions?: TriageActions }) {
  const t = useWords()
  const told = model.people?.told ?? null
  const styleId = complaint.style?.id ?? model.draft.styleId
  const style = complaint.style ?? model.styles?.find((entry) => entry.id === styleId) ?? null
  const names = told ? told.map((person) => t(`told.${person.as}`, { name: person.name })).join(', ') : null
  return (
    <Modal
      open
      onClose={() => actions?.onTriageCancelSafety?.()}
      title={t('safety.title', { number: complaint.number })}
      size="md"
      footer={
        <>
          <span className="grow" />
          <Button size="sm" onClick={() => actions?.onTriageCancelSafety?.()}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="danger" heldReason={model.busy ? t('common.working') : model.offline ? t('held.offline') : null} onClick={() => actions?.onTriageConfirmSafety?.()}>
            {model.busy ? <Spinner size={12} /> : <ShieldAlert size={14} aria-hidden />} {t('safety.confirm')}
          </Button>
        </>
      }
    >
      <div className="fw-q-stack">
        <p className="fw-q-intro">{t('safety.lead')}</p>
        <ul className="fw-q-lines fw-cmp-consequences">
          <li>
            <strong>{t('safety.toldTitle')}</strong> {names === null ? t('common.loading') : names.length > 0 ? names : t('safety.toldNobody')}
          </li>
          <li>{t('safety.register', { style: style ? `${style.code} · ${style.name}` : '—', risk: t(`risk.${model.draft.risk}`) })}</li>
          <li>{t('safety.closes')}</li>
          <li>{t('safety.notSent')}</li>
          <li>{t('safety.noHold')}</li>
        </ul>
        {model.problem && <Banner tone="danger" title={t(model.problem)} />}
      </div>
    </Modal>
  )
}
