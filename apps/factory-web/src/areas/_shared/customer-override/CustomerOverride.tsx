'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import Link from 'next/link'
import { Copy, ExternalLink, Gavel, Undo2 } from 'lucide-react'
import { KIND_RULES } from '@nexus/factory-domain/approvals-out/kinds'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Input, RadioCard, Spinner, Tag } from '@nexus/ui/primitives'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import { formatDateTime } from '../../../lib/i18n/format'
import { Modal, StepUpModal, Textarea } from '../../../lib/i18n/ds-parts'
import type { Locale } from '../../../lib/i18n/locales'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { companyPrefix } from '../../../lib/session/session'
import { WithMessages } from '../../../record-panels/i18n'
import { useLiveBus } from '../../../shell/live/use-live'
import { isStepUpCancelled, runWithStepUp, StepUpCancelled } from '../../admin/shared/step-up'
import { decideForParty, readOverrideRequest, readRecordRequests, reverseAnswer, stepUpWith, type OverrideRequest } from './api'
import {
  actOf,
  decideBodyOf,
  decideDraftHeld,
  decisionsFor,
  effectKey,
  emptyDecideDraft,
  factsOf,
  NAMESPACES,
  NS,
  outcomeKey,
  outcomeOfDecide,
  outcomeOfReverse,
  OVERRIDE_LIMITS,
  OVERRIDE_RIGHT,
  overrideHeld,
  overrideProblem,
  pickRequest,
  readOutcomeOf,
  reasonHeld,
  reverseWhatKey,
  stepUpProblemOf,
  taskHref,
  type DecideDraft,
  type DecideField,
  type OverrideAct,
  type OverrideFact,
  type OverrideOutcome,
  type Phrase,
} from './model'
import { CustomerOverrideContext, type CustomerOverrideProps, type CustomerOverrideScope } from './slot'
import './customer-override.css'

/**
 * F-PR-09 — "Decide for <customer>" and "Reverse" on an approval asked of a customer (production plan §3 "No silent decisions: …
 * it must use Decide for the brand (reason, brand told, second person when switched on). Undo is refused in words when the effect
 * cannot be undone"; 08-backend §4.6; lead pick L6). The page's container wraps its view in CustomerOverrideProvider; each
 * CustomerOverrideSlot of the view then draws, for its one request:
 *
 *   what was done  "Decided for Brand Alpha by Carlo Prova: …", "Reversed by … on …: …", "… waits for a second person" (its task
 *                  in Home › Approvals)
 *   the act        Decide for <customer>… on an open request; Reverse… on an answer not reversed yet — each held with its reason
 *                  (the right, the customer's own word, a second person asked already, never the person who asked, offline)
 *   the dialog     the decision (as the kind allows), the words for a change or a refusal, why we decide (the customer reads it),
 *                  the typed name; for a reversal what it does to the record and why (the customer reads it). Send asks a fresh
 *                  code (step-up) when the API wants one, then sends once with one Idempotency-Key
 *   what happened  done, or asked of a second person (its task); what the reversal did; a new date's link ONCE
 *
 * The API decides everything again (its refusals said from their codes). Another customer's request reads as nothing here
 * (404 → the part draws nothing): never "another customer's" (PW-04, PW-09 web side).
 */

interface Host {
  readonly api: ApiClient
  /** `/w/<company>`: the second person's task in Home › Approvals. */
  readonly prefix: string
  /** The reader holds production.brand.override (the API says per customer through `may`). */
  readonly can: boolean
  /** The reader's own name: the typed name's first value. */
  readonly typedName: string
  /** The page reads its own record again (a decided round, a passed gate, the counter's state). */
  readonly onDone: () => void
}

/** Gives the slots under it the part, with the signed-in person and the page's own read-again. */
export function CustomerOverrideProvider({ onDone, children }: { readonly onDone?: () => void; readonly children?: ReactNode }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const done = useRef(onDone)
  done.current = onDone
  const prefix = companyPrefix(session.company?.code ?? '')
  const can = session.permissions.includes(OVERRIDE_RIGHT)
  const typedName = session.user.displayName
  const scope = useMemo<CustomerOverrideScope>(
    () => ({ render: (props: CustomerOverrideProps) => <OverridePart {...props} host={{ api, prefix, can, typedName, onDone: () => done.current?.() }} /> }),
    [api, prefix, can, typedName],
  )
  return <CustomerOverrideContext.Provider value={scope}>{children}</CustomerOverrideContext.Provider>
}

function OverridePart(props: CustomerOverrideProps & { readonly host: Host }) {
  return (
    <WithMessages namespaces={NAMESPACES}>
      <Part {...props} />
    </WithMessages>
  )
}

type Read = { readonly status: 'loading' } | { readonly status: 'ready'; readonly request: OverrideRequest | null } | { readonly status: 'hidden' } | { readonly status: 'failed'; readonly problem: string }

type Fields = Partial<Record<DecideField, Phrase>>

// F-PR-16: exported for the design case (fixtures.ts), as are the two dialogs below.
export type Dialog =
  | { readonly act: 'decide'; readonly draft: DecideDraft; readonly problem: Phrase | null; readonly fields: Fields }
  | { readonly act: 'reverse'; readonly reason: string; readonly problem: Phrase | null; readonly fields: Fields }

interface StepUpState {
  readonly open: boolean
  readonly busy: boolean
  /** A key of this catalogue (the code refused). */
  readonly problem: string | null
}

const STEP_UP_CLOSED: StepUpState = Object.freeze({ open: false, busy: false, problem: null })

const subtitleOf = (request: OverrideRequest, locale: Locale): string => `${KIND_RULES[request.kind].name[locale]} · ${request.record.words[locale]}`

function Part({ source, customer, version, layout = 'block', host }: CustomerOverrideProps & { readonly host: Host }) {
  const t = useT(NS)
  const locale = useLocale()
  const { api } = host
  const requestId = 'requestId' in source ? source.requestId : null
  const recordType = 'record' in source ? source.record.type : null
  const recordId = 'record' in source ? source.record.id : null
  const [read, setRead] = useState<Read>({ status: 'loading' })
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<OverrideOutcome | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [stepUp, setStepUp] = useState<StepUpState>(STEP_UP_CLOSED)
  const waiting = useRef<{ resolve: () => void; reject: (error: unknown) => void } | null>(null)
  const turn = useRef(0)
  const shown = read.status === 'ready' ? read.request : null
  const shownRef = useRef(shown)
  shownRef.current = shown
  const dialogRef = useRef(dialog)
  dialogRef.current = dialog

  const load = useCallback(async () => {
    const mine = ++turn.current
    try {
      const request = requestId !== null ? await readOverrideRequest(api, requestId) : recordType !== null && recordId !== null ? pickRequest(await readRecordRequests(api, { type: recordType, id: recordId })) : null
      if (mine === turn.current) setRead({ status: 'ready', request })
    } catch (error) {
      if (mine !== turn.current) return
      const failed = readOutcomeOf(error)
      setRead(failed.hidden ? { status: 'hidden' } : { status: 'failed', problem: failed.problem })
    }
  }, [api, requestId, recordType, recordId])

  useEffect(() => {
    void load()
  }, [load, version])

  // Someone answered, decided or reversed it meanwhile (another tab, the customer, the second person's yes): read it again.
  const live = useLiveBus(
    {
      onChange: (change) => {
        if (!change.type.startsWith('approval_request.')) return
        const fields = change.fields
        const now = shownRef.current
        const ours =
          (requestId !== null && fields.requestId === requestId) ||
          (recordType !== null && fields.recordType === recordType && fields.recordId === recordId) ||
          (now !== null && (fields.requestId === now.id || (fields.recordType === now.record.type && fields.recordId === now.record.id)))
        if (ours) void load()
      },
      onReconnect: () => void load(),
    },
    read.status !== 'hidden',
  )

  // ---- the fresh code (step-up): asked only when the API wants one, at the moment of the act ----
  const askForCode = () =>
    new Promise<void>((resolve, reject) => {
      waiting.current = { resolve, reject }
      setStepUp({ open: true, busy: false, problem: null })
    })
  const submitCode = async (code: string) => {
    setStepUp((now) => ({ ...now, busy: true, problem: null }))
    try {
      await stepUpWith(api, code)
      setStepUp(STEP_UP_CLOSED)
      waiting.current?.resolve()
      waiting.current = null
    } catch (error) {
      setStepUp((now) => ({ ...now, busy: false, problem: stepUpProblemOf(error) }))
    }
  }
  const cancelCode = () => {
    setStepUp(STEP_UP_CLOSED)
    waiting.current?.reject(new StepUpCancelled())
    waiting.current = null
  }

  // ---- the acts ----
  const finish = (done: OverrideOutcome, request: OverrideRequest) => {
    setDialog(null)
    setOutcome(done)
    setCopied(null)
    setRead((now) => (now.status === 'ready' && now.request?.id === request.id ? { status: 'ready', request } : now))
    void load()
    host.onDone()
  }
  const refused = (error: unknown) => {
    if (isStepUpCancelled(error)) return
    const problem = overrideProblem(error)
    setDialog((now) => (now ? { ...now, problem: problem.phrase, fields: problem.fields } : now))
    if (problem.reload) void load()
  }
  const sendDecide = async () => {
    const current = dialogRef.current
    const request = shownRef.current
    if (!current || current.act !== 'decide' || !request || busy) return
    const decision = current.draft.decision
    if (decision === null || decideDraftHeld(request.kind, current.draft) !== null) return
    setBusy(true)
    const key = newIdempotencyKey()
    try {
      const answer = await runWithStepUp(() => decideForParty(api, request.id, decideBodyOf(request, { ...current.draft, decision }), key), askForCode)
      finish(outcomeOfDecide(answer), answer.request)
    } catch (error) {
      refused(error)
    } finally {
      setBusy(false)
    }
  }
  const sendReverse = async () => {
    const current = dialogRef.current
    const request = shownRef.current
    if (!current || current.act !== 'reverse' || !request || busy || reasonHeld(current.reason) !== null) return
    setBusy(true)
    const key = newIdempotencyKey()
    try {
      const answer = await runWithStepUp(() => reverseAnswer(api, request.id, { version: request.version, reason: current.reason.trim() }, key), askForCode)
      finish(outcomeOfReverse(answer), answer.request)
    } catch (error) {
      refused(error)
    } finally {
      setBusy(false)
    }
  }
  const openAct = (act: OverrideAct) => {
    setOutcome(null)
    setDialog(act === 'decide' ? { act: 'decide', draft: emptyDecideDraft(host.typedName), problem: null, fields: {} } : { act: 'reverse', reason: '', problem: null, fields: {} })
  }
  const copyLink = (link: string) => {
    void navigator.clipboard?.writeText(link).then(
      () => setCopied('done.copied'),
      () => setCopied('done.copyFailed'),
    )
  }

  if (read.status === 'hidden') return null
  if (read.status === 'loading') return layout === 'row' ? null : <p className="fw-cov-hint" aria-busy="true">{t('read.loading')}</p>
  if (read.status === 'failed') {
    return (
      <span className="fw-cov-line">
        <span className="fw-cov-hint">{t(read.problem)}</span>
        <Button size="sm" variant="quiet" onClick={() => void load()}>
          {t('read.retry')}
        </Button>
      </span>
    )
  }
  const request = read.request
  if (!request) return null
  const act = actOf(request)
  const facts = factsOf(request)
  if (act === null && facts.length === 0 && outcome === null) return null
  const say = (phrase: Phrase | null): string | null => (phrase ? t(phrase.key, { customer, ...phrase.params }) : null)
  const held = act ? overrideHeld(request, act, { can: host.can, offline: live === 'offline', busy, locale }) : null
  const button = act ? (
    <Button size="sm" variant={act === 'decide' ? 'secondary' : 'quiet'} heldReason={say(held)} aria-haspopup="dialog" onClick={() => openAct(act)}>
      {act === 'decide' ? <Gavel size={13} aria-hidden /> : <Undo2 size={13} aria-hidden />} {t(act === 'decide' ? 'act.decide' : 'act.reverse', { customer })}
    </Button>
  ) : null
  const dialogs = (
    <>
      {dialog?.act === 'decide' && (
        <DecideDialog
          request={request}
          customer={customer}
          dialog={dialog}
          busy={busy}
          onDraft={(patch) => setDialog((now) => (now?.act === 'decide' ? { ...now, draft: { ...now.draft, ...patch }, problem: null, fields: {} } : now))}
          onSend={() => void sendDecide()}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.act === 'reverse' && (
        <ReverseDialog
          request={request}
          customer={customer}
          dialog={dialog}
          busy={busy}
          onReason={(reason) => setDialog((now) => (now?.act === 'reverse' ? { ...now, reason, problem: null, fields: {} } : now))}
          onSend={() => void sendReverse()}
          onClose={() => setDialog(null)}
        />
      )}
      {stepUp.open && (
        <StepUpModal
          open
          title={t('stepUp.title')}
          sentence={t('stepUp.sentence', { customer })}
          busy={stepUp.busy}
          error={stepUp.problem ? t(stepUp.problem) : null}
          onSubmit={(code) => void submitCode(code)}
          onClose={cancelCode}
          confirmLabel={t('stepUp.confirm')}
        />
      )}
    </>
  )

  if (layout === 'row') {
    return (
      <span className="fw-cov-row">
        {button}
        {facts.map((fact) => (
          <Tag key={fact.kind} tone={fact.kind === 'pending' ? 'info' : 'neutral'}>
            {t(`row.${fact.kind}`)}
          </Tag>
        ))}
        {outcome && <Tag tone={outcome.secondPerson ? 'info' : 'success'}>{t(outcome.secondPerson ? 'row.asked' : 'row.done')}</Tag>}
        {dialogs}
      </span>
    )
  }

  return (
    <div className="fw-cov-part">
      {facts.map((fact) => (
        <FactLine key={fact.kind} fact={fact} customer={customer} prefix={host.prefix} />
      ))}
      {outcome && <OutcomeBanner outcome={outcome} customer={customer} prefix={host.prefix} copied={copied} onCopy={copyLink} onDismiss={() => setOutcome(null)} />}
      {button && <span className="fw-cov-line">{button}</span>}
      {dialogs}
    </div>
  )
}

/** One thing done: decided for the customer, its answer reversed, an override waiting for a second person (with its task). */
function FactLine({ fact, customer, prefix }: { readonly fact: OverrideFact; readonly customer: string; readonly prefix: string }) {
  const t = useT(NS)
  const locale = useLocale()
  if (fact.kind === 'pending') {
    return (
      <span className="fw-cov-line">
        <span className="fw-cov-text">{t(`fact.pending.${fact.act}`, { customer })}</span>
        <Button size="sm" variant="quiet" asChild>
          <Link href={taskHref(prefix, fact.taskId)}>
            <ExternalLink size={13} aria-hidden /> {t('fact.openTask')}
          </Link>
        </Button>
      </span>
    )
  }
  if (fact.kind === 'decidedFor') return <p className="fw-cov-text">{t(fact.name ? 'fact.decidedFor' : 'fact.decidedForUs', { customer, name: fact.name ?? '', reason: fact.reason })}</p>
  return <p className="fw-cov-text">{t(fact.name ? 'fact.reversed' : 'fact.reversedUs', { name: fact.name ?? '', when: formatDateTime(fact.at, { locale }), reason: fact.reason })}</p>
}

/** What happened: done (and what a reversal did), or asked of a second person (its task); a new date's link once, to pass on. */
function OutcomeBanner({
  outcome,
  customer,
  prefix,
  copied,
  onCopy,
  onDismiss,
}: {
  readonly outcome: OverrideOutcome
  readonly customer: string
  readonly prefix: string
  readonly copied: string | null
  readonly onCopy: (link: string) => void
  readonly onDismiss: () => void
}) {
  const t = useT(NS)
  const effects = outcome.effects.map((effect) => t(effectKey(effect))).join(' ')
  const link = outcome.link
  return (
    <Banner
      tone={outcome.secondPerson ? 'info' : 'success'}
      title={t(outcomeKey(outcome), { customer })}
      onDismiss={onDismiss}
      action={
        outcome.secondPerson && outcome.taskId ? (
          <Button size="sm" variant="quiet" asChild>
            <Link href={taskHref(prefix, outcome.taskId)}>
              <ExternalLink size={13} aria-hidden /> {t('fact.openTask')}
            </Link>
          </Button>
        ) : undefined
      }
    >
      {effects !== '' && <span className="fw-cov-text">{effects}</span>}
      {link && (
        <span className="fw-cov-line">
          <span className="fw-cov-url">{link}</span>
          <Button size="sm" onClick={() => onCopy(link)}>
            <Copy size={13} aria-hidden /> {t('done.copy')}
          </Button>
          <span className="fw-cov-hint">{t('done.linkOnce', { customer })}</span>
        </span>
      )}
      {copied && <span className="fw-cov-hint">{t(copied)}</span>}
    </Banner>
  )
}

/** ⌘↵ / Ctrl+↵ sends, only while nothing holds it. */
const sendKeys = (held: string | null, onSend: () => void) => (event: KeyboardEvent<HTMLElement>) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && held === null) {
    event.preventDefault()
    onSend()
  }
}

/** "Decide for <customer>": the decision as the kind allows, the words for a change or a refusal, why (they read it), the typed name. */
export function DecideDialog({
  request,
  customer,
  dialog,
  busy,
  onDraft,
  onSend,
  onClose,
}: {
  readonly request: OverrideRequest
  readonly customer: string
  readonly dialog: Extract<Dialog, { act: 'decide' }>
  readonly busy: boolean
  readonly onDraft: (patch: Partial<DecideDraft>) => void
  readonly onSend: () => void
  readonly onClose: () => void
}) {
  const t = useT(NS)
  const locale = useLocale()
  const draft = dialog.draft
  const held: Phrase | null = busy ? { key: 'held.busy' } : decideDraftHeld(request.kind, draft)
  const heldText = held ? t(held.key, { customer, ...held.params }) : null
  const fieldError = (field: DecideField): string | undefined => (dialog.fields[field] ? t(dialog.fields[field]!.key) : undefined)
  const words = draft.decision !== null && draft.decision !== 'APPROVED' ? draft.decision : null
  return (
    <Modal
      open
      onClose={onClose}
      title={t('decide.title', { customer })}
      subtitle={subtitleOf(request, locale)}
      size="md"
      footer={
        <>
          <Button size="sm" variant="quiet" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" heldReason={heldText} onClick={onSend} aria-keyshortcuts="Meta+Enter Control+Enter">
            {busy ? <Spinner size={12} /> : <Gavel size={13} aria-hidden />} {t('decide.go', { customer })}
          </Button>
        </>
      }
    >
      {/* F-PR-16: no <form> — Enter in a one-line field (the typed name) sends nothing; the send button and ⌘↵ send. */}
      <div className="fw-cov-form" onKeyDown={sendKeys(heldText, onSend)}>
        {dialog.problem && <Banner tone="danger" title={t(dialog.problem.key, { customer, ...dialog.problem.params })} />}
        <p className="fw-cov-text">{t('decide.body', { customer })}</p>
        {request.question.trim() !== '' && <p className="fw-cov-hint">{t('decide.asked', { question: request.question, due: formatDateTime(request.dueAt, { locale }) })}</p>}
        <fieldset className="fw-cov-radios">
          <legend className="fw-cov-legend">{t('decide.legend')}</legend>
          {decisionsFor(request.kind).map((decision) => (
            <RadioCard
              key={decision}
              name={`decide-for-${request.id}`}
              value={decision}
              title={t(`decision.${decision}`)}
              description={t(`decision.hint.${decision}`, { customer })}
              checked={draft.decision === decision}
              selected={draft.decision === decision}
              onChange={() => onDraft({ decision })}
            />
          ))}
        </fieldset>
        {dialog.fields.decision && <p className="fw-cov-error">{t(dialog.fields.decision.key)}</p>}
        {words && (
          <Field label={t(words === 'REFUSED' ? 'decide.why' : 'decide.changes')} hint={t('decide.answerHint', { customer })} required error={fieldError('answer')}>
            <Textarea value={draft.answer} rows={3} honourRows limit={OVERRIDE_LIMITS.answer} onChange={(event) => onDraft({ answer: event.target.value })} />
          </Field>
        )}
        <Field label={t('decide.reason')} hint={t('decide.reasonHint', { customer, max: OVERRIDE_LIMITS.reason })} required error={fieldError('reason')}>
          <Textarea value={draft.reason} rows={3} honourRows limit={OVERRIDE_LIMITS.reason} onChange={(event) => onDraft({ reason: event.target.value })} />
        </Field>
        <Field label={t('decide.typedName')} hint={t('decide.typedNameHint', { customer })} required error={fieldError('typedName')}>
          <Input value={draft.typedName} maxLength={OVERRIDE_LIMITS.typedName} autoComplete="name" onChange={(event) => onDraft({ typedName: event.target.value })} />
        </Field>
        <p className="fw-cov-hint">{t('decide.stepUp')}</p>
        <p className="fw-cov-hint">{t('decide.secondPerson')}</p>
      </div>
    </Modal>
  )
}

/** "Reverse": what it does to the record, the answer it reverses, why (the customer reads it). */
export function ReverseDialog({
  request,
  customer,
  dialog,
  busy,
  onReason,
  onSend,
  onClose,
}: {
  readonly request: OverrideRequest
  readonly customer: string
  readonly dialog: Extract<Dialog, { act: 'reverse' }>
  readonly busy: boolean
  readonly onReason: (reason: string) => void
  readonly onSend: () => void
  readonly onClose: () => void
}) {
  const t = useT(NS)
  const locale = useLocale()
  const held: Phrase | null = busy ? { key: 'held.busy' } : reasonHeld(dialog.reason)
  const heldText = held ? t(held.key, { customer, ...held.params }) : null
  const answer = request.answer
  return (
    <Modal
      open
      onClose={onClose}
      title={t('reverse.title', { customer })}
      subtitle={subtitleOf(request, locale)}
      size="md"
      footer={
        <>
          <Button size="sm" variant="quiet" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="danger" heldReason={heldText} onClick={onSend} aria-keyshortcuts="Meta+Enter Control+Enter">
            {busy ? <Spinner size={12} /> : <Undo2 size={13} aria-hidden />} {t('reverse.go')}
          </Button>
        </>
      }
    >
      {/* F-PR-16: no <form> — Enter in a one-line field (the typed name) sends nothing; the send button and ⌘↵ send. */}
      <div className="fw-cov-form" onKeyDown={sendKeys(heldText, onSend)}>
        {dialog.problem && <Banner tone="danger" title={t(dialog.problem.key, { customer, ...dialog.problem.params })} />}
        {answer && (
          <p className="fw-cov-hint">
            {t(answer.via === 'OFFICE' ? 'reverse.answerOurs' : 'reverse.answer', { customer, state: t(`status.${request.status}`), when: formatDateTime(answer.at, { locale }), name: answer.typedName })}
          </p>
        )}
        <p className="fw-cov-text">{t('reverse.body', { customer })}</p>
        <p className="fw-cov-text">{t(reverseWhatKey(request), { customer })}</p>
        <Field label={t('reverse.reason')} hint={t('reverse.reasonHint', { customer, max: OVERRIDE_LIMITS.reason })} required error={dialog.fields.reason ? t(dialog.fields.reason.key) : undefined}>
          <Textarea value={dialog.reason} rows={3} honourRows limit={OVERRIDE_LIMITS.reason} onChange={(event) => onReason(event.target.value)} />
        </Field>
        <p className="fw-cov-hint">{t('decide.stepUp')}</p>
        <p className="fw-cov-hint">{t('decide.secondPerson')}</p>
      </div>
    </Modal>
  )
}
