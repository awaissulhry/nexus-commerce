'use client'

import { useEffect, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { Check, ExternalLink, MessagesSquare, PenLine, X } from 'lucide-react'
import { Banner, EmptyState, Field, KeyValue } from '@nexus/ui/components'
import { Button, Kbd, Pill, Select, Tag } from '@nexus/ui/primitives'
import { DetailModal, Modal, ReviewChangesPanel, StepUpModal, Textarea } from '../../../../lib/i18n/ds-parts'
import { formatDateTime, formatTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { ApprovalHistory } from '../../../../shell/panels/approvals/view/ApprovalHistory'
import type { TaskDetail, Words } from '../api'
import { DEPTH_NS, REVIEW_TABS, type InboxActions, type InboxViewModel, type ReviewTab } from '../model'
import { heldOf, openIdOf, valueText, type InboxRow } from '../inbox'

const said = (words: Words | null | undefined, locale: string, fallback = ''): string => (words ? (locale === 'it' ? words.it : words.en) : fallback)

/**
 * The review of one request of the approval engine (B-W2b-307; design home.approvals pop:review, pop:sign, pop:reject,
 * PLT-091, PLT-093, PLT-105): a centred DetailModal (`?open=<id>`, J / K the next and previous request, ← / → the tabs)
 * with Change (the re-check line, every field from → to, the rules that asked and their values, who else may decide),
 * Context (the record's facts and Open full page), Conversation (the request's thread) and History (every approval of its
 * record). Approve (A) — a rule with a signature opens "Approve as '<meaning>'" (the meaning, the version it binds to, a
 * fresh authenticator code) — and Reject (R: a reason of the list and words). Held with the reason before the click: my own
 * request (naming who can), not mine to decide, changed since asked, gone, offline.
 */
export function TaskReview({ model, actions, conversation, kindWords }: { model: InboxViewModel; actions?: InboxActions; conversation?: ReactNode; kindWords: (row: InboxRow) => string }) {
  const t = useT(DEPTH_NS)
  const sales = useT('sales')
  const locale = useLocale()
  const review = model.taskReview!
  const items = model.rows.items ?? []
  const row = items.find((item) => item.task?.id === review.id) ?? null
  const detail = review.detail.status === 'ready' ? review.detail.value : null
  const task = detail ?? row?.task ?? null
  const [comment, setComment] = useState(review.comment ?? '')
  const [ownTab, setOwnTab] = useState<ReviewTab>(review.tab ?? 'change')
  useEffect(() => {
    setComment(review.comment ?? '')
    setOwnTab(review.tab ?? 'change')
  }, [review.id, review.comment, review.tab])
  const tab = actions?.onTab ? (review.tab ?? 'change') : ownTab
  const setTab = (next: ReviewTab) => (actions?.onTab ? actions.onTab(next) : setOwnTab(next))

  // The held reason, from the request as read now (the detail re-reads it) else its row.
  const state = { offline: model.offline, busy: model.busy }
  const current: InboxRow | null = task ? { key: `task:${task.id}`, source: 'task', kind: task.kind, since: task.requestedAt, due: task.dueAt, overdue: task.overdue, companyId: task.companyId, task } : null
  const heldKey = current ? heldOf(current, state) : 'inbox.held.reading'
  const ownNames = detail && detail.deciders.length > 0 ? detail.deciders.slice(0, 2).map((person) => person.name).join(t('or')) : null
  const heldText = heldKey === 'inbox.held.own' && ownNames ? t('inbox.held.ownNames', { names: ownNames }) : heldKey ? t(heldKey) : null
  const rejectHeld = heldText ?? (detail && !detail.reject.allowed ? t('inbox.held.notYours') : null)
  const dialog = model.dialog
  const signs = task !== null && (task.signatureMeaning !== null || task.requireStepUp)
  const meaningWord = task?.signatureMeaning ? t(`meaning.${task.signatureMeaning}`) : null

  const approve = () => {
    if (heldText || dialog) return
    actions?.onComment?.(comment)
    actions?.onApprove?.()
  }
  const reject = () => {
    if (rejectHeld || dialog) return
    actions?.onReject?.()
  }
  // A approves, R rejects (never while typing, never with a dialog open).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (event.metaKey || event.ctrlKey || event.altKey || dialog) return
      if (target && (target.closest('input, textarea, select, [contenteditable="true"]') || target.isContentEditable)) return
      if (event.key === 'a') {
        event.preventDefault()
        approve()
      } else if (event.key === 'r') {
        event.preventDefault()
        reject()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const loaded = review.detail
  const ids = items.map(openIdOf).filter((id): id is string => id !== null)
  const tabs = REVIEW_TABS.map((id) => ({ id, label: t(`review.tab.${id}`) }))
  const recordHref = row?.href ?? null
  const title = task ? t(task.status === 'PENDING' ? 'review.title' : 'review.titleDecided', { kind: said(task.kindLabel, locale).toLocaleLowerCase(locale) }) : t('review.titleUnknown')

  const checked = detail?.recheckLine ? formatTime(detail.recheckLine.checkedAt, { locale }) : model.asOf ? formatTime(model.asOf, { locale }) : '—'
  const recheckBanner = task && task.status === 'PENDING' ? (
    task.recheck === 'CHANGED' ? (
      <Banner tone="warning" title={t('recheck.changed')}>
        {detail?.recheckLine && detail.recheckLine.changed.length > 0
          ? detail.recheckLine.changed.map((entry) => `${said(entry.label, locale, entry.field)} ${valueText(entry.was, yesNo(t))} → ${valueText(entry.now, yesNo(t))}`).join(' · ')
          : t('recheck.askAgain')}
      </Banner>
    ) : task.recheck === 'GONE' ? (
      <Banner tone="danger" title={t('recheck.gone')} />
    ) : (
      <p className="fw-apv-recheck is-current" role="status">
        {t('recheck.current', { time: checked })}
      </p>
    )
  ) : null

  const decided = detail?.decided ?? null
  const body = !task ? null : tab === 'change' ? (
    <div className="fw-apv-review">
      <Banner tone="info" title={t('review.asked', { who: task.requester.me ? t('you') : task.requester.kind === 'WORKER' ? t('aWorker') : task.requester.name, at: formatDateTime(task.requestedAt, { locale }) })}>
        {task.summary}
      </Banner>
      {decided && (
        <Banner tone={task.status === 'APPROVED' ? 'success' : 'neutral'} title={t('review.decided', { status: t(`status.${task.status}`), who: decided.by.me ? t('you') : decided.by.name, at: formatDateTime(decided.at, { locale }) })}>
          {[decided.reasonLabel ? said(decided.reasonLabel, locale) : null, decided.reason ?? decided.comment].filter(Boolean).join(' · ') || undefined}
        </Banner>
      )}
      {detail?.withdrawn && <Banner tone="neutral" title={t('review.withdrawn', { at: formatDateTime(detail.withdrawn.at, { locale }) })} />}
      {recheckBanner}
      {heldText && task.status === 'PENDING' && <Banner tone="warning" title={heldText} />}
      {detail && detail.changes.length > 0 ? (
        <ReviewChangesPanel
          label={t('review.changes', { count: detail.changes.length })}
          changes={detail.changes.map((change) => ({ id: change.field, what: said(change.label, locale, change.field), now: valueText(change.from, yesNo(t)), next: valueText(change.to, yesNo(t)) }))}
          ack={false}
          onAckChange={() => undefined}
        />
      ) : detail ? (
        <p className="fw-apv-hint">{t('review.noChanges')}</p>
      ) : null}
      <section aria-labelledby="fw-apd-rules">
        <h3 id="fw-apd-rules" className="fw-apv-h">
          {t('review.rules')}
        </h3>
        <ul className="fw-apv-list">
          {(detail?.rules ?? (task.rule ? [task.rule] : [])).map((rule) => (
            <li key={rule.id}>{said(rule.sentence, locale)}</li>
          ))}
          {(detail?.rules ?? (task.rule ? [task.rule] : [])).length === 0 && <li>{t('review.noRule')}</li>}
        </ul>
        {meaningWord && (
          <p className="fw-apv-hint">
            <PenLine size={12} aria-hidden /> {t(task.requireStepUp ? 'review.signsWithCode' : 'review.signs', { meaning: meaningWord })}
          </p>
        )}
      </section>
      {detail && (
        <p className="fw-apv-hint">{detail.deciders.length > 0 ? t('review.deciders', { names: detail.deciders.slice(0, 5).map((person) => person.name).join(', ') }) : t('review.noDeciders')}</p>
      )}
      {task.status === 'PENDING' && !heldText && (
        <Field label={t('review.comment')} hint={t('review.commentHint')}>
          <Textarea value={comment} onChange={(event) => setComment(event.target.value)} rows={2} maxLength={500} />
        </Field>
      )}
    </div>
  ) : tab === 'context' ? (
    <div className="fw-apv-review">
      <KeyValue
        dense
        labelCase="sentence"
        columns={2}
        items={[
          { label: t('context.kind'), value: row ? kindWords(row) : said(task.kindLabel, locale) },
          ...task.facts.map((fact) => ({ label: said(fact.label, locale, fact.field), value: valueText(fact.value, yesNo(t)) })),
          { label: t('context.size'), value: said(task.changeSize, locale) },
          ...(task.dueAt ? [{ label: t('context.due'), value: formatDateTime(task.dueAt, { locale }) }] : []),
        ]}
      />
      {task.facts.some((fact) => fact.grain !== null) || model.grains.price ? null : <p className="fw-apv-hint">{t('context.noMoney')}</p>}
      {recordHref && (
        <Button size="sm" variant="quiet" asChild>
          <Link href={recordHref}>
            <ExternalLink size={14} aria-hidden /> {t('context.open')}
          </Link>
        </Button>
      )}
    </div>
  ) : tab === 'conversation' ? (
    <div className="fw-apv-review">{conversation ?? <EmptyState icon={<MessagesSquare size={22} aria-hidden />} title={t('conversation.title')} description={t('conversation.body')} />}</div>
  ) : (
    <div className="fw-apv-review">
      {review.history ? (
        <ApprovalHistory model={review.history} actions={actions?.history} heading={false} />
      ) : (
        <ApprovalHistory model={{ allowed: true, read: { status: 'ready', lines: detail?.history ?? [], more: false } }} heading={false} />
      )}
    </div>
  )

  return (
    <>
      <DetailModal
        open
        onClose={() => actions?.onOpen?.(null)}
        title={title}
        subtitle={task ? task.summary : undefined}
        meta={
          task ? (
            <>
              <Pill tone={task.status === 'APPROVED' ? 'success' : task.status === 'REJECTED' ? 'danger' : task.status === 'PENDING' ? 'info' : 'neutral'}>{t(`status.${task.status}`)}</Pill>
              {meaningWord && <Tag tone="info">{t('review.meaningTag', { meaning: meaningWord })}</Tag>}
              {task.overdue && task.status === 'PENDING' && <Tag tone="danger">{t('review.overdue')}</Tag>}
            </>
          ) : undefined
        }
        tabs={tabs}
        activeTab={tab}
        onTabChange={(id) => setTab(id as ReviewTab)}
        tabsLabel={t('review.tabs')}
        nav={ids.length > 1 && ids.includes(review.id) ? { ids, current: review.id, onGo: (id) => actions?.onOpen?.(id), noun: t('review.noun') } : undefined}
        loading={loaded.status === 'loading' && !task}
        error={loaded.status !== 'loading' && loaded.status !== 'ready' ? (loaded.status === 'error' ? sales(loaded.problem) : t(`review.${loaded.status}`)) : undefined}
        onRetry={() => actions?.onRetryReview?.()}
        actions={
          task && task.status === 'PENDING' ? (
            <>
              <Button size="sm" variant="danger-outline" heldReason={rejectHeld} onClick={reject} aria-keyshortcuts="r">
                <X size={14} aria-hidden /> {t('reject')} <Kbd>R</Kbd>
              </Button>
              <Button size="sm" variant="primary" heldReason={heldText} onClick={approve} aria-keyshortcuts="a">
                <Check size={14} aria-hidden /> {meaningWord ? t('approveAs', { meaning: meaningWord }) : t('approve')} <Kbd>A</Kbd>
              </Button>
            </>
          ) : undefined
        }
      >
        {body}
      </DetailModal>
      {detail && dialog?.kind === 'sign' && signs && <SignDialog task={detail} busy={dialog.busy} problem={dialog.problem} actions={actions} />}
      {detail && dialog?.kind === 'reject' && <RejectDialog task={detail} dialog={dialog} actions={actions} />}
    </>
  )
}

const yesNo = (t: (key: string) => string) => ({ yes: t('yes'), no: t('no') })

/**
 * "Approve as 'Released'" (design pop:sign, PLT-105): what the signature means, the record version it binds to (the
 * request's fingerprint), and — when the rule asks it — a fresh authenticator code (StepUpModal). Without a code the same
 * words and Sign and approve.
 */
function SignDialog({ task, busy, problem, actions }: { task: TaskDetail; busy: boolean; problem: string | null; actions?: InboxActions }) {
  const t = useT(DEPTH_NS)
  const meaning = task.signatureMeaning ? t(`meaning.${task.signatureMeaning}`) : t('meaning.APPROVED')
  const binds = t('sign.binds', { meaning, version: task.version, print: task.fingerprint.slice(0, 12) })
  const title = t('sign.title', { meaning })
  if (task.requireStepUp) {
    return <StepUpModal open title={title} sentence={`${binds} ${t('sign.code')}`} busy={busy} error={problem ? t(problem) : null} onSubmit={(code) => actions?.onSign?.(code)} onClose={() => actions?.onCloseDialog?.()} confirmLabel={t('sign.confirm')} />
  }
  return (
    <Modal
      open
      onClose={() => actions?.onCloseDialog?.()}
      title={title}
      size="sm"
      footer={
        <>
          <Button onClick={() => actions?.onCloseDialog?.()}>{t('back')}</Button>
          <Button variant="primary" heldReason={busy ? t('inbox.held.busy') : null} onClick={() => actions?.onSign?.('')}>
            {t('sign.confirm')}
          </Button>
        </>
      }
    >
      <div className="fw-apv-review">
        <p className="fw-apv-hint">{binds}</p>
        {problem && <Banner tone="danger" title={t(problem)} />}
      </div>
    </Modal>
  )
}

/** "Reject — tell Marco why" (design pop:reject): a reason of the list "Why an approver says no" and words (both required). */
function RejectDialog({ task, dialog, actions }: { task: TaskDetail; dialog: Extract<NonNullable<InboxViewModel['dialog']>, { kind: 'reject' }>; actions?: InboxActions }) {
  const t = useT(DEPTH_NS)
  const sales = useT('sales')
  const locale = useLocale()
  const [code, setCode] = useState('')
  const [reason, setReason] = useState('')
  const reasons = dialog.reasons.status === 'ready' ? dialog.reasons.value : []
  const held = dialog.reasons.status !== 'ready' ? t('rejectDialog.held.reading') : code === '' ? t('rejectDialog.held.code') : reason.trim().length < 3 ? t('rejectDialog.held.words') : reason.trim().length > 500 ? t('rejectDialog.held.long') : dialog.busy ? t('inbox.held.busy') : null
  const go = () => {
    if (held) return
    actions?.onRejectConfirm?.(code, reason)
  }
  const who = task.requester.me ? t('you') : task.requester.kind === 'WORKER' ? t('aWorker') : task.requester.name
  return (
    <Modal
      open
      onClose={() => actions?.onCloseDialog?.()}
      title={t('rejectDialog.title', { who })}
      size="sm"
      footer={
        <>
          <Button onClick={() => actions?.onCloseDialog?.()}>{t('back')}</Button>
          <Button variant="danger" heldReason={held} onClick={go}>
            {t('reject')}
          </Button>
        </>
      }
    >
      <div
        className="fw-apv-review"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            go()
          }
        }}
      >
        <p className="fw-apv-hint">{t('rejectDialog.body')}</p>
        {dialog.reasons.status === 'error' ? (
          <Banner tone="danger" title={sales(dialog.reasons.problem)} action={<Button size="sm" onClick={() => actions?.onRetryReasons?.()}>{t('retry')}</Button>} />
        ) : (
          <Field label={t('rejectDialog.code')} required>
            <Select value={code} onChange={(event) => setCode(event.target.value)} aria-label={t('rejectDialog.code')}>
              <option value="">{t('rejectDialog.pick')}</option>
              {reasons.map((entry) => (
                <option key={entry.code} value={entry.code}>
                  {locale === 'it' ? entry.labelIt : entry.labelEn}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label={t('rejectDialog.words')} required hint={t('rejectDialog.wordsHint')}>
          <Textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={3} maxLength={500} />
        </Field>
      </div>
    </Modal>
  )
}
