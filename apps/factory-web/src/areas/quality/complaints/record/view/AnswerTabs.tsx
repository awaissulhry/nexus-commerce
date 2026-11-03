'use client'

import { useId } from 'react'
import Link from 'next/link'
import { ExternalLink, FileText, Pencil, RefreshCw, Send, Share2 } from 'lucide-react'
import { Banner, Field, KeyValue, Listbox } from '@nexus/ui/components'
import { PdfViewer } from '@nexus/ui/components/PdfViewer/index'
import { Button, Checkbox, Input, SegmentedControl, Spinner, Tag } from '@nexus/ui/primitives'
import { templateName } from '@nexus/factory-domain/quality/complaints/answer'
import { EditModeBar, Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { pdfViewerLabels } from '../../../../../lib/pdf/labels'
import { Section } from '../../../_shared/parts'
import { ANSWER_TEMPLATES, answerLetterHref, type AnswerCheck, type ComplaintAction, type LetterLanguage } from '../../api'
import { answerChanged, answerDraftOf, answerSaveHeld, capaWords, checkProblemKey, investigationChanged, investigationSaveHeld, personName, sendHeldKey, type SendDraft } from '../../model'
import { say, useWords } from '../../view/parts'
import { IDLE_ANSWER, type ComplaintRecordActions, type ComplaintRecordModel } from '../view-model'

/**
 * B-W2b-113 (QHS-116; design quality.complaints record tabs "Investigation" and "Answer", the new tab "Answer letter (PDF)"):
 *
 *   Investigation  what the investigation found and the root cause in words (EditModeBar; office only — never printed or
 *                  sent), beside what it is linked to: the returned garment's return, the NCRs, the CAPA.
 *   Answer         the letter from a template (Listbox) in the customer's language (it / en), its words, the complaint's
 *                  files that go with it (each says whether the customer may get it; one not shared is shared here), Save,
 *                  the PDF as the customer would get it (DS PdfViewer, the "preview" banner; a new tab too) and Send… —
 *                  a review before anything goes (never by itself). Once sent: when, who and how, the letter frozen until
 *                  the complaint goes back to investigating, and the version sent opened in a new tab.
 * Every step held says why (the API's held code in our words). Fetches nothing.
 */

type Held = (action: ComplaintAction) => string | null

export function InvestigationTab({ model, actions, held }: { model: ComplaintRecordModel; actions?: ComplaintRecordActions; held: Held }) {
  const t = useWords()
  const complaint = model.complaint
  const edit = model.investigation ?? null
  const ids = { findings: useId(), rootCause: useId() }
  const editHeld = held('investigate')
  const href = (type: string, id: string) => model.hrefs[`${type}:${id}`] ?? `${model.prefix}/records/${encodeURIComponent(type)}/${encodeURIComponent(id)}`
  const saveHeld = edit ? (edit.busy ? t('common.working') : model.offline ? t('held.offline') : (() => { const key = investigationSaveHeld(edit.draft, complaint); return key ? t(key) : null })()) : null
  const changed = edit ? investigationChanged(edit.draft, complaint) : false
  const capa = capaWords(complaint, model.can)
  return (
    <div className="fw-cmp-two">
      <Section
        id="cmp-inv"
        title={t('investigation.title')}
        sub={t('investigation.sub')}
        actions={
          edit ? undefined : (
            <Button size="sm" heldReason={editHeld} onClick={() => actions?.onInvestigationEdit?.(true)}>
              <Pencil size={13} aria-hidden /> {t('record.edit')}
            </Button>
          )
        }
      >
        {edit ? (
          <div className="fw-q-stack">
            {edit.problem && <Banner tone="danger" title={t(edit.problem)} />}
            <Field label={t('investigation.findings')} hint={t('investigation.findingsHint')} htmlFor={ids.findings}>
              <Textarea id={ids.findings} rows={7} value={edit.draft.findings} onChange={(event) => actions?.onInvestigationDraft?.({ findings: event.target.value })} />
            </Field>
            <Field label={t('investigation.rootCause')} hint={t('investigation.rootCauseHint')} htmlFor={ids.rootCause}>
              <Textarea id={ids.rootCause} rows={4} value={edit.draft.rootCause} onChange={(event) => actions?.onInvestigationDraft?.({ rootCause: event.target.value })} />
            </Field>
            <EditModeBar
              message={changed ? t('record.editUnsaved') : t('record.editNothing')}
              count={changed ? 1 : 0}
              onDiscard={() => actions?.onInvestigationEdit?.(false)}
              onApply={() => actions?.onInvestigationSave?.()}
              applyLabel={t('investigation.save')}
              busy={edit.busy}
              applyHeldReason={saveHeld}
              saveShortcut
            />
          </div>
        ) : (
          <div className="fw-q-stack">
            {editHeld && complaint.status === 'NEW' && <Banner tone="info" title={editHeld} />}
            <div>
              <h3 className="fw-cmp-h3">{t('investigation.findings')}</h3>
              <p className={complaint.findings ? 'fw-cmp-words' : 'fw-q-hint'}>{complaint.findings ?? t('investigation.noFindings')}</p>
            </div>
            <div>
              <h3 className="fw-cmp-h3">{t('investigation.rootCause')}</h3>
              <p className={complaint.rootCause ? 'fw-cmp-words' : 'fw-q-hint'}>{complaint.rootCause ?? t('investigation.noRootCause')}</p>
            </div>
            <p className="fw-q-hint">{t('investigation.officeOnly')}</p>
          </div>
        )}
      </Section>
      <Section id="cmp-inv-links" title={t('investigation.linksTitle')} sub={t('investigation.linksSub')}>
        <div className="fw-cmp-links">
          <section className="fw-cmp-link-group" aria-labelledby="cmp-inv-return">
            <h3 className="fw-cmp-h3" id="cmp-inv-return">
              {t('investigation.return')}
            </h3>
            {complaint.return ? (
              <p className="fw-q-cell-row">
                <Link className="fw-q-link fw-q-code" href={href('ReturnAuthorisation', complaint.return.id)}>
                  {complaint.return.number}
                </Link>
                <span className="fw-q-hint">{t('investigation.returnHint')}</span>
              </p>
            ) : (
              <p className="fw-q-hint">{t('investigation.noReturn')}</p>
            )}
          </section>
          <section className="fw-cmp-link-group" aria-labelledby="cmp-inv-ncr">
            <h3 className="fw-cmp-h3" id="cmp-inv-ncr">
              {t('linked.ncr')}
            </h3>
            {complaint.ncrs.length === 0 ? (
              <p className="fw-q-hint">{model.can.ncrView ? t('linked.ncrNone') : t('linked.ncrNoRight')}</p>
            ) : (
              <ul>
                {complaint.ncrs.map((ncr) => (
                  <li key={ncr.id} className="fw-q-cell-row">
                    <Link className="fw-q-link fw-q-code" href={href('Nonconformance', ncr.id)}>
                      {ncr.number}
                    </Link>
                    <span className="fw-q-hint">{t(`linked.stage.${ncr.stage}`)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="fw-cmp-link-group" aria-labelledby="cmp-inv-capa">
            <h3 className="fw-cmp-h3" id="cmp-inv-capa">
              {t('linked.capa')}
            </h3>
            {complaint.capaRecord ? (
              <p className="fw-q-cell-row">
                <Link className="fw-q-link fw-q-code" href={href('Capa', complaint.capaRecord.id)}>
                  {complaint.capaRecord.number}
                </Link>
                <span className="fw-q-hint">
                  {complaint.capaRecord.title} · {t(`capa.status.${complaint.capaRecord.status}`)}
                </span>
              </p>
            ) : (
              <p className="fw-q-hint">{say(t, capa)}</p>
            )}
          </section>
        </div>
      </Section>
    </div>
  )
}

export function AnswerTab({ model, actions, held }: { model: ComplaintRecordModel; actions?: ComplaintRecordActions; held: Held }) {
  const t = useWords()
  const shell = useT('shell')
  const locale = useLocale()
  const complaint = model.complaint
  const state = model.answer ?? IDLE_ANSWER
  const draft = state.draft ?? answerDraftOf(complaint)
  const ids = { template: useId(), language: useId(), text: useId() }
  const writeHeld = held('writeAnswer')
  const sendHeld = held('sendAnswer')
  const sent = complaint.answer.sent
  const editable = writeHeld === null
  const changed = state.draft !== null && answerChanged(state.draft, complaint)
  const saveKey = answerSaveHeld(draft, complaint)
  const saveHeld = state.busy ? t('common.working') : model.offline ? t('held.offline') : writeHeld ?? (saveKey ? t(saveKey) : null)
  const sendReason = sendHeld ?? (changed ? t('answer.held.saveFirst') : state.busy ? t('common.working') : null)
  const files = state.files
  const shared = new Map(complaint.answer.files.map((file) => [file.id, file.shared]))
  const languages: { value: LetterLanguage; label: string }[] = [
    { value: 'it', label: t('answer.language.it') },
    { value: 'en', label: t('answer.language.en') },
  ]
  const who = personName(complaint.people, sent?.byId ?? null)
  return (
    <div className="fw-q-stack">
      {sent && (
        <Banner
          tone="success"
          title={t('answer.sent', { time: formatDateTime(sent.at, { locale }), who: who ?? '—', via: t(`answer.via.${sent.via}`), version: sent.version })}
          action={
            <Button size="sm" onClick={() => actions?.onOpenFile?.(sent.fileId)}>
              <FileText size={14} aria-hidden /> {t('answer.openSent')}
            </Button>
          }
        >
          {t('answer.sentBody')}
        </Banner>
      )}
      {!sent && complaint.status === 'ANSWERED' && <Banner tone="info" title={t('answer.answeredOtherWay')} />}
      {!editable && writeHeld && complaint.status !== 'ANSWERED' && <Banner tone="info" title={writeHeld} />}
      <div className="fw-cmp-answer">
        <Section
          id="cmp-ans"
          title={t('answer.title')}
          sub={t('answer.sub')}
          actions={
            <Button size="sm" variant="primary" heldReason={sendReason} onClick={() => actions?.onSend?.()}>
              <Send size={14} aria-hidden /> {t('answer.send.open')}
            </Button>
          }
        >
          <div className="fw-q-stack">
            {state.problem && <Banner tone="danger" title={t(state.problem)} />}
            <div className="fw-cmp-answer-head">
              <Field label={t('answer.template')} hint={t('answer.templateHint')} htmlFor={ids.template}>
                <Listbox
                  id={ids.template}
                  options={ANSWER_TEMPLATES.map((template) => ({ value: template, label: templateName(template, draft.language) }))}
                  value={draft.template}
                  onChange={(value) => actions?.onAnswerTemplate?.(value as typeof draft.template)}
                  emptyLabel={t('answer.noTemplate')}
                  emptyIsPlaceholder
                  disabled={!editable}
                  width="100%"
                />
              </Field>
              <Field label={<span id={`${ids.language}-label`}>{t('answer.languageLabel')}</span>} hint={draft.language === complaint.answer.suggestedLanguage ? t('answer.languageCustomer') : t('answer.languageOther')}>
                <SegmentedControl ariaLabel={t('answer.languageLabel')} options={languages} value={draft.language} onChange={(value) => actions?.onAnswerLanguage?.(value as LetterLanguage)} size="sm" disabled={!editable} />
              </Field>
            </div>
            {state.keptWords && (
              <Banner
                tone="info"
                title={t('answer.keptWords')}
                action={
                  <Button size="sm" onClick={() => actions?.onAnswerUseTemplate?.()}>
                    {t('answer.useTemplate')}
                  </Button>
                }
              />
            )}
            <Field label={t('answer.text')} hint={t('answer.textHint')} htmlFor={ids.text}>
              <Textarea id={ids.text} rows={14} value={draft.text} readOnly={!editable} onChange={(event) => actions?.onAnswerText?.(event.target.value)} />
            </Field>
            <section aria-labelledby="cmp-ans-files" className="fw-q-stack">
              <h3 className="fw-cmp-h3" id="cmp-ans-files">
                {t('answer.files', { count: draft.fileIds.length })}
              </h3>
              <p className="fw-q-hint">{t('answer.filesHint')}</p>
              {!model.can.filesRead ? (
                <p className="fw-q-hint">{t('answer.filesNoRight')}</p>
              ) : files === null ? (
                <p className="fw-q-hint">
                  <Spinner size={12} /> {t('answer.filesReading')}
                </p>
              ) : files.length === 0 ? (
                <p className="fw-q-hint">{t('answer.filesNone')}</p>
              ) : (
                <ul className="fw-cmp-answer-files">
                  {files.map((file) => {
                    const isShared = shared.get(file.id) ?? (file.visibility.includes('PARTNER') && file.partyId === complaint.party.id)
                    const ticked = draft.fileIds.includes(file.id)
                    return (
                      <li key={file.id} className="fw-cmp-answer-file">
                        <Checkbox checked={ticked} disabled={!editable} onChange={(event) => actions?.onAnswerFile?.(file.id, event.target.checked)} label={file.originalName} />
                        <Tag tone={isShared ? 'success' : 'neutral'}>{t(isShared ? 'answer.shared' : 'answer.notShared')}</Tag>
                        {!isShared && (
                          <Button
                            size="xs"
                            variant="ghost"
                            heldReason={!model.can.filesManage ? t('answer.shareNoRight') : !editable ? writeHeld : state.sharing ? t('common.working') : model.offline ? t('held.offline') : null}
                            onClick={() => actions?.onAnswerShare?.(file.id)}
                            aria-label={t('answer.shareOf', { name: file.originalName })}
                          >
                            {state.sharing === file.id ? <Spinner size={12} /> : <Share2 size={13} aria-hidden />} {t('answer.share')}
                          </Button>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
            </section>
            {editable && (
              <div className="fw-cmp-answer-save">
                <span className="fw-q-hint">{changed ? t('record.editUnsaved') : t('answer.savedHint')}</span>
                <span className="grow" />
                <Button size="sm" heldReason={changed ? null : t('record.editNothing')} onClick={() => actions?.onAnswerDiscard?.()}>
                  {t('answer.discard')}
                </Button>
                <Button size="sm" variant="primary" heldReason={saveHeld} onClick={() => actions?.onAnswerSave?.()}>
                  {state.busy ? <Spinner size={12} /> : null} {t('answer.save')}
                </Button>
              </div>
            )}
          </div>
        </Section>
        <Section
          id="cmp-ans-preview"
          title={t('answer.preview.title')}
          sub={t('answer.preview.sub')}
          actions={
            <>
              <Button size="sm" variant="quiet" heldReason={complaint.answer.text ? null : t('held.NO_ANSWER')} onClick={() => actions?.onPreview?.()}>
                <RefreshCw size={13} aria-hidden /> {t('answer.preview.again')}
              </Button>
              {complaint.answer.text ? (
                <a className="fw-q-link" href={answerLetterHref(complaint.id, complaint.answer.language)} target="_blank" rel="noreferrer">
                  <ExternalLink size={13} aria-hidden /> {t('answer.preview.newTab')}
                </a>
              ) : null}
            </>
          }
        >
          {!complaint.answer.text ? (
            <p className="fw-q-hint">{t('answer.preview.none')}</p>
          ) : state.preview.status === 'ready' ? (
            <PdfViewer src={state.preview.data} title={t('answer.preview.pdfTitle', { number: complaint.number })} fileName={`${complaint.number}-${state.preview.language}.pdf`} labels={pdfViewerLabels(shell)} height="min(70vh, 760px)" />
          ) : state.preview.status === 'error' ? (
            <Banner
              tone="danger"
              title={t(state.preview.problem)}
              action={
                <Button size="sm" onClick={() => actions?.onPreview?.()}>
                  {t('common.retry')}
                </Button>
              }
            />
          ) : state.preview.status === 'loading' ? (
            <p className="fw-q-hint">
              <Spinner size={12} /> {t('answer.preview.loading')}
            </p>
          ) : (
            <p className="fw-q-hint">{t('answer.preview.idle')}</p>
          )}
        </Section>
      </div>
      <Section id="cmp-ans-versions" title={t('answer.versions.title', { count: complaint.answer.versions.length })} sub={t('answer.versions.sub')}>
        {complaint.answer.versions.length === 0 ? (
          <p className="fw-q-hint">{t('answer.versions.none')}</p>
        ) : (
          <KeyValue
            dense
            labelCase="sentence"
            items={complaint.answer.versions.map((version) => ({
              label: t('answer.versions.version', { version: version.version }),
              value: (
                <Button size="xs" variant="ghost" onClick={() => actions?.onOpenFile?.(version.fileId)}>
                  <FileText size={13} aria-hidden /> {t('answer.versions.open', { language: t(`answer.language.${version.language === 'en' ? 'en' : 'it'}`) })}
                </Button>
              ),
              hint: `${formatDateTime(version.createdAt, { locale })}${version.createdById ? ` · ${personName(complaint.people, version.createdById) ?? '—'}` : ''}${sent?.documentId === version.id ? ` · ${t('answer.versions.sentOne')}` : ''}`,
            }))}
          />
        )}
      </Section>
    </div>
  )
}

/** The send review's body (design cmp-ans "Send = review then send"): who gets it, copies, the subject and words, why not yet. */
export function SendBody({ model, actions, draft }: { model: ComplaintRecordModel; actions?: ComplaintRecordActions; draft: SendDraft | null }) {
  const t = useWords()
  const state = model.answer ?? IDLE_ANSWER
  const check: AnswerCheck | null = state.check
  const ids = { cc: useId(), subject: useId(), message: useId() }
  if (state.checkProblem) return <Banner tone="danger" title={t(state.checkProblem)} />
  if (!check || !draft)
    return (
      <p className="fw-q-hint">
        <Spinner size={12} /> {t('answer.send.reading')}
      </p>
    )
  const problems = [...new Set(check.problems.map((problem) => checkProblemKey(problem.path)))]
  const set = (patch: Partial<SendDraft>) => actions?.onSendDraft?.(patch)
  return (
    <>
      <p className="fw-q-intro">{t('answer.send.body', { number: model.complaint.number, language: t(`answer.language.${check.language}`) })}</p>
      {problems.length > 0 && (
        <Banner tone="danger" title={t('answer.send.heldProblems')}>
          <ul className="fw-cmp-problems">
            {problems.map((key) => (
              <li key={key}>{t(key)}</li>
            ))}
          </ul>
        </Banner>
      )}
      <Field label={<span id="cmp-send-to">{t('answer.send.to')}</span>} required hint={check.recipients.length === 0 ? t('answer.send.problem.contactIds') : t('answer.send.toHint')}>
        <div role="group" aria-labelledby="cmp-send-to" className="fw-q-stack">
          {check.recipients.map((recipient) => (
            <Checkbox
              key={recipient.contactId}
              checked={draft.contactIds.includes(recipient.contactId)}
              onChange={(event) => set({ contactIds: event.target.checked ? [...draft.contactIds, recipient.contactId] : draft.contactIds.filter((id) => id !== recipient.contactId) })}
              label={`${recipient.name} · ${recipient.email}${recipient.suggested ? ` · ${t('answer.send.suggested')}` : ''}`}
            />
          ))}
        </div>
      </Field>
      <Field label={t('answer.send.cc')} hint={t('answer.send.ccHint')} htmlFor={ids.cc}>
        <Input id={ids.cc} value={draft.cc} onChange={(event) => set({ cc: event.target.value })} autoComplete="off" />
      </Field>
      <Field label={t('answer.send.subject')} htmlFor={ids.subject}>
        <Input id={ids.subject} value={draft.subject} onChange={(event) => set({ subject: event.target.value })} />
      </Field>
      <Field label={t('answer.send.message')} hint={t('answer.send.messageHint')} htmlFor={ids.message}>
        <Textarea id={ids.message} rows={5} value={draft.message} onChange={(event) => set({ message: event.target.value })} />
      </Field>
      <p className="fw-q-hint">{t('answer.send.attached', { count: model.complaint.answer.files.length })}</p>
      <p className="fw-q-hint">{t('answer.send.never')}</p>
    </>
  )
}

/** Why Send in the review is held now (its words), or null. */
export function sendReviewHeld(model: ComplaintRecordModel, draft: SendDraft | null, t: (key: string) => string): string | null {
  const state = model.answer ?? IDLE_ANSWER
  if (model.dialogBusy) return t('common.working')
  if (model.offline) return t('held.offline')
  if (state.checkProblem) return t(state.checkProblem)
  const key = sendHeldKey(state.check, draft ?? { contactIds: [], cc: '', subject: '', message: '' })
  return key ? t(key) : null
}
