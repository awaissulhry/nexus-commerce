'use client'

import { useEffect, useMemo, useState } from 'react'
import { ExternalLink, X } from 'lucide-react'
import { Banner, Disclosure, Field, KeyValue } from '@nexus/ui/components'
import { PdfViewer } from '@nexus/ui/components/PdfViewer/index'
import { Button, Input, RadioCard, SegmentedControl, Select, Skeleton } from '@nexus/ui/primitives'
import { DateField, FileDropzone, Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useScopedT, useT } from '../../../../../lib/i18n/provider'
import { pdfViewerLabels } from '../../../../../lib/pdf/labels'
import { AUTHORITY_CHANNELS, NOTICE_DECISIONS, type AuthorityChannel, type AuthorityNotice, type NoticeDecision } from '../api'
import { blankNotice, noticeDraftProblems, noticeEdit, noticeHeld, noticePdfAddress, pickLanguage, readerChain, sentProblems, wordsProblem, type NoticeDraftForm } from '../model'
import type { DepthActions, DepthModel } from './types'
import { DepthDialog, Law, NoticeStatus, NS } from './parts'

/**
 * pop:rg-notice — Authority notice (design compliance.register, W2b; PRD-387; Reg. (EU) 2016/425 art. 8(8)): a draft from
 * the entry (product, risk, corrective action — the API writes it in the market's DoC languages) for the national authority
 * or the Safety Business Gateway; its words per language; the PDF as the authority's paper (the viewer, and the PDF in a new
 * tab to submit on the authority's site); "Mark notice as sent" with the day, the authority's reference and the copy as
 * sent (a fresh code: the person who sends is recorded). Nothing is sent from here automatically. A SENT notice takes its
 * reference and copy later, once each. Fetches nothing: the container reads the notice and its PDF.
 */
export function NoticeModal({ model, actions }: { model: DepthModel; actions?: DepthActions }) {
  const open = model.dialog?.kind === 'notice'
  const state = model.noticeModal
  const close = () => actions?.onDialog?.(null)
  if (!open) return null
  if (!state?.notice) return model.dialog?.kind === 'notice' && model.dialog.noticeId ? <LoadingNotice onClose={close} /> : <NewNotice model={model} actions={actions} onClose={close} />
  return <NoticeRecord model={model} actions={actions} notice={state.notice} onClose={close} />
}

function LoadingNotice({ onClose }: { onClose: () => void }) {
  const d = useT(NS)
  return (
    <DepthDialog open title={d('notice.title')} confirm={d('notice.close')} held={d('dialog.reading')} busy={false} onConfirm={onClose} onClose={onClose}>
      <Skeleton height={22} />
      <Skeleton height={180} />
    </DepthDialog>
  )
}

function MarketField({ model, value, onChange }: { model: DepthModel; value: string; onChange: (code: string) => void }) {
  const d = useT(NS)
  const markets = model.markets?.value ?? null
  if (markets && markets.length > 0)
    return (
      <Field label={d('notice.market')} required hint={d('notice.marketHint')}>
        <Select value={value} onChange={(event) => onChange(event.target.value)}>
          <option value="">{d('notice.chooseMarket')}</option>
          {markets.map((market) => (
            <option key={market.code} value={market.code}>
              {market.name} ({market.code})
            </option>
          ))}
        </Select>
      </Field>
    )
  return (
    <Field label={d('notice.market')} required hint={model.markets?.problem ? d('notice.marketTyped') : d('notice.marketCodeHint')}>
      <Input value={value} onChange={(event) => onChange(event.target.value.toUpperCase())} maxLength={12} placeholder="IT" />
    </Field>
  )
}

function NewNotice({ model, actions, onClose }: { model: DepthModel; actions?: DepthActions; onClose: () => void }) {
  const d = useT(NS)
  const s = useScopedT(NS)
  const [form, setForm] = useState<NoticeDraftForm>(() => blankNotice(model.entry, model.markets?.value?.length === 1 ? model.markets.value[0]!.code : ''))
  const set = (patch: Partial<NoticeDraftForm>) => setForm((current) => ({ ...current, ...patch }))
  const problems = noticeDraftProblems(form, model.entry)
  const right = noticeHeld('draft', null, model.entry, model.can)
  const held = right ? d(right) : problems[0] ? s(problems[0]) : null
  return (
    <DepthDialog
      open
      title={d('notice.newTitle', { reference: model.entry.reference })}
      sub={d('notice.newSub')}
      confirm={d('notice.draftConfirm')}
      held={held}
      busy={model.busy}
      problem={model.problem}
      size="lg"
      onConfirm={() => actions?.onDraftNotice?.({ ...form, marketCode: form.marketCode.trim(), authorityName: form.authorityName.trim() })}
      onClose={onClose}
    >
      <Banner tone="info" title={d('notice.nothingSent')} />
      <div className="fw-q-form-two">
        <MarketField model={model} value={form.marketCode} onChange={(marketCode) => set({ marketCode })} />
        <Field label={d('notice.channel')} required>
          <Select value={form.channel} onChange={(event) => set({ channel: event.target.value as AuthorityChannel })}>
            {AUTHORITY_CHANNELS.map((channel) => (
              <option key={channel} value={channel}>
                {d(`channel.${channel}`)}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label={d('notice.authority')} required hint={d('notice.authorityHint')}>
        <Input value={form.authorityName} onChange={(event) => set({ authorityName: event.target.value })} maxLength={300} />
      </Field>
      <DecisionChoice value={form.decision} risk={model.entry.risk} onChange={(decision) => set({ decision })} />
      <p className="fw-q-hint">{d('notice.draftedFrom')}</p>
    </DepthDialog>
  )
}

function DecisionChoice({ value, risk, onChange, disabled = false }: { value: NoticeDecision; risk: DepthModel['entry']['risk']; onChange: (decision: NoticeDecision) => void; disabled?: boolean }) {
  const d = useT(NS)
  return (
    <fieldset className="fw-q-choices">
      <legend className="fw-q-hint">{d('notice.decision')}</legend>
      <div className="fw-reg-risks">
        {NOTICE_DECISIONS.map((decision) => (
          <RadioCard
            key={decision}
            name="notice-decision"
            value={decision}
            checked={value === decision}
            selected={value === decision}
            disabled={disabled}
            onChange={() => onChange(decision)}
            title={d(`decision.${decision}`)}
            description={decision === 'RISK' && risk !== 'YES' ? d('decision.riskHeld') : d(`decisionHint.${decision}`)}
          />
        ))}
      </div>
    </fieldset>
  )
}

function NoticeRecord({ model, actions, notice, onClose }: { model: DepthModel; actions?: DepthActions; notice: AuthorityNotice; onClose: () => void }) {
  const d = useT(NS)
  const q = useT('quality')
  const s = useScopedT(NS)
  const shell = useT('shell')
  const locale = useLocale()
  const draft = notice.status === 'DRAFT'
  const saved = Object.keys(notice.words)
  const [authorityName, setAuthorityName] = useState(notice.authorityName)
  const [channel, setChannel] = useState<AuthorityChannel>(notice.channel)
  const [decision, setDecision] = useState<NoticeDecision>(notice.decision)
  const [words, setWords] = useState<Record<string, string>>({ ...notice.words })
  const [newLanguage, setNewLanguage] = useState('')
  const [day, setDay] = useState('')
  const [reference, setReference] = useState('')
  const [copy, setCopy] = useState<File | null>(null)
  const [cancelReason, setCancelReason] = useState('')
  // The languages shown: a draft's as typed (a language added here is saved with the words), a sent notice's as sent.
  const languages = draft ? Object.keys(words) : saved
  const asked = model.noticeModal?.language ?? null
  const language = asked && languages.includes(asked) ? asked : pickLanguage(languages, readerChain(locale))
  // A new version of the notice (saved, sent, read again) resets what is typed.
  useEffect(() => {
    setAuthorityName(notice.authorityName)
    setChannel(notice.channel)
    setDecision(notice.decision)
    setWords({ ...notice.words })
    setDay('')
    setReference('')
    setCopy(null)
    setCancelReason('')
  }, [notice])

  const edit = noticeEdit(notice, { authorityName, channel, decision, words })
  const changed = Object.keys(edit).length > 0
  const wordsHeld = wordsProblem(words)
  const editRight = noticeHeld('edit', notice, model.entry, model.can)
  const saveHeld = editRight ? d(editRight) : !changed ? d('notice.nothingChanged') : !authorityName.trim() ? d('notice.problem.authority') : wordsHeld ? s(wordsHeld) : null
  const sendRight = noticeHeld('send', notice, model.entry, model.can)
  const sendForm = { day, reference, copyName: copy?.name ?? null }
  const sendProblems = sentProblems(sendForm, model.today, model.entry.reportedAt.slice(0, 10))
  const sendHeld = sendRight ? d(sendRight) : changed ? d('notice.saveFirst') : sendProblems[0] ? s(sendProblems[0]) : null
  const referenceRight = noticeHeld('reference', notice, model.entry, model.can)
  const referenceHeld = referenceRight ? d(referenceRight) : !reference.trim() && !copy ? d('notice.referenceNothing') : null
  const cancelRight = noticeHeld('cancel', notice, model.entry, model.can)
  const pdfAddress = noticePdfAddress(model.prefix, notice.id, language)
  const pdfLabels = useMemo(() => pdfViewerLabels(shell), [shell])

  const shown = language ?? ''
  const languageOptions = languages.map((code) => ({ value: code, label: code.toUpperCase() }))
  const facts = [
    { label: d('notice.authority'), value: notice.authorityName },
    { label: d('notice.market'), value: notice.market ? `${notice.market.name} (${notice.marketCode})` : notice.marketCode },
    { label: d('notice.channel'), value: d(`channel.${notice.channel}`) },
    { label: d('notice.decision'), value: d(`decision.${notice.decision}`) },
    ...(notice.sentAt ? [{ label: d('notice.sentOn'), value: `${formatDateTime(notice.sentAt, { locale })}${notice.sentBy ? ` · ${notice.sentBy.name}` : ''}` }] : []),
    ...(notice.status !== 'DRAFT' ? [{ label: d('col.reference'), value: notice.reference ?? '—' }, { label: d('col.copy'), value: notice.file?.name ?? '—' }] : []),
    ...(notice.cancelledAt ? [{ label: d('notice.cancelledOn'), value: `${formatDateTime(notice.cancelledAt, { locale })} · ${notice.cancelReason ?? ''}` }] : []),
  ]
  const confirm = draft ? d('notice.sendConfirm') : notice.status === 'SENT' && !referenceRight ? d('notice.referenceConfirm') : d('notice.close')
  const held = draft ? sendHeld : notice.status === 'SENT' && !referenceRight ? referenceHeld : null
  const onConfirm = () => {
    if (draft) actions?.onMarkSent?.(sendForm, copy)
    else if (notice.status === 'SENT' && !referenceRight) actions?.onNoticeReference?.({ reference: reference.trim(), copy })
    else onClose()
  }

  return (
    <DepthDialog
      open
      title={d('notice.recordTitle', { authority: notice.authorityName })}
      sub={d('notice.recordSub', { reference: notice.entry.reference })}
      confirm={confirm}
      held={held}
      busy={model.busy}
      problem={model.problem}
      size="xl"
      onConfirm={onConfirm}
      onClose={onClose}
      extra={
        draft ? (
          <Button heldReason={saveHeld} onClick={() => actions?.onSaveNotice?.({ authorityName: authorityName.trim(), channel, decision, words })}>
            {d('notice.saveDraft')}
          </Button>
        ) : undefined
      }
    >
      <div className="fw-rgd-notice">
        <div className="fw-q-stack">
          <div className="fw-q-cell-row">
            <NoticeStatus notice={notice} />
            <Law law={notice.law} plain={d('law.authorityNotice')} />
          </div>
          {draft ? (
            <>
              <Banner tone="info" title={d('notice.nothingSent')} />
              <div className="fw-q-form-two">
                <Field label={d('notice.authority')} required>
                  <Input value={authorityName} onChange={(event) => setAuthorityName(event.target.value)} maxLength={300} />
                </Field>
                <Field label={d('notice.channel')} required>
                  <Select value={channel} onChange={(event) => setChannel(event.target.value as AuthorityChannel)}>
                    {AUTHORITY_CHANNELS.map((item) => (
                      <option key={item} value={item}>
                        {d(`channel.${item}`)}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <DecisionChoice value={decision} risk={model.entry.risk} onChange={setDecision} />
            </>
          ) : (
            <KeyValue items={facts} labelCase="sentence" columns={2} />
          )}
          <div className="fw-q-stack">
            <div className="fw-q-cell-row">
              {languageOptions.length > 1 && <SegmentedControl ariaLabel={d('notice.language')} size="sm" options={languageOptions} value={shown} onChange={(next) => actions?.onNoticeLanguage?.(next)} />}
              {languageOptions.length <= 1 && <span className="fw-q-hint">{d('notice.languageOne', { language: shown.toUpperCase() })}</span>}
            </div>
            {draft ? (
              <>
                <Field label={d('notice.words', { language: shown.toUpperCase() })} hint={d('notice.wordsHint')}>
                  <Textarea value={words[shown] ?? ''} onChange={(event) => setWords((current) => ({ ...current, [shown]: event.target.value }))} rows={10} limit={20000} />
                </Field>
                <div className="fw-q-cell-row">
                  <Input
                    size="sm"
                    value={newLanguage}
                    onChange={(event) => setNewLanguage(event.target.value.toLowerCase())}
                    maxLength={3}
                    aria-label={d('notice.addLanguage')}
                    placeholder={d('notice.addLanguagePlaceholder')}
                  />
                  <Button
                    size="sm"
                    heldReason={!/^[a-z]{2,3}$/.test(newLanguage) ? d('notice.languageCode') : words[newLanguage] !== undefined ? d('notice.languageThere') : null}
                    onClick={() => {
                      setWords((current) => ({ ...current, [newLanguage]: current[shown] ?? '' }))
                      setNewLanguage('')
                    }}
                  >
                    {d('notice.addLanguage')}
                  </Button>
                  {languages.length > 1 && words[shown] !== undefined && (
                    <Button
                      size="sm"
                      variant="quiet"
                      onClick={() =>
                        setWords((current) => {
                          const next = { ...current }
                          delete next[shown]
                          return next
                        })
                      }
                    >
                      <X size={13} aria-hidden /> {d('notice.removeLanguage', { language: shown.toUpperCase() })}
                    </Button>
                  )}
                </div>
                {languages.some((code) => !saved.includes(code)) && <p className="fw-q-hint">{d('notice.languagesUnsaved', { languages: languages.filter((code) => !saved.includes(code)).join(', ').toUpperCase() })}</p>}
              </>
            ) : (
              <p className="fw-reg-text fw-rgd-words">{notice.words[shown] ?? ''}</p>
            )}
          </div>
          {draft && (
            <section className="fw-rgd-send" aria-labelledby="rgd-send">
              <h3 id="rgd-send" className="fw-rgd-h3">
                {d('notice.sendTitle')}
              </h3>
              <p className="fw-q-hint">{d('notice.sendSub')}</p>
              <div className="fw-q-form-two">
                <Field label={d('notice.sentDay')} hint={d('notice.sentDayHint')}>
                  <DateField value={day} onChange={setDay} max={model.today} locale={locale === 'it' ? 'it-IT' : 'en-GB'} ariaLabel={d('notice.sentDay')} clearable />
                </Field>
                <Field label={d('col.reference')} hint={d('notice.referenceHint')}>
                  <Input value={reference} onChange={(event) => setReference(event.target.value)} maxLength={200} />
                </Field>
              </div>
              <CopyField copy={copy} onCopy={setCopy} can={model.can.filesUpload} />
            </section>
          )}
          {notice.status === 'SENT' && !referenceRight && (
            <section className="fw-rgd-send" aria-labelledby="rgd-reference">
              <h3 id="rgd-reference" className="fw-rgd-h3">
                {d('notice.referenceTitle')}
              </h3>
              {!notice.reference && (
                <Field label={d('col.reference')} hint={d('notice.referenceHint')}>
                  <Input value={reference} onChange={(event) => setReference(event.target.value)} maxLength={200} />
                </Field>
              )}
              {!notice.file && <CopyField copy={copy} onCopy={setCopy} can={model.can.filesUpload} />}
            </section>
          )}
          {draft && (
            <Disclosure summary={d('notice.cancelTitle')}>
              <div className="fw-q-stack">
                <Field label={d('dialog.reason')} hint={d('notice.cancelHint')}>
                  <Textarea value={cancelReason} onChange={(event) => setCancelReason(event.target.value)} rows={2} limit={500} />
                </Field>
                <Button
                  size="sm"
                  variant="danger"
                  heldReason={cancelRight ? d(cancelRight) : !cancelReason.trim() ? d('dialog.needsReason') : model.busy ? d('dialog.saving') : null}
                  onClick={() => actions?.onCancelNotice?.(cancelReason.trim())}
                >
                  {d('notice.cancelConfirm')}
                </Button>
              </div>
            </Disclosure>
          )}
        </div>
        <div className="fw-q-stack fw-rgd-pdf">
          <div className="fw-q-cell-row">
            <span className="fw-q-hint">{draft ? d('notice.pdfDraft') : d('notice.pdfSent')}</span>
            <Button size="sm" variant="quiet" asChild>
              <a href={pdfAddress} target="_blank" rel="noopener">
                <ExternalLink size={13} aria-hidden /> {d('notice.pdfTab')}
              </a>
            </Button>
          </div>
          {draft && changed && <p className="fw-q-hint">{d('notice.pdfStale')}</p>}
          {model.noticeModal?.pdf?.value ? (
            <PdfViewer src={model.noticeModal.pdf.value} title={d('notice.pdfTitle', { reference: notice.entry.reference, language: shown.toUpperCase() })} labels={pdfLabels} height="min(64vh, 720px)" />
          ) : model.noticeModal?.pdf?.problem ? (
            <Banner tone="warning" title={d('notice.pdfFailed')}>
              {q(model.noticeModal.pdf.problem)}
            </Banner>
          ) : (
            <Skeleton height={360} />
          )}
        </div>
      </div>
    </DepthDialog>
  )
}

function CopyField({ copy, onCopy, can }: { copy: File | null; onCopy: (file: File | null) => void; can: boolean }) {
  const d = useT(NS)
  if (!can) return <p className="fw-q-hint">{d('notice.copyNoRight')}</p>
  return (
    <Field label={d('notice.copy')} hint={d('notice.copyHint')}>
      {copy ? (
        <span className="fw-q-cell-row">
          <span>{copy.name}</span>
          <Button size="sm" variant="quiet" onClick={() => onCopy(null)}>
            <X size={13} aria-hidden /> {d('notice.copyRemove')}
          </Button>
        </span>
      ) : (
        <FileDropzone onFiles={(files) => onCopy(files[0] ?? null)} accept=".pdf,.png,.jpg,.jpeg" maxBytes={20 * 1024 * 1024} />
      )}
    </Field>
  )
}
