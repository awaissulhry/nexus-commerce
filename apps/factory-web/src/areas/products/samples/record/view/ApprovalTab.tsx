'use client'

import Link from 'next/link'
import { FilePlus2, Gavel, Repeat, Send } from 'lucide-react'
import { Banner, Card, EmptyState, KeyValue, SummaryTable } from '@nexus/ui/components'
import { Button, Skeleton, Tag } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../../lib/i18n/format'
import type { ApprovalView, RoundView, SwatchView } from '../../api'
import { approvalHeld, needsPhrase, recordHref, refusalPhrase, type Phrase } from '../../model'
import { DecisionTag, useWords } from '../../parts'
import type { SampleRecordActions, SampleRecordModel } from '../view-model'

/** Why a swatch's step is held, in our words (the right first, then the API's code). */
export function swatchHeld(swatch: SwatchView, step: 'send' | 'decide', offline: boolean): Phrase | null {
  const state = swatch.actions[step]
  if (!state.allowed) return state.needs ? needsPhrase(state.needs) : refusalPhrase(state.refusal?.code)
  return offline ? { key: 'held.offline' } : null
}

/**
 * Approval (design rec tab sample.approval, SAL-312, SAL-314, PRD-158; an explicit decision): the decision — approved,
 * approved with comments or rejected, by whom (the office, or the customer by link or portal), when, on which revision,
 * the comments — or "Waiting for a decision" with the request to the brand; Record decision, Ask the customer (Links ›
 * Approve: the record panels' Approvals, where the files go with the request), after a rejection "Make the next round"
 * and "Raise a change"; the leather and colour swatches sent and decided; a CE test sample's notified body, zones, result
 * and certificate. Every step held says why (the right it needs, or the rule in our words).
 */
export function ApprovalTab({ model, round, actions }: { model: SampleRecordModel; round: RoundView; actions?: SampleRecordActions }) {
  const { t, say, locale } = useWords()
  const offline = model.live === 'offline'
  const view = model.approval.value
  if (model.approval.problem && !view)
    return (
      <Banner
        tone="danger"
        title={t('approval.failed')}
        action={
          <Button size="sm" variant="quiet" onClick={() => actions?.onApprovalRetry?.()}>
            {t('common.retry')}
          </Button>
        }
      >
        {t(model.approval.problem)}
      </Banner>
    )
  if (!view)
    return (
      <div className="fw-smp-two" aria-busy="true">
        <Skeleton height={180} />
        <Skeleton height={180} />
      </div>
    )
  return <Ready model={model} round={round} view={view} actions={actions} offline={offline} t={t} say={say} locale={locale} />
}

function Ready({
  model,
  round,
  view,
  actions,
  offline,
  t,
  say,
  locale,
}: {
  model: SampleRecordModel
  round: RoundView
  view: ApprovalView
  actions?: SampleRecordActions
  offline: boolean
  t: ReturnType<typeof useWords>['t']
  say: ReturnType<typeof useWords>['say']
  locale: ReturnType<typeof useWords>['locale']
}) {
  const decision = view.decision
  const when = (value: string) => formatDateTime(value, { locale })
  const by = !decision
    ? null
    : decision.via === 'OFFICE'
      ? t('approval.byOffice', { name: decision.by?.name ?? '—' })
      : decision.via === 'PORTAL'
        ? t('approval.byPortal', { name: decision.by?.name ?? '—', signed: decision.signedAs ?? '—' })
        : t('approval.byLink', { signed: decision.signedAs ?? '—' })
  const decideHeld = say(approvalHeld(view, 'decide', offline))
  const askHeld = say(approvalHeld(view, 'askBrand', offline))
  const nextHeld = say(approvalHeld(view, 'nextRound', offline))
  const changeHeld = say(approvalHeld(view, 'raiseChangeRequest', offline))
  const testHeld = say(approvalHeld(view, 'testResult', offline))
  const askHref = recordHref(model.prefix, round.id, 'activity', 'panel=approvals')

  return (
    <div className="fw-smp-stack">
      <div className="fw-smp-two">
        <Card padded>
          <div className="fw-smp-stack">
            <h2 className="fw-smp-h2">{t('approval.decision')}</h2>
            {decision ? (
              <KeyValue
                labelCase="sentence"
                items={[
                  { label: t('approval.decisionLabel'), value: <DecisionTag decision={decision.decision} /> },
                  { label: t('approval.by'), value: by },
                  { label: t('approval.when'), value: when(decision.at) },
                  { label: t('approval.revision'), value: t('row.revision', { revision: decision.revision }) },
                  { label: t('approval.comments'), value: decision.comments ?? '—' },
                ]}
              />
            ) : (
              <EmptyState title={t('approval.waiting')} description={t('decide.onRevision', { revision: view.round.revision.revision })} />
            )}
            {view.request && (
              <p className="fw-smp-hint">
                {view.request.status === 'OPEN'
                  ? t('approval.asked', { when: when(view.request.createdAt), due: when(view.request.dueAt) })
                  : t('approval.request', { status: t(`request.status.${view.request.status}`), when: when(view.request.answeredAt ?? view.request.createdAt) })}
              </p>
            )}
            <div className="fw-smp-actions">
              {!decision && (
                <Button size="sm" variant="primary" heldReason={decideHeld} onClick={() => actions?.onDecide?.()} aria-keyshortcuts="d">
                  <Gavel size={14} aria-hidden /> {t('approval.record')}
                </Button>
              )}
              {!decision && round.party && (
                askHeld ? (
                  <Button size="sm" heldReason={askHeld}>
                    <Send size={14} aria-hidden /> {t('approval.ask')}
                  </Button>
                ) : (
                  <Button size="sm" asChild>
                    <Link href={askHref}>
                      <Send size={14} aria-hidden /> {t('approval.ask')}
                    </Link>
                  </Button>
                )
              )}
              {decision?.decision === 'REJECTED' && (
                <Button size="sm" variant="primary" heldReason={nextHeld} onClick={() => actions?.onDialog?.({ kind: 'nextRound', dueDate: '', instructions: '', busy: false, notice: null })}>
                  <Repeat size={14} aria-hidden /> {t('approval.nextRound')}
                </Button>
              )}
              {decision && decision.decision !== 'APPROVED' && (
                <Button size="sm" heldReason={changeHeld} onClick={() => actions?.onDialog?.({ kind: 'change', title: '', reason: decision.comments ?? '', busy: false, notice: null })}>
                  <FilePlus2 size={14} aria-hidden /> {t('approval.raiseChange')}
                </Button>
              )}
            </div>
            {!round.party && !decision && <p className="fw-smp-hint">{t('approval.internal')}</p>}
            {view.changeRequests && view.changeRequests.length > 0 && (
              <div className="fw-smp-section">
                <h3 className="fw-smp-h3">{t('approval.changes')}</h3>
                <ul className="fw-smp-lines">
                  {view.changeRequests.map((change) => (
                    <li key={change.id}>{t('approval.changeLine', { number: change.number ?? '—', title: change.title, status: t(`change.status.${change.status}`) })}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </Card>
        {view.certification ? (
          <Card padded>
            <div className="fw-smp-cardhead">
              <h2 className="fw-smp-h2">{t('approval.ce')}</h2>
              <Button size="sm" heldReason={testHeld} onClick={() => actions?.onDialog?.({ kind: 'testResult', result: view.certification?.testResult ?? null, busy: false, notice: null })}>
                {t('approval.recordResult')}
              </Button>
            </div>
            <KeyValue
              labelCase="sentence"
              items={[
                {
                  label: t('approval.sentTo'),
                  value:
                    view.certification.sentTo.length === 0
                      ? t('approval.notSent')
                      : view.certification.sentTo.map((party) => t('approval.sentToLine', { name: party.name, sent: party.sentAt ? when(party.sentAt) : '—', received: party.receivedAt ? when(party.receivedAt) : '—' })).join('; '),
                },
                { label: t('approval.zones'), value: view.certification.testZones ?? '—' },
                { label: t('approval.result'), value: view.certification.testResult ? <Tag tone={view.certification.testResult === 'PASSED' ? 'success' : 'danger'}>{t(`test.${view.certification.testResult}`)}</Tag> : t('approval.noResult') },
                {
                  label: t('approval.certificate'),
                  value: view.certification.certificate ? (
                    <Link className="fw-smp-link" href={`${model.prefix}/compliance/certificates/${encodeURIComponent(view.certification.certificate.id)}`}>
                      {t('approval.certificateLine', { number: view.certification.certificate.number, standard: view.certification.certificate.standard, body: view.certification.certificate.notifiedBodyNumber })}
                    </Link>
                  ) : (
                    '—'
                  ),
                },
              ]}
            />
          </Card>
        ) : (
          <Card padded>
            <h2 className="fw-smp-h2">{t('approval.ce')}</h2>
            <p className="fw-smp-hint">{t('approval.ceOnly')}</p>
          </Card>
        )}
      </div>
      <Card padded>
        <h2 className="fw-smp-h2">{t('approval.swatches')}</h2>
        {view.swatches.length === 0 ? (
          <p className="fw-smp-hint">{t('approval.noSwatches')}</p>
        ) : (
          <SummaryTable
            label={t('approval.swatches')}
            density="roomy"
            stackOnPhone
            columns={[t('approval.col.swatch'), t('approval.col.sent'), t('approval.col.decision'), t('approval.col.actions')]}
            rows={view.swatches.map((swatch) => {
              const sendHeld = say(swatchHeld(swatch, 'send', offline))
              const swatchDecideHeld = say(swatchHeld(swatch, 'decide', offline))
              return {
                id: swatch.id,
                cells: [
                  t('approval.swatchLine', { kind: t(`swatch.${swatch.kind}`), item: `${swatch.item.code} · ${swatch.item.name}`, colour: swatch.itemColour ? swatch.itemColour.name : swatch.lot ? swatch.lot.code : '—' }),
                  swatch.sentAt ? when(swatch.sentAt) : t('approval.notSentYet'),
                  swatch.decision ? <DecisionTag key="d" decision={swatch.decision} /> : swatch.waiting ? t('approval.waitingBrand', { due: when(swatch.waiting.dueAt) }) : '—',
                  <span key="a" className="fw-smp-actions">
                    {!swatch.sentAt && (
                      <Button size="sm" variant="quiet" heldReason={sendHeld} onClick={() => actions?.onSwatchSend?.(swatch)}>
                        {t('approval.markSent')}
                      </Button>
                    )}
                    {swatch.sentAt && !swatch.decision && (
                      <Button size="sm" variant="quiet" heldReason={swatchDecideHeld} onClick={() => actions?.onSwatchDecide?.(swatch)}>
                        {t('row.decide')}
                      </Button>
                    )}
                  </span>,
                ],
              }
            })}
          />
        )}
        <p className="fw-smp-hint">{t('approval.swatchHint')}</p>
      </Card>
    </div>
  )
}
