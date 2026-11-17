'use client'

import Link from 'next/link'
import { Banner, Card, EmptyState, Field, SummaryTable } from '@nexus/ui/components'
import { Button, Checkbox, Pill, Spinner } from '@nexus/ui/primitives'
import { Textarea } from '../../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../../lib/i18n/format'
import type { Locale } from '../../../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { dayInstant } from '../../../model'
import { Frame } from '../../view/Dialogs'
import type { OrderGate, OrderRePromise } from '../api'
import '../links.css'
import { COMPLAINT_TONE, complaintHref, declineHeld, decideHeld, gateHref, RETURN_TONE, returnHref, showsPointers, type LinksActions, type LinksModel } from '../model'

/**
 * B-TH-256 — what points at the order, drawn (O-SAL-ORD-REC.notice-F04, -F06, .body-F07; picture 29):
 * - `LinksSaid`, `GateNotices`, `RePromiseNotices`: the record's notices from it — each compliance gate refusal that still blocks a work order or a shipment ("Work
 *   order release blocked: WO-… · <the gate's own sentence> · Open in Compliance", the link only with the compliance view right),
 *   each re-promise planning sends ("Planning proposes new dates for line 2 · AX-100": the sizes from → to, who proposed it, the
 *   planner's note, Accept / Decline, the "Tell the customer" tick — held with why for a person who may not decide, the planner who
 *   proposed it included), and the last write's result. They go INSIDE the order's RecordNotices (one notice, the rest behind "N more").
 * - `PointsAtOrder`: the order's complaints and returns in "Shipments & invoices" — each list only with its right, each row a real link
 *   to its record; no right to either: nothing drawn.
 * - `DeclineDialog`: "Decline the new dates?" with the reason the planner reads.
 */

const day = (value: string | null, locale: Locale): string => (value ? formatDate(dayInstant(value), { locale }) : '—')

/** The last write's result (Accepted, Declined, or why not): the most recent thing the person did, first among the notices. */
export function LinksSaid({ model, actions }: { model: LinksModel | null | undefined; actions?: LinksActions }) {
  const t = useT('orders')
  if (!model || model.state !== 'ready' || !model.said) return null
  return (
    <Banner
      tone={model.said.tone}
      title={t(model.said.key)}
      action={
        actions?.onDismiss ? (
          <Button size="sm" variant="quiet" onClick={actions.onDismiss}>
            {t('common.dismiss')}
          </Button>
        ) : undefined
      }
    />
  )
}

/** Each compliance gate refusal still blocking one of the order's work orders or shipments (one notice each). */
export function GateNotices({ model, prefix }: { model: LinksModel | null | undefined; prefix: string }) {
  if (!model || model.state !== 'ready') return null
  return (
    <>
      {model.links.gates.map((gate) => (
        <GateNotice key={`${gate.gate}:${gate.subject.id}:${gate.at}`} gate={gate} prefix={prefix} />
      ))}
    </>
  )
}

/** Each re-promise planning sends to sales (one notice each), with Accept / Decline and the "Tell the customer" tick. */
export function RePromiseNotices({ model, actions }: { model: LinksModel | null | undefined; actions?: LinksActions }) {
  if (!model || model.state !== 'ready') return null
  return (
    <>
      {model.links.rePromises.map((proposal) => (
        <RePromiseNotice key={proposal.id} proposal={proposal} model={model} actions={actions} />
      ))}
    </>
  )
}

function GateNotice({ gate, prefix }: { gate: OrderGate; prefix: string }) {
  const t = useT('orders')
  const href = gateHref(prefix, gate)
  const subject = gate.subject.number ?? t(`links.gate.subject.${gate.subject.type}`)
  return (
    <Banner
      tone="danger"
      title={t('links.gate.title', { place: t(`links.gate.place.${gate.gate}`), subject })}
      action={
        href ? (
          <Button size="sm" variant="quiet" asChild>
            <Link href={href}>{t('links.gate.open')}</Link>
          </Button>
        ) : undefined
      }
    >
      <span className="fw-so-links-gate">
        {gate.styleCode && <span className="fw-so-links-style">{gate.styleCode}</span>}
        {/* The gate's own sentence (same words as Compliance › Gate refusals): who can fix it and how. */}
        <span>{gate.reason}</span>
        {!href && <span className="fw-so-hint">{t('links.gate.wordsOnly')}</span>}
      </span>
    </Banner>
  )
}

function RePromiseNotice({ proposal, model, actions }: { proposal: OrderRePromise; model: Extract<LinksModel, { state: 'ready' }>; actions?: LinksActions }) {
  const t = useT('orders')
  const locale = useLocale()
  const busy = model.busy === proposal.id
  const heldKey = decideHeld(proposal, model.busy !== null)
  const held = heldKey ? t(heldKey) : null
  const told = model.tell[proposal.id] === true
  return (
    <Banner
      tone="warning"
      title={t(proposal.line.styleCode ? 'links.rePromise.titleStyle' : 'links.rePromise.title', { line: proposal.line.seq, style: proposal.line.styleCode ?? '' })}
      action={
        <span className="fw-so-links-actions">
          <Button size="sm" variant="primary" heldReason={held} onClick={() => actions?.onAccept?.(proposal.id)}>
            {busy ? <Spinner size={12} /> : null} {t('links.rePromise.accept')}
          </Button>
          <Button size="sm" heldReason={held} onClick={() => actions?.onDeclineStart?.(proposal.id)}>
            {t('links.rePromise.decline')}
          </Button>
        </span>
      }
    >
      <span className="fw-so-links-body">
        <ul className="fw-so-list fw-so-links-sizes" aria-label={t('links.rePromise.sizesLabel')}>
          {proposal.sizes.map((size, index) => (
            <li key={`${size.size ?? 'all'}-${index}`}>{t('links.rePromise.size', { size: size.size ?? t('links.rePromise.allSizes'), from: day(size.from, locale), to: day(size.to, locale) })}</li>
          ))}
        </ul>
        <span className="fw-so-hint">
          {proposal.proposedBy ? t('links.rePromise.by', { name: proposal.proposedBy.name, date: formatDate(proposal.proposedAt, { locale }) }) : t('links.rePromise.byUnknown', { date: formatDate(proposal.proposedAt, { locale }) })}
        </span>
        {proposal.reason && <span className="fw-so-hint">{t('links.rePromise.note', { note: proposal.reason })}</span>}
        {proposal.may.tell ? (
          <Checkbox label={t('links.rePromise.tell')} checked={told} disabled={!!held} onChange={(event) => actions?.onTell?.(proposal.id, event.target.checked)} />
        ) : (
          proposal.may.accept && <span className="fw-so-hint">{t('links.rePromise.noTell')}</span>
        )}
      </span>
    </Banner>
  )
}

/** "Decline the new dates?" — the reason is required (the planner reads it); a refusal is said here, what was typed stays. */
export function DeclineDialog({ model, actions }: { model: LinksModel | null | undefined; actions?: LinksActions }) {
  const t = useT('orders')
  if (!model || model.state !== 'ready' || !model.decline) return null
  const decline = model.decline
  const proposal = model.links.rePromises.find((entry) => entry.id === decline.proposalId)
  if (!proposal) return null
  const heldKey = declineHeld(decline, model.busy !== null)
  return (
    <Frame
      title={t('links.decline.title', { line: proposal.line.seq })}
      held={heldKey ? t(heldKey) : null}
      go={() => actions?.onDecline?.()}
      goLabel={t('links.decline.go')}
      onClose={() => actions?.onDeclineCancel?.()}
      tone="danger"
      problem={decline.problem ? <Banner tone="danger" title={t(decline.problem)} /> : null}
    >
      <p className="fw-so-hint">{t('links.decline.body')}</p>
      <Field label={t('links.decline.reason')}>
        <Textarea value={decline.reason} onChange={(event) => actions?.onDeclineReason?.(event.target.value)} rows={3} maxLength={1000} />
      </Field>
    </Frame>
  )
}

/** The order's complaints and returns, in "Shipments & invoices" (each list by its own right; neither right: nothing). */
export function PointsAtOrder({ model, actions, prefix }: { model: LinksModel | null | undefined; actions?: LinksActions; prefix: string }) {
  const t = useT('orders')
  const locale = useLocale()
  if (!model) return null
  if (model.state === 'loading')
    return (
      <Card padded aria-busy="true">
        <p className="fw-so-hint" role="status">
          <Spinner size={14} /> {t('links.loading')}
        </p>
      </Card>
    )
  if (model.state === 'error')
    return (
      <Card padded>
        <EmptyState
          title={t('links.failed')}
          description={t(model.problem)}
          action={
            actions?.onRetry ? (
              <Button size="sm" onClick={actions.onRetry}>
                {t('common.retry')}
              </Button>
            ) : undefined
          }
        />
      </Card>
    )
  const { links } = model
  if (!showsPointers(links)) return null
  const complaints = links.complaints
  const returns = links.returns
  return (
    <Card padded>
      <div className="fw-so-card-head">
        <h2 className="fw-so-h2">{t('links.title')}</h2>
        <span className="fw-so-hint">{t('links.hint')}</span>
      </div>
      {complaints !== null && (
        <section className="fw-so-links-section" aria-label={t('links.complaints.title')}>
          <h3 className="fw-so-h3">{t('links.complaints.title')}</h3>
          {complaints.length === 0 ? (
            <p className="fw-so-hint">{t('links.complaints.none')}</p>
          ) : (
            <SummaryTable
              label={t('links.complaints.title')}
              columns={[t('links.col.number'), t('links.col.status'), t('links.col.severity'), t('links.col.received'), t('links.col.answerDue')]}
              rows={complaints.map((row) => ({
                id: row.id,
                cells: [
                  <Link key="n" className="fw-so-link" href={complaintHref(prefix, row.id)}>
                    {row.number}
                  </Link>,
                  <Pill key="s" tone={COMPLAINT_TONE[row.status] ?? 'neutral'}>{t(`links.complaintStatus.${row.status}`)}</Pill>,
                  row.severity ? t(`links.severity.${row.severity}`) : '—',
                  formatDate(row.receivedAt, { locale }),
                  day(row.answerDueOn, locale),
                ],
              }))}
              density="roomy"
              stackOnPhone
              align={['left', 'left', 'left', 'right', 'right']}
            />
          )}
        </section>
      )}
      {returns !== null && (
        <section className="fw-so-links-section" aria-label={t('links.returns.title')}>
          <h3 className="fw-so-h3">{t('links.returns.title')}</h3>
          {returns.length === 0 ? (
            <p className="fw-so-hint">{t('links.returns.none')}</p>
          ) : (
            <SummaryTable
              label={t('links.returns.title')}
              columns={[t('links.col.number'), t('links.col.status'), t('links.col.wanted'), t('links.col.requested'), t('links.col.closed')]}
              rows={returns.map((row) => ({
                id: row.id,
                cells: [
                  <Link key="n" className="fw-so-link" href={returnHref(prefix, row.id)}>
                    {row.number}
                  </Link>,
                  <Pill key="s" tone={RETURN_TONE[row.status] ?? 'neutral'}>{t(`links.returnStatus.${row.status}`)}</Pill>,
                  row.outcomeWanted ? t(`links.wanted.${row.outcomeWanted}`) : '—',
                  formatDate(row.requestedAt, { locale }),
                  row.closedAt ? formatDate(row.closedAt, { locale }) : '—',
                ],
              }))}
              density="roomy"
              stackOnPhone
              align={['left', 'left', 'left', 'right', 'right']}
            />
          )}
        </section>
      )}
    </Card>
  )
}
