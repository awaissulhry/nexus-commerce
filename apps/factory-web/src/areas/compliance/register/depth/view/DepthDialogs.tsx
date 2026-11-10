'use client'

import { useState } from 'react'
import { Banner, Field } from '@nexus/ui/components'
import { Checkbox, Input, RadioCard, Select } from '@nexus/ui/primitives'
import { DateField, Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useScopedT, useT } from '../../../../../lib/i18n/provider'
import { AUTHORITY_CHANNELS, RECALL_KINDS, type AuthorityChannel, type AuthorityRequest, type DistributorNotice, type RecallKind } from '../api'
import { blankRequest, distributorHeld, distributorLog, draftsToSend, requestHeld, requestProblems, type RequestForm } from '../model'
import type { DepthActions, DepthModel } from './types'
import { DepthDialog, DepthStepUp, NS } from './parts'
import { NoticeModal } from './NoticeModal'

/**
 * The register in depth's dialogs (B-W2b-271): the Authority notice (pop:rg-notice, its own file), Log a request, Build
 * evidence pack, Answer and Cancel a request, the distributor notice's review (Edit), Record the answer, Mark failed,
 * Cancel, "Send to N distributors" (a review of every draft, then a fresh code), Start a recall or a withdrawal, and the
 * step-up. Each changes one thing with the version read, explicitly, and says what it records.
 */
export function DepthDialogs({ model, actions }: { model: DepthModel; actions?: DepthActions }) {
  const dialog = model.dialog
  return (
    <>
      <NoticeModal model={model} actions={actions} />
      {dialog?.kind === 'request' && <LogRequestDialog model={model} actions={actions} />}
      {(dialog?.kind === 'requestEvidence' || dialog?.kind === 'requestAnswer' || dialog?.kind === 'requestCancel') && <RequestDialog model={model} actions={actions} requestId={dialog.requestId} kind={dialog.kind} />}
      {(dialog?.kind === 'distributorEdit' || dialog?.kind === 'distributorAnswer' || dialog?.kind === 'distributorFail' || dialog?.kind === 'distributorCancel') && (
        <DistributorDialog model={model} actions={actions} noticeId={dialog.noticeId} kind={dialog.kind} />
      )}
      {dialog?.kind === 'distributorSend' && <SendDialog model={model} actions={actions} />}
      {dialog?.kind === 'startRecall' && <StartRecallDialog model={model} actions={actions} />}
      <DepthStepUp state={model.stepUp} onSubmit={(code) => actions?.onSubmitStepUp?.(code)} onCancel={() => actions?.onCancelStepUp?.()} />
    </>
  )
}

const close = (actions?: DepthActions) => () => actions?.onDialog?.(null)

function LogRequestDialog({ model, actions }: { model: DepthModel; actions?: DepthActions }) {
  const d = useT(NS)
  const s = useScopedT(NS)
  const locale = useLocale()
  const markets = model.markets?.value ?? null
  const [form, setForm] = useState<RequestForm>(() => blankRequest(markets?.length === 1 ? markets[0]!.code : ''))
  const [allBatches, setAllBatches] = useState(true)
  const set = (patch: Partial<RequestForm>) => setForm((current) => ({ ...current, ...patch }))
  const problems = requestProblems(form, model.today)
  const held = !model.can.recallManage ? d('held.manage') : model.entry.status !== 'OPEN' ? d('held.entryClosed') : problems[0] ? s(problems[0]) : null
  const dateLocale = locale === 'it' ? 'it-IT' : 'en-GB'
  return (
    <DepthDialog
      open
      title={d('request.logTitle')}
      sub={d('request.logSub', { reference: model.entry.reference, style: model.entry.styleCode })}
      confirm={d('request.logConfirm')}
      held={held}
      busy={model.busy}
      problem={model.problem}
      size="lg"
      onConfirm={() => actions?.onLogRequest?.({ ...form, batchNumbers: allBatches ? [] : model.entry.batchNumbers })}
      onClose={close(actions)}
    >
      <div className="fw-q-form-two">
        <Field label={d('notice.authority')} required>
          <Input value={form.authorityName} onChange={(event) => set({ authorityName: event.target.value })} maxLength={300} />
        </Field>
        {markets && markets.length > 0 ? (
          <Field label={d('notice.market')} required>
            <Select value={form.marketCode} onChange={(event) => set({ marketCode: event.target.value })}>
              <option value="">{d('notice.chooseMarket')}</option>
              {markets.map((market) => (
                <option key={market.code} value={market.code}>
                  {market.name} ({market.code})
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <Field label={d('notice.market')} required hint={d('notice.marketCodeHint')}>
            <Input value={form.marketCode} onChange={(event) => set({ marketCode: event.target.value.toUpperCase() })} maxLength={12} placeholder="IT" />
          </Field>
        )}
        <Field label={d('request.theirReference')} hint={d('request.theirReferenceHint')}>
          <Input value={form.authorityReference} onChange={(event) => set({ authorityReference: event.target.value })} maxLength={200} />
        </Field>
        <Field label={d('notice.channel')} required>
          <Select value={form.channel} onChange={(event) => set({ channel: event.target.value as AuthorityChannel })}>
            {AUTHORITY_CHANNELS.map((channel) => (
              <option key={channel} value={channel}>
                {d(`channel.${channel}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={d('request.receivedOn')} hint={d('request.receivedHint')}>
          <DateField value={form.receivedOn} onChange={(receivedOn) => set({ receivedOn })} max={model.today} locale={dateLocale} ariaLabel={d('request.receivedOn')} clearable />
        </Field>
        <Field label={d('request.dueOn')} required hint={d('request.dueHint')}>
          <DateField value={form.dueOn} onChange={(dueOn) => set({ dueOn })} min={form.receivedOn || model.today} locale={dateLocale} ariaLabel={d('request.dueOn')} />
        </Field>
      </div>
      <Field label={d('request.text')} required hint={d('request.textHint')}>
        <Textarea value={form.request} onChange={(event) => set({ request: event.target.value })} rows={4} limit={4000} />
      </Field>
      {model.entry.batchNumbers.length > 0 && (
        <Checkbox checked={allBatches} onChange={(event) => setAllBatches(event.target.checked)} label={d('request.wholeStyle', { style: model.entry.styleCode, batches: model.entry.batchNumbers.join(', ') })} />
      )}
      <p className="fw-q-hint">{d('request.onEntry')}</p>
    </DepthDialog>
  )
}

function RequestDialog({ model, actions, requestId, kind }: { model: DepthModel; actions?: DepthActions; requestId: string; kind: 'requestEvidence' | 'requestAnswer' | 'requestCancel' }) {
  const d = useT(NS)
  const locale = useLocale()
  const request: AuthorityRequest | undefined = model.surveillance.value?.requests.find((item) => item.id === requestId)
  const [text, setText] = useState('')
  const [day, setDay] = useState(model.today)
  const [language, setLanguage] = useState<string>(locale)
  if (!request) return null
  const action = kind === 'requestEvidence' ? 'evidence' : kind === 'requestAnswer' ? 'answer' : 'cancel'
  const right = requestHeld(action, request, model.can)
  const held = right ? d(right) : action === 'evidence' ? null : !text.trim() ? d(action === 'answer' ? 'request.needsSummary' : 'dialog.needsReason') : action === 'answer' && !day ? d('dialog.needsDay') : null
  const facts = (
    <p className="fw-q-hint">
      {d('request.facts', { number: request.number, authority: request.authorityName, due: formatDate(`${request.dueOn}T12:00:00Z`, { locale, timeZone: 'UTC' }) })}
    </p>
  )
  if (action === 'evidence')
    return (
      <DepthDialog
        open
        title={d('request.evidenceTitle', { number: request.number })}
        sub={d('request.evidenceSub')}
        confirm={d('request.evidenceConfirm')}
        held={held}
        busy={model.busy}
        problem={model.problem}
        onConfirm={() => actions?.onRequestEvidence?.(request.id, language)}
        onClose={close(actions)}
      >
        {facts}
        <Field label={d('request.packLanguage')}>
          <Select value={language} onChange={(event) => setLanguage(event.target.value)}>
            <option value="it">{d('language.it')}</option>
            <option value="en">{d('language.en')}</option>
          </Select>
        </Field>
        <p className="fw-q-hint">{request.batchNumbers.length > 0 ? d('request.packBatches', { batches: request.batchNumbers.join(', ') }) : d('request.packStyle', { style: request.style?.code ?? '—' })}</p>
      </DepthDialog>
    )
  return (
    <DepthDialog
      open
      title={d(action === 'answer' ? 'request.answerTitle' : 'request.cancelTitle', { number: request.number })}
      sub={action === 'answer' ? d('request.answerSub') : d('request.cancelSub')}
      confirm={d(action === 'answer' ? 'request.answerConfirm' : 'request.cancelConfirm')}
      tone={action === 'cancel' ? 'danger' : 'primary'}
      held={held}
      busy={model.busy}
      problem={model.problem}
      onConfirm={() => (action === 'answer' ? actions?.onAnswerRequest?.(request.id, { answerSummary: text.trim(), day }) : actions?.onCancelRequest?.(request.id, text.trim()))}
      onClose={close(actions)}
    >
      {facts}
      {action === 'answer' && !request.evidence && <Banner tone="warning" title={d('request.noEvidenceYet')} />}
      {action === 'answer' && (
        <Field label={d('request.answeredOnField')}>
          <DateField value={day} onChange={setDay} max={model.today} locale={locale === 'it' ? 'it-IT' : 'en-GB'} ariaLabel={d('request.answeredOnField')} />
        </Field>
      )}
      <Field label={d(action === 'answer' ? 'request.summary' : 'dialog.reason')} required hint={action === 'answer' ? d('request.summaryHint') : undefined}>
        <Textarea value={text} onChange={(event) => setText(event.target.value)} rows={4} limit={action === 'answer' ? 4000 : 500} />
      </Field>
    </DepthDialog>
  )
}

function DistributorDialog({ model, actions, noticeId, kind }: { model: DepthModel; actions?: DepthActions; noticeId: string; kind: 'distributorEdit' | 'distributorAnswer' | 'distributorFail' | 'distributorCancel' }) {
  const d = useT(NS)
  const locale = useLocale()
  const recipients = model.recipients?.value ?? null
  const notice: DistributorNotice | undefined = recipients ? distributorLog(recipients).find((item) => item.id === noticeId) : undefined
  const [subject, setSubject] = useState(notice?.subject ?? '')
  const [message, setMessage] = useState(notice?.message ?? '')
  const [text, setText] = useState('')
  const [byName, setByName] = useState('')
  const [day, setDay] = useState(model.today)
  if (!notice || !recipients) return null
  const action = kind === 'distributorEdit' ? 'edit' : kind === 'distributorAnswer' ? 'answer' : kind === 'distributorFail' ? 'fail' : 'cancel'
  const right = distributorHeld(action, recipients, notice, model.can, model.entry)
  const textHeld = action === 'edit' ? (!message.trim() ? d('log.needsMessage') : null) : !text.trim() ? d(action === 'answer' ? 'log.needsAnswer' : 'dialog.needsReason') : null
  const held = right ? d(right) : textHeld
  const who = `${notice.party.name} (${notice.party.code})`
  const title = d(`log.${action}Title`, { party: notice.party.name })
  const confirm = d(`log.${action}Confirm`)
  const onConfirm = () => {
    if (action === 'edit') actions?.onEditDistributor?.(notice.id, { subject: subject.trim(), message })
    else if (action === 'answer') actions?.onAnswerDistributor?.(notice.id, { answer: text.trim(), day, byName: byName.trim() })
    else if (action === 'fail') actions?.onFailDistributor?.(notice.id, text.trim())
    else actions?.onCancelDistributor?.(notice.id, text.trim())
  }
  return (
    <DepthDialog
      open
      title={title}
      sub={`${who} · ${d(`how.${notice.channel}`)}${notice.contact ? ` · ${notice.contact}` : ''}`}
      confirm={confirm}
      tone={action === 'cancel' || action === 'fail' ? 'danger' : 'primary'}
      held={held}
      busy={model.busy}
      problem={model.problem}
      size={action === 'edit' ? 'lg' : 'md'}
      onConfirm={onConfirm}
      onClose={close(actions)}
    >
      {action === 'edit' ? (
        <>
          <p className="fw-q-hint">{d('log.editSub', { language: notice.language.toUpperCase() })}</p>
          {notice.channel === 'EMAIL' && (
            <Field label={d('log.subject')}>
              <Input value={subject} onChange={(event) => setSubject(event.target.value)} maxLength={300} />
            </Field>
          )}
          <Field label={d('log.message')} required>
            <Textarea value={message} onChange={(event) => setMessage(event.target.value)} rows={12} limit={20000} />
          </Field>
        </>
      ) : (
        <>
          {notice.sentAt && <p className="fw-q-hint">{d('log.sentOn', { date: formatDate(notice.sentAt, { locale }) })}</p>}
          {action === 'answer' && (
            <div className="fw-q-form-two">
              <Field label={d('log.answeredOn')}>
                <DateField value={day} onChange={setDay} max={model.today} locale={locale === 'it' ? 'it-IT' : 'en-GB'} ariaLabel={d('log.answeredOn')} />
              </Field>
              <Field label={d('log.answeredBy')} hint={d('log.answeredByHint')}>
                <Input value={byName} onChange={(event) => setByName(event.target.value)} maxLength={200} />
              </Field>
            </div>
          )}
          <Field label={d(action === 'answer' ? 'log.answer' : 'dialog.reason')} required hint={action === 'fail' ? d('log.failHint') : undefined}>
            <Textarea value={text} onChange={(event) => setText(event.target.value)} rows={4} limit={action === 'answer' ? 4000 : 500} />
          </Field>
        </>
      )}
    </DepthDialog>
  )
}

/** "Send to N distributors": every draft to review (who, how, the language and the subject), then one send with a fresh code. */
function SendDialog({ model, actions }: { model: DepthModel; actions?: DepthActions }) {
  const d = useT(NS)
  const recipients = model.recipients?.value ?? null
  if (!recipients) return null
  const drafts = draftsToSend(recipients)
  const right = distributorHeld('send', recipients, null, model.can, model.entry)
  return (
    <DepthDialog
      open
      title={d('log.sendTitle', { count: drafts.length })}
      sub={d('log.sendSub')}
      confirm={d('log.sendAction', { count: drafts.length })}
      held={right ? d(right) : null}
      busy={model.busy}
      problem={model.problem}
      size="lg"
      onConfirm={() => actions?.onSendDistributors?.()}
      onClose={close(actions)}
    >
      <ul className="fw-rgd-review">
        {drafts.map((notice) => (
          <li key={notice.id} className="fw-rgd-review-row">
            <span className="fw-q-cell">
              <span>
                {notice.party.name} ({notice.party.code})
              </span>
              <span className="fw-q-hint">
                {d(`how.${notice.channel}`)} · {notice.contact ?? '—'} · {notice.language.toUpperCase()}
              </span>
            </span>
            <span className="fw-q-hint fw-rgd-clip">{notice.subject ?? notice.message.slice(0, 120)}</span>
          </li>
        ))}
      </ul>
      <Banner tone="info" title={d('log.sendFake')} />
    </DepthDialog>
  )
}

function StartRecallDialog({ model, actions }: { model: DepthModel; actions?: DepthActions }) {
  const d = useT(NS)
  const [kind, setKind] = useState<RecallKind>(model.entry.kind === 'WITHDRAWAL' ? 'WITHDRAWAL' : 'RECALL')
  const held = !model.can.recallManage ? d('held.manage') : model.entry.status !== 'OPEN' ? d('held.entryClosed') : null
  return (
    <DepthDialog
      open
      title={d('recalls.startTitle', { reference: model.entry.reference })}
      sub={d('recalls.startSub')}
      confirm={d(kind === 'WITHDRAWAL' ? 'recalls.draftWithdrawal' : 'recalls.draftRecall')}
      held={held}
      busy={model.busy}
      problem={model.problem}
      onConfirm={() => actions?.onStartRecall?.(kind)}
      onClose={close(actions)}
    >
      <fieldset className="fw-q-choices">
        <legend className="fw-q-hint">{d('recalls.kind')}</legend>
        <div className="fw-reg-risks">
          {RECALL_KINDS.map((value) => (
            <RadioCard key={value} name="recall-kind" value={value} checked={kind === value} selected={kind === value} onChange={() => setKind(value)} title={d(`recallKind.${value}`)} description={d(`recallKindHint.${value}`)} />
          ))}
        </div>
      </fieldset>
      <p className="fw-q-hint">{d('recalls.startScope', { style: model.entry.styleCode })}</p>
    </DepthDialog>
  )
}
