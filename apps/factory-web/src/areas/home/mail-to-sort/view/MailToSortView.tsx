'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Download, Image as ImageIcon, Inbox, MailQuestion, Paperclip, ShieldAlert } from 'lucide-react'
import { Banner, EmptyState, Field, KeyValue, PressableRow } from '@nexus/ui/components'
import { Button, Input, RadioCard, SegmentedControl, Spinner, Tag } from '@nexus/ui/primitives'
import { DetailModal, Modal } from '../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import {
  mailActions,
  matchCandidates,
  mailDocument,
  MAIL_FILTERS,
  PERSON_REJECT_REASONS,
  releaseTarget,
  remotePictureCount,
  senderLine,
  statusLook,
  verdictWarnings,
  type MailDetail,
  type MailDialog,
  type MailFilter,
  type MailSummary,
  type MailToSortViewModel,
  type PersonRejectReason,
  type RecordCandidate,
} from '../model'
import '../mail-to-sort.css'

export type { MailToSortViewModel } from '../model'

/** What the page asks of its container (MailToSort.tsx). Absent in the design index: the screen still opens and types. */
export interface MailToSortActions {
  onFilter?: (filter: MailFilter) => void
  onOpen?: (id: string) => void
  onClose?: () => void
  onMore?: () => void
  onRetry?: () => void
  /** The assign dialog opened: read the records it offers. */
  onAssignOpen?: () => void
  /** The person typed a number in the assign dialog: read the records that match (debounced). */
  onAssignSearch?: (query: string) => void
  /** Each answer resolves true when it was done (the dialog then closes). */
  onAssign?: (mail: MailDetail, record: RecordCandidate) => Promise<boolean>
  onRelease?: (mail: MailDetail, reason: string) => Promise<boolean>
  onReject?: (mail: MailDetail, reason: PersonRejectReason, note: string) => Promise<boolean>
  onDownload?: (fileId: string) => void
  onShowPictures?: (show: boolean) => void
  onDismissNotice?: () => void
}

const STATUS_ICON = { TRIAGE: Inbox, HELD: ShieldAlert, FAILED: AlertTriangle } as const

/** A reason a person types (release, reject): empty, or 3 to 500 characters. */
const reasonHeld = (text: string): boolean => {
  const length = text.trim().length
  return length > 0 && (length < 3 || length > 500)
}

/**
 * SCR-019 — Mail to sort (Home; A2 §2.1): received mail no record took, held mail, and mail that could not be read. The
 * list filters by place; a mail opens in the design system's DetailModal with its sanitised body in a sandboxed frame
 * (remote pictures only when allowed), its attachments, its checks and why it waits; the answers are dialogs: assign it
 * to a record (found by number), release a held one, or throw it away as spam or not for us. It draws ONE view model
 * and fetches nothing (MailToSort.tsx loads it).
 */
export function MailToSortView({ model, actions }: { model: MailToSortViewModel; actions?: MailToSortActions }) {
  return (
    <WithMessages namespaces={['home']}>
      <MailToSort model={model} actions={actions} />
    </WithMessages>
  )
}

function MailToSort({ model, actions }: { model: MailToSortViewModel; actions?: MailToSortActions }) {
  const t = useT('home')
  const locale = useLocale()
  const { items, more, problem } = model.mails

  return (
    <div className="fw-mts">
      <p className="fw-mts-intro">{t('mailToSort.intro')}</p>
      <div className="fw-mts-toolbar">
        <SegmentedControl
          ariaLabel={t('mailToSort.filterLabel')}
          size="sm"
          wrap
          value={model.filter}
          onChange={(value) => actions?.onFilter?.(value as MailFilter)}
          options={MAIL_FILTERS.map((filter) => ({ value: filter, label: t(`mailToSort.filter.${filter}`) }))}
        />
        {items && items.length > 0 && (
          <span className="fw-mts-count" role="status">
            {t(more ? 'mailToSort.countMore' : 'mailToSort.count', { count: items.length })}
          </span>
        )}
      </div>

      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={t(model.notice.key)}
          action={actions?.onDismissNotice ? <Button size="sm" variant="quiet" onClick={actions.onDismissNotice}>{t('mailToSort.dismiss')}</Button> : undefined}
        />
      )}

      {problem ? (
        <Banner tone="danger" title={t(problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('mailToSort.retry')}</Button>} />
      ) : items === null ? (
        <p className="fw-mts-loading" role="status">
          <Spinner size={14} /> {t('mailToSort.loading')}
        </p>
      ) : items.length === 0 ? (
        <EmptyState icon={<MailQuestion size={24} aria-hidden />} title={t(`mailToSort.empty.${model.filter}.title`)} description={t(`mailToSort.empty.${model.filter}.body`)} />
      ) : (
        <ul className="fw-mts-list" aria-label={t('mailToSort.listLabel')}>
          {items.map((mail) => {
            const Icon = STATUS_ICON[mail.status as keyof typeof STATUS_ICON] ?? Inbox
            const look = statusLook(mail)
            return (
              <li key={mail.id}>
                <PressableRow
                  stacked
                  className="fw-mts-row"
                  current={model.open?.id === mail.id}
                  leading={<Icon size={18} />}
                  label={mail.subject ?? t('mailToSort.noSubject')}
                  onClick={() => actions?.onOpen?.(mail.id)}
                >
                  <span className="fw-mts-row-body">
                    <span className="fw-mts-row-line">
                      <span className="fw-mts-sender">{senderLine(mail.from) ?? t('mailToSort.unknownSender')}</span>
                      <time dateTime={mail.receivedAt}>{formatDateTime(mail.receivedAt, { locale })}</time>
                    </span>
                    {mail.excerpt && <span className="fw-mts-excerpt">{mail.excerpt}</span>}
                    <span className="fw-mts-tags">
                      <Tag tone={look.tone}>{t(look.key)}</Tag>
                      {mail.heldReason && <Tag tone="warning">{t(`mailToSort.heldReason.${mail.heldReason}.short`)}</Tag>}
                      {mail.attachmentCount > 0 && (
                        <Tag tone="neutral">
                          <Paperclip size={11} className="fw-mts-tag-icon" aria-hidden />
                          {t('mailToSort.attachmentCount', { count: mail.attachmentCount })}
                        </Tag>
                      )}
                      {mail.suggestedPartyId && <Tag tone="info">{t('mailToSort.suggested')}</Tag>}
                    </span>
                  </span>
                </PressableRow>
              </li>
            )
          })}
        </ul>
      )}
      {more && items && items.length > 0 && (
        <div className="fw-mts-more">
          <Button size="sm" onClick={() => actions?.onMore?.()}>
            {t('mailToSort.more')}
          </Button>
        </div>
      )}

      <MailDetailModal model={model} actions={actions} />
    </div>
  )
}

function MailDetailModal({ model, actions }: { model: MailToSortViewModel; actions?: MailToSortActions }) {
  const t = useT('home')
  const locale = useLocale()
  const [dialog, setDialog] = useState<MailDialog | null>(null)
  useEffect(() => setDialog(model.dialog ?? null), [model.dialog, model.open?.id])
  const detail = model.open?.detail ?? null
  const summary = detail ?? (model.open ? (model.mails.items?.find((mail) => mail.id === model.open?.id) ?? null) : null)
  const look = summary ? statusLook(summary) : null
  const open = (next: MailDialog) => {
    if (next === 'assign') actions?.onAssignOpen?.()
    setDialog(next)
  }

  return (
    <>
      <DetailModal
        open={!!model.open}
        onClose={() => actions?.onClose?.()}
        title={summary?.subject ?? t('mailToSort.noSubject')}
        subtitle={summary ? `${senderLine(summary.from) ?? t('mailToSort.unknownSender')} · ${formatDateTime(summary.receivedAt, { locale })}` : undefined}
        meta={
          summary && look ? (
            <>
              <Tag tone={look.tone}>{t(look.key)}</Tag>
              {summary.heldReason && <Tag tone="warning">{t(`mailToSort.heldReason.${summary.heldReason}.short`)}</Tag>}
            </>
          ) : undefined
        }
        actions={
          detail ? (
            <>
              {mailActions(detail, model.canWrite).map(({ action, held }) => (
                <Button
                  key={action}
                  size="sm"
                  variant={action === 'reject' ? 'danger-outline' : action === 'assign' && detail.status === 'TRIAGE' ? 'primary' : action === 'release' ? 'primary' : 'secondary'}
                  heldReason={held ? t(held) : model.busy ? t('mailToSort.held.busy') : null}
                  onClick={() => open(action)}
                >
                  {t(`mailToSort.action.${action}`)}
                </Button>
              ))}
            </>
          ) : undefined
        }
      >
        {model.open?.problem ? (
          <Banner tone="danger" title={t(model.open.problem)} />
        ) : !detail ? (
          <p className="fw-mts-loading" role="status">
            <Spinner size={14} /> {t('mailToSort.reading')}
          </p>
        ) : (
          <MailBody detail={detail} model={model} actions={actions} />
        )}
      </DetailModal>

      {detail && dialog === 'assign' && <AssignDialog detail={detail} model={model} actions={actions} onClose={() => setDialog(null)} />}
      {detail && dialog === 'release' && <ReleaseDialog detail={detail} model={model} actions={actions} onClose={() => setDialog(null)} />}
      {detail && dialog === 'reject' && <RejectDialog detail={detail} model={model} actions={actions} onClose={() => setDialog(null)} />}
    </>
  )
}

function MailBody({ detail, model, actions }: { detail: MailDetail; model: MailToSortViewModel; actions?: MailToSortActions }) {
  const t = useT('home')
  const locale = useLocale()
  const pictures = remotePictureCount(detail.bodyHtml)
  const allow = model.showPictures ?? false
  const warnings = verdictWarnings(detail.verdicts)
  const srcDoc = useMemo(() => (detail.bodyHtml ? mailDocument(detail.bodyHtml, { allowPictures: allow }) : null), [detail.bodyHtml, allow])
  const why =
    detail.status === 'HELD' && detail.heldReason
      ? t(`mailToSort.heldReason.${detail.heldReason}.body`)
      : detail.status === 'TRIAGE'
        ? t('mailToSort.why.TRIAGE')
        : detail.status === 'FAILED'
          ? t('mailToSort.why.FAILED', { count: detail.attempts })
          : null
  const checks = (['spf', 'dkim', 'dmarc', 'spam', 'virus'] as const).map((check) => (
    <Tag key={check} tone={warnings.includes(check) ? 'danger' : detail.verdicts[check] === 'PASS' ? 'success' : 'neutral'}>
      {t(`mailToSort.check.${check}`)} {t(`mailToSort.verdict.${check === 'spam' || check === 'virus' ? 'content' : 'auth'}.${detail.verdicts[check]}`)}
    </Tag>
  ))
  return (
    <div className="fw-mts-detail">
      {why && (
        <Banner tone={detail.status === 'FAILED' ? 'danger' : detail.status === 'HELD' ? 'warning' : 'info'} title={t(`mailToSort.whyTitle.${detail.status}`)}>
          {why}
        </Banner>
      )}
      {detail.suggestedPartyId && detail.status !== 'FAILED' && <p className="fw-mts-hint">{t('mailToSort.suggestedBody')}</p>}
      <KeyValue
        dense
        labelCase="sentence"
        columns={2}
        items={[
          { label: t('mailToSort.field.from'), value: senderLine(detail.from) ?? t('mailToSort.unknownSender') },
          { label: t('mailToSort.field.received'), value: formatDateTime(detail.receivedAt, { locale }) },
          { label: t('mailToSort.field.to'), value: detail.to.join(', ') || '—' },
          ...(detail.cc.length > 0 ? [{ label: t('mailToSort.field.cc'), value: detail.cc.join(', ') }] : []),
          { label: t('mailToSort.field.checks'), value: <span className="fw-mts-tags">{checks}</span> },
        ]}
      />

      <section className="fw-mts-section" aria-label={t('mailToSort.bodyLabel')}>
        {srcDoc ? (
          <>
            {pictures > 0 && (
              <div className="fw-mts-pictures">
                <span className="fw-mts-hint">
                  <ImageIcon size={14} className="fw-mts-tag-icon" aria-hidden />
                  {t(allow ? 'mailToSort.pictures.shown' : 'mailToSort.pictures.blocked', { count: pictures })}
                </span>
                <Button size="sm" variant="quiet" onClick={() => actions?.onShowPictures?.(!allow)}>
                  {t(allow ? 'mailToSort.pictures.hide' : 'mailToSort.pictures.show')}
                </Button>
              </div>
            )}
            <iframe className="fw-mts-frame" title={t('mailToSort.frameTitle')} sandbox="allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" srcDoc={srcDoc} />
          </>
        ) : detail.bodyText ? (
          <div className="fw-mts-text">{detail.bodyText}</div>
        ) : (
          <p className="fw-mts-hint">{t(detail.status === 'FAILED' ? 'mailToSort.noBodyFailed' : 'mailToSort.noBody')}</p>
        )}
      </section>

      {detail.attachments.length > 0 && (
        <section className="fw-mts-section" aria-label={t('mailToSort.attachmentsLabel')}>
          <h3 className="fw-mts-heading">{t('mailToSort.attachments', { count: detail.attachments.length })}</h3>
          <ul className="fw-mts-attachments">
            {detail.attachments.map((attachment, index) => (
              <li key={`${index}:${attachment.name}`} className="fw-mts-attachment">
                <Paperclip size={14} aria-hidden />
                <span className="fw-mts-attachment-name">{attachment.name}</span>
                <span className="fw-mts-hint">{sizeWords(attachment.sizeBytes, locale)}</span>
                {attachment.kept ? (
                  attachment.fileId ? (
                    <Button
                      size="sm"
                      variant="quiet"
                      heldReason={model.canReadFiles ? null : t('mailToSort.held.noFiles')}
                      onClick={() => attachment.fileId && actions?.onDownload?.(attachment.fileId)}
                      aria-label={t('mailToSort.downloadNamed', { name: attachment.name })}
                    >
                      <Download size={14} aria-hidden /> {t('mailToSort.download')}
                    </Button>
                  ) : (
                    <span className="fw-mts-hint">{t('mailToSort.keptLater')}</span>
                  )
                ) : (
                  <Tag tone="neutral">{t(`mailToSort.skip.${attachment.skipReason ?? 'type_not_allowed'}`)}</Tag>
                )}
              </li>
            ))}
          </ul>
          <p className="fw-mts-hint">{t('mailToSort.attachmentsNote')}</p>
        </section>
      )}
    </div>
  )
}

const sizeWords = (bytes: number, locale: string) =>
  bytes >= 1_048_576 ? `${(bytes / 1_048_576).toLocaleString(locale, { maximumFractionDigits: 1 })} MB` : `${Math.max(1, Math.round(bytes / 1024)).toLocaleString(locale)} KB`

interface DialogProps {
  detail: MailDetail
  model: MailToSortViewModel
  actions?: MailToSortActions
  onClose: () => void
}

function AssignDialog({ detail, model, actions, onClose }: DialogProps) {
  const t = useT('home')
  const [query, setQuery] = useState('')
  const [chosen, setChosen] = useState<RecordCandidate | null>(null)
  const candidates = model.assign.candidates
  const matches = useMemo(() => matchCandidates(candidates ?? [], query), [candidates, query])
  const withoutParty = (candidates ?? []).filter((candidate) => !candidate.hasParty).length
  const held = model.busy ? t('mailToSort.held.busy') : !chosen ? t('mailToSort.assign.held') : null
  const keyOf = (candidate: RecordCandidate) => `${candidate.type}:${candidate.id}`
  // The modules search their numbers on the server: ask again a moment after the typing stops (the list opened with '').
  const searchRef = useRef(actions?.onAssignSearch)
  searchRef.current = actions?.onAssignSearch
  const typed = useRef(false)
  useEffect(() => {
    if (!typed.current) return
    const timer = setTimeout(() => searchRef.current?.(query), 250)
    return () => clearTimeout(timer)
  }, [query])
  const go = () => {
    if (!chosen || held) return
    void actions?.onAssign?.(detail, chosen).then((done) => done && onClose())
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={t('mailToSort.assign.title')}
      size="md"
      footer={
        <>
          <Button onClick={onClose}>{t('mailToSort.cancel')}</Button>
          <Button variant="primary" heldReason={held} onClick={go}>
            {t('mailToSort.assign.go')}
          </Button>
        </>
      }
    >
      <div className="fw-mts-dialog">
        <p className="fw-mts-hint">{t('mailToSort.assign.body')}</p>
        {model.assign.problem ? (
          <Banner tone="danger" title={t(model.assign.problem)} />
        ) : (
          <>
            <Field label={t('mailToSort.assign.number')} hint={t('mailToSort.assign.numberHint')}>
              <Input
                value={query}
                onChange={(event) => {
                  typed.current = true
                  setQuery(event.target.value)
                }}
                placeholder={t('mailToSort.assign.placeholder')}
                inputMode="search"
                autoComplete="off"
              />
            </Field>
            <fieldset className="fw-mts-choices">
              <legend className="fw-mts-legend" aria-live="polite">
                {candidates === null
                  ? t('mailToSort.assign.loading')
                  : matches.total === 0
                    ? t(query.trim() === '' ? 'mailToSort.assign.none' : 'mailToSort.assign.noMatch')
                    : t('mailToSort.assign.matches', { count: matches.total })}
              </legend>
              {candidates === null && <Spinner size={14} />}
              {matches.shown.map((candidate) => {
                const value = keyOf(candidate)
                return (
                  <RadioCard
                    key={value}
                    variant="row"
                    name="fw-mts-assign"
                    value={value}
                    checked={chosen !== null && keyOf(chosen) === value}
                    selected={chosen !== null && keyOf(chosen) === value}
                    onChange={() => setChosen(candidate)}
                    title={`${t(`mailToSort.recordKind.${candidate.type}`)} ${candidate.number}`}
                    description={candidate.title}
                  />
                )
              })}
              {matches.total > matches.shown.length && <p className="fw-mts-hint">{t('mailToSort.assign.moreMatches', { count: matches.total - matches.shown.length })}</p>}
            </fieldset>
          </>
        )}
        {withoutParty > 0 && <p className="fw-mts-hint">{t('mailToSort.assign.withoutParty', { count: withoutParty })}</p>}
        <p className="fw-mts-hint">{t('mailToSort.assign.files')}</p>
      </div>
    </Modal>
  )
}

function ReleaseDialog({ detail, model, actions, onClose }: DialogProps) {
  const t = useT('home')
  const [reason, setReason] = useState('')
  const target = releaseTarget(detail)
  const risky = detail.heldReason === 'DMARC_FAIL' || detail.heldReason === 'SPAM'
  const held = model.busy ? t('mailToSort.held.busy') : reasonHeld(reason) ? t('mailToSort.held.reason') : null
  const go = () => {
    if (held) return
    void actions?.onRelease?.(detail, reason).then((done) => done && onClose())
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={t('mailToSort.release.title')}
      size="md"
      footer={
        <>
          <Button onClick={onClose}>{t('mailToSort.cancel')}</Button>
          <Button variant="primary" heldReason={held} onClick={go}>
            {t(`mailToSort.release.go.${target}`)}
          </Button>
        </>
      }
    >
      <div className="fw-mts-dialog">
        <p className="fw-mts-hint">{t(`mailToSort.release.body.${target}`)}</p>
        {risky && <Banner tone="warning" title={t('mailToSort.release.risky')} />}
        <Field label={t('mailToSort.release.reason')} hint={t('mailToSort.reasonHint')} error={reasonHeld(reason) ? t('mailToSort.held.reason') : undefined}>
          <Input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} />
        </Field>
      </div>
    </Modal>
  )
}

function RejectDialog({ detail, model, actions, onClose }: DialogProps) {
  const t = useT('home')
  const [reason, setReason] = useState<PersonRejectReason>(detail.verdicts.spam === 'FAIL' || detail.heldReason === 'SPAM' ? 'MARKED_SPAM' : 'DISCARDED')
  const [note, setNote] = useState('')
  const held = model.busy ? t('mailToSort.held.busy') : reasonHeld(note) ? t('mailToSort.held.reason') : null
  const go = () => {
    if (held) return
    void actions?.onReject?.(detail, reason, note).then((done) => done && onClose())
  }
  return (
    <Modal
      open
      onClose={onClose}
      title={t('mailToSort.reject.title')}
      size="md"
      footer={
        <>
          <Button onClick={onClose}>{t('mailToSort.cancel')}</Button>
          <Button variant="danger" heldReason={held} onClick={go}>
            {t('mailToSort.reject.go')}
          </Button>
        </>
      }
    >
      <div className="fw-mts-dialog">
        <p className="fw-mts-hint">{t('mailToSort.reject.body')}</p>
        <fieldset className="fw-mts-choices">
          <legend className="nds-vh">{t('mailToSort.reject.legend')}</legend>
          {PERSON_REJECT_REASONS.map((option) => (
            <RadioCard
              key={option}
              name="fw-mts-reject"
              value={option}
              checked={reason === option}
              selected={reason === option}
              onChange={() => setReason(option)}
              title={t(`mailToSort.reject.reason.${option}.title`)}
              description={t(`mailToSort.reject.reason.${option}.body`)}
            />
          ))}
        </fieldset>
        <Field label={t('mailToSort.reject.note')} hint={t('mailToSort.reasonHint')} error={reasonHeld(note) ? t('mailToSort.held.reason') : undefined}>
          <Input value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} />
        </Field>
      </div>
    </Modal>
  )
}

export type { MailSummary }
