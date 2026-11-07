'use client'

import { Copy, Link2, Mail, PackageCheck, Send, Truck } from 'lucide-react'
import { Banner, Card, EmptyState, KeyValue, ProgressBar, SummaryTable } from '@nexus/ui/components'
import { Button, Pill, Spinner, Tag } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../../../../lib/i18n/format'
import { Timeline } from '../../../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../../record-panels/i18n'
import { dayAt } from '../../../../../_shared/buying/model'
import type { Words } from '../../../model'
import type { WorkshopAnswer } from '../api'
import {
  actHeld,
  answerDraft,
  answerHeld,
  dateHeld,
  kitDraft,
  linkDraft,
  linkHeld,
  plain,
  progressDraft,
  reachOf,
  receiveHeld,
  returnsDraft,
  sentLines,
  STATE_TONE,
  type WorkshopActions,
  type WorkshopPanelModel,
} from '../model'
import { WorkshopDialogs } from './WorkshopDialogs'
import { useScrapWords, useWords } from './words'
import '../workshop.css'

/** The panel's catalogues (its own, and the record's common words for the dialog frame). */
export const WORKSHOP_NAMESPACES = ['subcontract-workshop', 'subcontract-order'] as const

/** The panel inside its catalogues: the container's and the design cases' entry. */
export function WorkshopSection(props: { model: WorkshopPanelModel; actions?: WorkshopActions }) {
  return (
    <WithMessages namespaces={WORKSHOP_NAMESPACES}>
      <WorkshopPanelView {...props} />
    </WithMessages>
  )
}

/**
 * What the workshop said (B-W2b-176; design purchasing.subcontracting › Kit "received by the workshop (W2b link or portal)",
 * Owner answer C3), under the Kit tab: its answer to the job (and ours to a date it proposed), how it can be reached and the
 * job link, the kit lines it checked, its progress by operation and size with its reports, and its send-backs (an announced
 * one prefills the record's Receive back). Each act the office may write for it says why when it is held. No price (C2).
 */
export function WorkshopPanelView({ model, actions }: { model: WorkshopPanelModel; actions?: WorkshopActions }) {
  const { t, sayWords } = useWords()
  if (model.answer.status === 'loading') {
    return (
      <Card padded aria-busy="true">
        <p className="fw-by-hint" role="status">
          <Spinner size={14} /> {t(model.slow ? 'state.slow' : 'state.loading')}
        </p>
      </Card>
    )
  }
  if (model.answer.status !== 'ready') {
    const problem = model.answer.status === 'error' ? model.answer.problem : model.answer.status === 'forbidden' ? 'problem.forbidden' : 'problem.gone'
    return (
      <Card padded>
        <EmptyState
          title={t('state.failed')}
          description={t(problem)}
          action={
            <Button size="sm" onClick={() => actions?.onRetry?.()}>
              {t('common.retry')}
            </Button>
          }
        />
      </Card>
    )
  }
  const answer = model.answer.value
  return (
    <section className="fw-ws" aria-label={t('title')}>
      <h2 className="fw-by-h2">{t('title')}</h2>
      {model.notice && (
        <Banner tone={model.notice.tone} title={sayWords(model.notice.words)} onDismiss={() => actions?.onDismissNotice?.()} />
      )}
      <div className="fw-by-cards">
        <AnswerCard answer={answer} model={model} actions={actions} />
        <ReachCard answer={answer} model={model} actions={actions} />
      </div>
      <KitCard answer={answer} model={model} actions={actions} />
      <ProgressCard answer={answer} model={model} actions={actions} />
      <ReturnsCard answer={answer} model={model} actions={actions} />
      <WorkshopDialogs answer={answer} model={model} actions={actions} />
    </section>
  )
}

interface PartProps {
  answer: WorkshopAnswer
  model: WorkshopPanelModel
  actions?: WorkshopActions | undefined
}

const held = (sayWords: (value: Words) => string, value: Words | null): string | null => (value ? sayWords(value) : null)

function AnswerCard({ answer, model, actions }: PartProps) {
  const { t, sayWords } = useWords()
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const { job } = answer
  const day = (value: string) => formatDate(dayAt(value), place)
  const when = (value: string) => formatDateTime(value, place)
  const reply = job.answer
  const decided = reply.dateDecision
  const dateBlocked = model.busy ? t('held.busy') : held(sayWords, dateHeld(answer))
  return (
    <Card padded>
      <div className="fw-by-stack">
        <h3 className="fw-by-h3">
          {t('answer.title')} <Pill tone={STATE_TONE[job.state]}>{t(`jobState.${job.state}`)}</Pill>
        </h3>
        {reply.declinedAt ? (
          <p className="fw-by-text">{t('answer.declined', { when: when(reply.declinedAt), by: reply.declinedByName ?? t('answer.someone'), reason: reply.declineReason ?? '' })}</p>
        ) : reply.acceptedAt ? (
          <p className="fw-by-text">{t('answer.accepted', { when: when(reply.acceptedAt), by: reply.acceptedByName ?? t('answer.someone') })}</p>
        ) : (
          <p className="fw-by-text">{t(job.status === 'DRAFT' ? 'answer.notSent' : 'answer.waiting')}</p>
        )}
        {reply.proposedDate && (
          <div className="fw-ws-proposal">
            <p className="fw-by-text">{t('answer.proposed', { day: day(reply.proposedDate), asked: job.expectedBackDate && !decided ? day(job.expectedBackDate) : t('answer.ourDay'), reason: reply.proposedDateReason ?? '' })}</p>
            {decided ? (
              <p className="fw-by-hint">{t(decided.decision === 'ACCEPTED' ? 'answer.dateAccepted' : 'answer.dateRefused', { when: when(decided.at) })}</p>
            ) : (
              <div className="fw-by-actions">
                <Button size="sm" variant="primary" heldReason={dateBlocked} onClick={() => actions?.onDialog?.({ kind: 'date', decision: 'ACCEPTED' })}>
                  {t('answer.acceptDate')}
                </Button>
                <Button size="sm" heldReason={dateBlocked} onClick={() => actions?.onDialog?.({ kind: 'date', decision: 'REFUSED' })}>
                  {t('answer.refuseDate')}
                </Button>
              </div>
            )}
          </div>
        )}
        <KeyValue
          dense
          labelCase="sentence"
          items={[
            { label: t('answer.dueBack'), value: job.expectedBackDate ? day(job.expectedBackDate) : t('answer.noDay') },
            { label: t('answer.kitOut'), value: job.kit.sentOn.length > 0 ? job.kit.sentOn.map(day).join(', ') : t('answer.kitNotYet') },
          ]}
        />
        <div className="fw-by-actions">
          <Button size="sm" heldReason={model.busy ? t('held.busy') : held(sayWords, answerHeld(answer))} onClick={() => actions?.onDialog?.(answerDraft(answer))}>
            {t('answer.record')}
          </Button>
        </div>
      </div>
    </Card>
  )
}

function ReachCard({ answer, model, actions }: PartProps) {
  const { t, sayWords } = useWords()
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const reach = reachOf(answer)
  const linkBlocked = model.busy ? t('held.busy') : held(sayWords, linkHeld(answer))
  return (
    <Card padded>
      <div className="fw-by-stack">
        <h3 className="fw-by-h3">{t('reach.title')}</h3>
        {reach === 'none' ? (
          <Banner tone="info" title={t('reach.none.title')}>
            {t('reach.none.body')}
          </Banner>
        ) : (
          <ul className="fw-by-list">
            {answer.reach.contacts.map((contact) => (
              <li key={contact.id}>
                <Mail size={13} aria-hidden /> {contact.name} · <span className="fw-ws-break">{contact.email}</span>
              </li>
            ))}
            {answer.reach.portalOn && <li>{t('reach.portal', { count: answer.reach.portalPeople })}</li>}
          </ul>
        )}
        {model.handed && (
          <Banner tone="warning" title={t('link.handed.title')} onDismiss={() => actions?.onForgetLink?.()}>
            <p className="fw-ws-url">{model.handed}</p>
            <p className="fw-by-hint">{t('link.handed.once')}</p>
            <Button size="sm" onClick={() => actions?.onCopyLink?.()}>
              <Copy size={13} aria-hidden /> {t('link.copy')}
            </Button>
          </Banner>
        )}
        {answer.links.length > 0 && (
          <SummaryTable
            label={t('link.list')}
            columns={[t('link.col.to'), t('link.col.state'), t('link.col.until')]}
            align={['left', 'left', 'right']}
            stackOnPhone
            rows={answer.links.map((link) => ({
              id: link.id,
              cells: [
                link.email ?? t('link.handedOut'),
                <Pill key="s" tone={link.state === 'LIVE' ? 'success' : 'neutral'}>
                  {t(`link.state.${['LIVE', 'USED_UP', 'EXPIRED', 'REVOKED'].includes(link.state) ? link.state : 'OTHER'}`)}
                </Pill>,
                formatDate(link.expiresAt, place),
              ],
            }))}
          />
        )}
        <div className="fw-by-actions">
          <Button size="sm" variant={answer.links.length === 0 && reach !== 'none' ? 'primary' : 'secondary'} heldReason={linkBlocked} onClick={() => actions?.onDialog?.(linkDraft(answer))}>
            <Link2 size={13} aria-hidden /> {t(answer.links.length === 0 ? 'link.send' : 'link.sendAgain')}
          </Button>
        </div>
      </div>
    </Card>
  )
}

function KitCard({ answer, model, actions }: PartProps) {
  const { t, sayWords } = useWords()
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const lines = answer.job.kit.lines.filter((line) => line.status !== 'CANCELLED')
  const sent = sentLines(answer.job)
  return (
    <Card padded>
      <div className="fw-by-stack">
        <div className="fw-by-band">
          <h3 className="fw-by-h3">
            <PackageCheck size={15} aria-hidden /> {t('kit.title')}
          </h3>
          <Button size="sm" heldReason={model.busy ? t('held.busy') : held(sayWords, actHeld(answer, 'kit'))} onClick={() => actions?.onDialog?.(kitDraft(answer.job))}>
            {t('kit.record')}
          </Button>
        </div>
        {sent.length === 0 ? (
          <p className="fw-by-hint">{t('kit.noneSent')}</p>
        ) : (
          <SummaryTable
            label={t('kit.title')}
            columns={[t('kit.col.line'), t('kit.col.component'), t('kit.col.sent'), t('kit.col.counted'), t('kit.col.said')]}
            align={['left', 'left', 'right', 'right', 'left']}
            widths={['10%', '30%', '15%', '15%', '30%']}
            stackOnPhone
            rows={lines.map((line) => ({
              id: line.id,
              cells: [
                String(line.seq),
                <span key="c" className="fw-by-cell">
                  <span className="fw-by-ellipsis">
                    <span className="fw-by-code">{line.item.code}</span> {line.item.name}
                  </span>
                  {(line.colour || line.lot) && <span className="nds-summary-sub">{[line.colour, line.lot].filter(Boolean).join(' · ')}</span>}
                </span>,
                line.status === 'SENT' ? `${plain(line.quantity)} ${line.uom}` : t('kit.planned'),
                line.check ? (
                  <span key="q" className={line.check.short ? 'fw-by-warning' : 'fw-by-success'}>
                    {plain(line.check.quantity)} {line.uom}
                  </span>
                ) : line.status === 'SENT' ? (
                  t('kit.notChecked')
                ) : (
                  '—'
                ),
                line.check ? (
                  <span key="n" className="fw-by-cell">
                    <span>{line.check.short ? <Tag tone="warning">{t('kit.short')}</Tag> : <Tag tone="success">{t('kit.asListed')}</Tag>}</span>
                    {line.check.note && <span className="nds-summary-sub">{line.check.note}</span>}
                    {line.photos.length > 0 && <span className="nds-summary-sub">{t('kit.photos', { count: line.photos.length, names: line.photos.map((photo) => photo.originalName).join(', ') })}</span>}
                    <span className="nds-summary-sub">{formatDateTime(line.check.at, place)}</span>
                  </span>
                ) : (
                  '—'
                ),
              ],
            }))}
          />
        )}
      </div>
    </Card>
  )
}

function ProgressCard({ answer, model, actions }: PartProps) {
  const { t, sayWords } = useWords()
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const { job } = answer
  return (
    <Card padded>
      <div className="fw-by-stack">
        <div className="fw-by-band">
          <h3 className="fw-by-h3">{t('progress.title')}</h3>
          <Button size="sm" heldReason={model.busy ? t('held.busy') : held(sayWords, actHeld(answer, 'progress'))} onClick={() => actions?.onDialog?.(progressDraft())}>
            {t('progress.record')}
          </Button>
        </div>
        {job.finishBy && <p className="fw-by-hint">{t('progress.finishBy', { day: formatDate(dayAt(job.finishBy), place) })}</p>}
        <ul className="fw-ws-ops">
          {job.operations.map((operation) => (
            <li key={operation.id} className="fw-ws-op">
              <p className="fw-by-text">
                <strong>{t('progress.line', { line: operation.seq, code: operation.code, name: operation.name })}</strong> — {t('progress.finished', { finished: operation.finished, pieces: operation.pieces })}
              </p>
              <ProgressBar ariaLabel={t('progress.bar', { line: operation.seq })} value={operation.pieces > 0 ? Math.min(100, Math.round((operation.finished / operation.pieces) * 100)) : null} />
              {operation.sizes.length > 0 && (
                <p className="fw-by-hint">
                  {operation.sizes.map((size) => t('progress.size', { cell: `${size.colourway} ${size.size}`, finished: size.finished, pieces: size.pieces })).join(' · ')}
                </p>
              )}
              <p className="fw-by-hint">{t('progress.counts', { sent: operation.piecesSent, back: operation.back.good + operation.back.defective + operation.back.scrapped, announced: operation.announced })}</p>
            </li>
          ))}
        </ul>
        {job.reports.length === 0 ? (
          <p className="fw-by-hint">{t('progress.none')}</p>
        ) : (
          <Timeline
            label={t('progress.reports')}
            steps={[...job.reports].reverse().map((report) => ({
              key: report.id,
              tone: 'info' as const,
              at: report.at,
              label: t('progress.report', { finished: report.finished, line: report.operationSeq, what: report.bundle ? t('progress.bundle', { code: report.bundle.code }) : report.size ? `${report.colourway} ${report.size}` : t('progress.whole') }),
              detail: [t(report.byOffice ? 'progress.byOffice' : 'progress.by', { name: report.byName }), report.finishBy ? t('progress.reportFinishBy', { day: formatDate(dayAt(report.finishBy), place) }) : null, report.note].filter(Boolean).join(' · '),
            }))}
          />
        )}
      </div>
    </Card>
  )
}

function ReturnsCard({ answer, model, actions }: PartProps) {
  const { t, sayWords } = useWords()
  const scrapWords = useScrapWords()
  const locale = useLocale()
  const place = { locale, timeZone: model.timeZone }
  const { job } = answer
  const receiveBlocked = model.busy ? t('held.busy') : held(sayWords, receiveHeld(answer))
  return (
    <Card padded>
      <div className="fw-by-stack">
        <div className="fw-by-band">
          <h3 className="fw-by-h3">
            <Truck size={15} aria-hidden /> {t('returns.title')}
          </h3>
          <Button size="sm" heldReason={model.busy ? t('held.busy') : held(sayWords, actHeld(answer, 'sendBack'))} onClick={() => actions?.onDialog?.(returnsDraft(job, model.today))}>
            <Send size={13} aria-hidden /> {t('returns.record')}
          </Button>
        </div>
        {job.returns.length === 0 ? (
          <p className="fw-by-hint">{t('returns.none')}</p>
        ) : (
          <SummaryTable
            label={t('returns.title')}
            columns={[t('returns.col.which'), t('returns.col.comes'), t('returns.col.ddt'), t('returns.col.state'), t('returns.col.act')]}
            align={['left', 'left', 'left', 'left', 'right']}
            density="roomy"
            stackOnPhone
            rows={job.returns.map((notice) => ({
              id: notice.id,
              cells: [
                <span key="w" className="fw-by-cell">
                  <span>{t('returns.which', { seq: notice.seq, day: formatDate(dayAt(notice.expectedDate), place) })}</span>
                  <span className="nds-summary-sub">{t(notice.byOffice ? 'returns.byOffice' : 'returns.by', { name: notice.byName })}</span>
                </span>,
                <span key="c" className="fw-by-cell">
                  <span>{t('returns.pieces', { pieces: notice.pieces, parcels: notice.parcels })}</span>
                  {notice.quantities.some((row) => row.scrapped > 0) && (
                    <span className="nds-summary-sub">
                      {notice.quantities
                        .filter((row) => row.scrapped > 0)
                        .map((row) => t('returns.scrapped', { line: row.operationSeq, scrapped: row.scrapped, reason: scrapWords(row.reasonCode) }))
                        .join(' · ')}
                    </span>
                  )}
                  {notice.materialBack.length > 0 && <span className="nds-summary-sub">{notice.materialBack.map((row) => `${row.item.code} ${plain(row.quantity)} ${row.uom ?? ''}`).join(' · ')}</span>}
                  <span className="nds-summary-sub">{t(notice.weCollect ? 'returns.weCollect' : 'returns.theyDeliver')}</span>
                </span>,
                notice.ddt ? `${notice.ddt.number}${notice.ddt.date ? ` · ${formatDate(dayAt(notice.ddt.date), place)}` : ''}` : t('returns.noDdt'),
                <span key="s" className="fw-by-cell">
                  <Pill tone={notice.status === 'ANNOUNCED' ? 'info' : notice.status === 'RECEIVED' ? 'success' : 'neutral'}>{t(`returns.state.${notice.status}`)}</Pill>
                  {notice.cancelReason && <span className="nds-summary-sub">{notice.cancelReason}</span>}
                </span>,
                notice.status === 'ANNOUNCED' ? (
                  <span key="a" className="fw-by-actions">
                    <Button size="sm" variant="primary" heldReason={receiveBlocked} onClick={() => actions?.onReceiveFrom?.(notice.id)}>
                      {t('returns.receive')}
                    </Button>
                    <Button size="sm" variant="quiet" heldReason={receiveBlocked} onClick={() => actions?.onDialog?.({ kind: 'cancelReturn', returnNoticeId: notice.id, reason: '' })}>
                      {t('returns.cancel')}
                    </Button>
                  </span>
                ) : notice.receivedAt ? (
                  formatDateTime(notice.receivedAt, place)
                ) : (
                  '—'
                ),
              ],
            }))}
          />
        )}
      </div>
    </Card>
  )
}
