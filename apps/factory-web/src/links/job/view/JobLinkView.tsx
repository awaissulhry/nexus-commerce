'use client'

import { useEffect, useState } from 'react'
import { Printer } from 'lucide-react'
import { Banner, Card, Field, KeyValue } from '@nexus/ui/components'
import { EndState } from '@nexus/ui/components/EndState/index'
import { SizeGridView } from '@nexus/ui/grid/size-grid/index'
import { Button, Input, Pill, RadioCard, Skeleton, Spinner } from '@nexus/ui/primitives'
import { DateField, Textarea, useDsWords } from '../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../lib/i18n/locales'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { gridCopyOf, gridOf } from '../../../lib/jobs/grid'
import { WithMessages } from '../../../record-panels/i18n'
import type { LinkState } from '../../../shell/links/link-state'
import { LinkFrameView } from '../../../shell/links/view/LinkFrameView'
import { DECLINE_REASONS, type LinkJob, type LinkJobPage } from '../api'
import { answerHeld, jobClosed, LINK_NS, MAX_NAME, MAX_TEXT, type AnswerMode, type LinkDraft, type Words } from '../model'
import '../job-link.css'

/**
 * SCR-196 — Accept a job (design links.job; 00 §2.9 one-off link page): the link frame (the sender, the language, whom to
 * ask, the privacy notice) around ONE task on one phone screen — the job (operations, style, pieces per size, our kit, the
 * day it is due back, our notes; "Print the job" for the bench), your answer (Accept as asked · Propose another due date
 * with why · Decline with a reason; your name, optional), and the end (EndState: what happens next; "Follow it under Jobs"
 * when the workshop has our portal). A job that takes no answer says why and holds the button with that reason. No price.
 */

export interface JobLinkViewModel {
  link: LinkState
  page: LinkJobPage | null
  draft: LinkDraft
  today: string
  answer: 'idle' | 'busy' | 'done'
  end: { tone: 'success' | 'neutral'; title: Words; body: Words } | null
  problem: Words | null
  timeZone?: string
}

export interface JobLinkActions {
  onRetry?: () => void
  onDraft?: (draft: LinkDraft) => void
  onSend?: () => void
}

export function JobLinkView({ model, actions }: { model: JobLinkViewModel; actions?: JobLinkActions }) {
  return (
    <WithMessages namespaces={[LINK_NS, 'ds-words']}>
      <Page model={model} actions={actions} />
    </WithMessages>
  )
}

function useSay() {
  const t = useT(LINK_NS)
  const locale = useLocale()
  const day = (iso: string) => formatDate(`${iso.slice(0, 10)}T12:00:00Z`, { locale, timeZone: 'UTC' })
  const say = (words: Words | null) => {
    if (!words) return null
    const params = words.params ? Object.fromEntries(Object.entries(words.params).map(([name, value]) => [name, name === 'date' && typeof value === 'string' ? day(value) : value])) : undefined
    return t(words.key, params)
  }
  return { t, locale, day, say }
}

function Page({ model, actions }: { model: JobLinkViewModel; actions?: JobLinkActions }) {
  const { t } = useSay()
  const page = model.page
  const valid = model.link === 'valid'
  return (
    <LinkFrameView
      model={{
        sender: page ? { name: page.job.from.companyName } : null,
        title: page ? t('link.title', { number: page.job.number }) : null,
        body: valid ? { kind: 'task' } : { kind: 'link', state: model.link, purpose: 'JOB_ACCEPT', expiresAt: null, usesLeft: null },
        timeZone: model.timeZone,
      }}
    >
      {valid ? page ? <Body page={page} model={model} actions={actions} /> : model.problem ? <ReadProblem model={model} actions={actions} /> : <Loading /> : null}
    </LinkFrameView>
  )
}

function Loading() {
  const { t } = useSay()
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 1000)
    return () => clearTimeout(timer)
  }, [])
  return (
    <div className="fw-ljob-stack" aria-busy="true">
      <Card padded>
        <Skeleton width="50%" height={22} />
        <Skeleton width="100%" height={120} />
      </Card>
      <Card padded>
        <Skeleton width="30%" height={22} />
        <Skeleton width="100%" height={96} />
      </Card>
      <p className="fw-ljob-hint" role="status">
        {slow ? t('state.slow') : t('state.loading')}
      </p>
    </div>
  )
}

function ReadProblem({ model, actions }: { model: JobLinkViewModel; actions?: JobLinkActions }) {
  const { t, say } = useSay()
  return (
    <Banner
      tone="danger"
      title={say(model.problem) ?? t('problem.read')}
      action={
        <Button size="sm" onClick={() => actions?.onRetry?.()}>
          {t('state.retry')}
        </Button>
      }
    >
      {t('link.readBody')}
    </Banner>
  )
}

function Body({ page, model, actions }: { page: LinkJobPage; model: JobLinkViewModel; actions?: JobLinkActions }) {
  return (
    <div className="fw-ljob-stack">
      <JobPanel job={page.job} />
      {model.answer === 'done' && model.end ? <Done page={page} model={model} /> : <Answer job={page.job} model={model} actions={actions} />}
    </div>
  )
}

/** sec:job — everything to decide, on one phone screen. */
function JobPanel({ job }: { job: LinkJob }) {
  const { t, day, locale } = useSay()
  const pieces = job.operations.reduce((sum, operation) => sum + operation.pieces, 0)
  const kitDay = job.kit.sentOn.at(-1) ?? null
  return (
    <Card padded className="fw-ljob-job">
      <div className="fw-ljob-head">
        <h2 className="fw-ljob-h2">{job.operations.map((operation) => operation.name || operation.code).join(', ')}</h2>
        <Pill tone={job.state === 'TO_ANSWER' ? 'warning' : 'neutral'}>{t(`state.${job.state}`)}</Pill>
      </div>
      <KeyValue
        labelCase="sentence"
        items={[
          { label: t('facts.style'), value: `${job.workOrder.style.code} · ${job.workOrder.style.name}` },
          { label: t('facts.pieces'), value: String(pieces) },
          { label: t('link.kitArrives'), value: kitDay ? day(kitDay) : t('link.kitWeTell') },
          { label: t('facts.dueBack'), value: job.expectedBackDate ? day(job.expectedBackDate) : t('facts.noDay') },
          ...(job.note ? [{ label: t('facts.instructions'), value: job.note }] : []),
        ]}
      />
      {job.operations.map((operation) => {
        const grid = gridOf(operation.sizes)
        return (
          <section key={operation.id} className="fw-ljob-op">
            <h3 className="fw-ljob-h3">{t('sheet.operation', { seq: operation.seq, name: operation.name || operation.code, count: operation.pieces })}</h3>
            {operation.note ? <p className="fw-ljob-hint">{operation.note}</p> : null}
            {operation.sizes.length > 0 ? <SizeGridView colours={grid.colours} sizes={grid.sizes} value={grid.pieces} locale={INTL_LOCALE[locale]} copy={gridCopyOf(t)} caption={t('grid.captionOf', { operation: operation.name || operation.code })} /> : null}
          </section>
        )
      })}
      {job.kit.lines.length > 0 ? (
        <section className="fw-ljob-op">
          <h3 className="fw-ljob-h3">{t('link.kit')}</h3>
          <ul className="fw-ljob-list">
            {job.kit.lines.map((line) => (
              <li key={line.seq}>
                {line.item.name || line.item.code}
                {line.colour ? ` · ${line.colour}` : ''} · {`${locale === 'it' ? quantityText(line.quantity).replace('.', ',') : quantityText(line.quantity)} ${t(`uom.${line.uom}`)}`}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <div className="fw-ljob-noprint">
        <Button variant="quiet" onClick={() => window.print()}>
          <Printer size={16} aria-hidden /> {t('link.print')}
        </Button>
      </div>
      <p className="fw-ljob-hint">{t('noPrices')}</p>
    </Card>
  )
}

const quantityText = (quantity: string) => (quantity.includes('.') ? quantity.replace(/0+$/, '').replace(/\.$/, '') : quantity)

/** sec:answer — accept, move the date, or decline. */
function Answer({ job, model, actions }: { job: LinkJob; model: JobLinkViewModel; actions?: JobLinkActions }) {
  const { t, say, day } = useSay()
  const { draft } = model
  const closed = jobClosed(job)
  const held = model.answer === 'busy' ? t('held.busy') : say(answerHeld(draft, job, model.today))
  const set = (patch: Partial<LinkDraft>) => actions?.onDraft?.({ ...draft, ...patch })
  if (closed) {
    return (
      <Card padded className="fw-ljob-answer">
        <h2 className="fw-ljob-h2">{t('link.answer')}</h2>
        <Banner tone="info" title={say(closed)}>
          {job.answer.proposedDate ? t('answer.proposed', { date: day(job.answer.proposedDate) }) : null}
        </Banner>
      </Card>
    )
  }
  const modes: readonly AnswerMode[] = ['accept', 'move', 'decline']
  const goLabel = draft.mode === 'move' ? t('link.goMove') : draft.mode === 'decline' ? t('decline.go') : t('accept.go')
  return (
    <Card padded className="fw-ljob-answer">
      <h2 className="fw-ljob-h2">{t('link.answer')}</h2>
      <fieldset className="fw-ljob-choice">
        <legend className="fw-ljob-legend">{t('link.how')}</legend>
        {modes.map((mode) => (
          <RadioCard key={mode} name="fw-ljob-mode" title={t(`link.mode.${mode}`)} description={mode === 'accept' && job.expectedBackDate ? t('accept.askedHint', { date: day(job.expectedBackDate) }) : t(`link.modeHint.${mode}`)} selected={draft.mode === mode} checked={draft.mode === mode} onChange={() => set({ mode })} />
        ))}
      </fieldset>
      {draft.mode === 'move' ? (
        <>
          <Field label={t('accept.date')} required>
            <DateField value={draft.proposedDate} min={model.today} onChange={(value) => set({ proposedDate: value })} />
          </Field>
          <Field label={t('accept.reason')} required>
            <Textarea value={draft.reason} rows={3} honourRows maxLength={MAX_TEXT} onChange={(event) => set({ reason: event.target.value })} />
          </Field>
        </>
      ) : null}
      {draft.mode === 'decline' ? (
        <>
          <fieldset className="fw-ljob-choice">
            <legend className="fw-ljob-legend">{t('decline.reason')}</legend>
            {DECLINE_REASONS.map((reason) => (
              <RadioCard key={reason} variant="row" name="fw-ljob-decline" title={t(`decline.reasons.${reason}`)} selected={draft.declineReason === reason} checked={draft.declineReason === reason} onChange={() => set({ declineReason: reason })} />
            ))}
          </fieldset>
          <Field label={t(draft.declineReason === 'OTHER' ? 'decline.noteRequired' : 'decline.note')} required={draft.declineReason === 'OTHER'}>
            <Textarea value={draft.note} rows={3} honourRows maxLength={MAX_TEXT - 60} onChange={(event) => set({ note: event.target.value })} />
          </Field>
        </>
      ) : null}
      <Field label={t('link.name')} hint={t('link.nameHint')}>
        <Input value={draft.typedName} maxLength={MAX_NAME} autoComplete="name" onChange={(event) => set({ typedName: event.target.value })} />
      </Field>
      {model.problem ? <Banner tone="danger" title={say(model.problem)} /> : null}
      <div className="fw-ljob-go">
        <Button variant={draft.mode === 'decline' ? 'danger' : 'primary'} size="lg" block heldReason={held} onClick={() => actions?.onSend?.()}>
          {model.answer === 'busy' ? <Spinner size={14} /> : null} {goLabel}
        </Button>
      </div>
    </Card>
  )
}

/** sec:done — the end and the next steps. */
function Done({ page, model }: { page: LinkJobPage; model: JobLinkViewModel }) {
  const { t, say, locale } = useSay()
  const ds = useDsWords()
  const end = model.end!
  const answer = page.job.answer
  const name = answer.acceptedByName ?? answer.declinedByName
  const time = answer.acceptedAt ?? answer.declinedAt
  return (
    <EndState
      tone={end.tone}
      title={say(end.title)}
      body={say(end.body)}
      facts={[...(name ? [{ label: t('link.end.by'), value: name }] : []), ...(time ? [{ label: t('link.end.at'), value: formatDateTime(time, { locale, timeZone: model.timeZone }) }] : [])]}
      next={page.portalOn ? [t('link.end.portal'), t('link.end.closed')] : [t('link.end.closed')]}
      reference={{ value: page.job.number, label: t('link.end.reference') }}
      contact={{ name: page.job.from.companyName, detail: t('link.end.contact') }}
      actions={page.portalOn ? [{ label: t('link.end.openPortal'), href: '/p/signin', variant: 'secondary' }] : []}
      labels={ds.endState}
    />
  )
}
