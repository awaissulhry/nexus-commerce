'use client'

import { FlaskConical, Send } from 'lucide-react'
import { Banner, Card, EmptyState, Field, KeyValue, MetricStrip, SummaryTable } from '@nexus/ui/components'
import { Button, Pill, Select, Skeleton } from '@nexus/ui/primitives'
import { ActionConfirm } from '../../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useScopedT, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { Phrase, Tone } from '../../../_shared/model'
import { DialogFrame } from '../../../_shared/parts'
import type { CompanyEInvoicing, CopyState, Readiness, SendCopy, SimulatedOutcome } from '../../../invoices/test-mode/api'
import { DEPTH, DEPTH_NAMESPACES, type DepthProblem } from '../../../invoices/test-mode/depth'
import { answererOf, answerWords, goLiveConsequences, goLiveHeld, goLiveProblems, makeCopiesHeld, readinessWords } from '../../../invoices/test-mode/model'
import '../../../_shared/finance.css'

export interface EInvoicingModel {
  /** invoices.issue: "Make the copies". */
  canIssue: boolean
  company: { value: CompanyEInvoicing | null; problem: string | null }
  copies: { value: { readiness: Readiness; sends: SendCopy[] } | null; problem: string | null }
  /** The pop-up open: "Leave e-invoice test mode?" or back to test mode. */
  confirm: 'live' | 'test' | null
  busy: boolean
  problem: DepthProblem | null
  notice: { tone: 'success' | 'warning' | 'danger'; words: Phrase } | null
}

export interface EInvoicingActions {
  onConfirm?: (confirm: 'live' | 'test' | null) => void
  onGoLive?: () => void
  onBackToTest?: () => void
  onSimulate?: (outcome: SimulatedOutcome) => void
  onMakeCopies?: () => void
  onRetry?: () => void
  onDismissNotice?: () => void
}

const COPY_TONE: Record<CopyState, Tone> = { NOT_SENT: 'neutral', SIMULATED: 'info', MISSING: 'danger', RECEIPTS_MISSING: 'warning', COMPLETE: 'success' }

/**
 * Finance settings › E-invoicing (SDI) in depth (design finance.settings sec:sdi "Test mode (W2b): simulated SDI answers
 * before going live; banner on every invoice page while on" and "Swap intermediary (W2b): our own copy of every XML and
 * receipt", pop:live "Leave e-invoice test mode?"; FIN-096, FIN-097). Test mode: where the company stands, who answers its
 * sends (simulated here with the answer chosen, the FAKE intermediary), the sends made in test mode, Go live — held with
 * why while it may not (no intermediary chosen yet, no single connection, a paused one) — through the DS ActionConfirm
 * ("from now on invoices go to SDI for real and cannot be taken back", acknowledged) and a fresh code; back to test mode.
 * Swap intermediary: whether every send has our complete copy, what is missing or waits for SDI, Make the copies, and the
 * newest sends' copies. Our receipt files are our record of each notification, never SDI's signed receipt (said).
 */
export function EInvoicingCards({ model, actions }: { model: EInvoicingModel; actions?: EInvoicingActions }) {
  return (
    <WithMessages namespaces={DEPTH_NAMESPACES}>
      <Cards model={model} actions={actions} />
    </WithMessages>
  )
}

function Cards({ model, actions }: { model: EInvoicingModel; actions?: EInvoicingActions }) {
  const t = useT('finance')
  const w = useT(DEPTH)
  if (model.company.problem)
    return (
      <Card padded className="fw-fin-card">
        <EmptyState title={w('sdi.failed')} description={t(model.company.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>} />
      </Card>
    )
  const company = model.company.value
  if (!company)
    return (
      <Card padded className="fw-fin-card" aria-busy="true">
        <div className="fw-fin-stack-tight">
          <Skeleton width={200} height={18} />
          <Skeleton height={14} />
          <Skeleton height={14} />
        </div>
      </Card>
    )
  return (
    <>
      <TestModeCard model={model} company={company} actions={actions} />
      <SwapCard model={model} actions={actions} />
    </>
  )
}

function TestModeCard({ model, company, actions }: { model: EInvoicingModel; company: CompanyEInvoicing; actions?: EInvoicingActions }) {
  const t = useT('finance')
  const w = useT(DEPTH)
  const s = useScopedT('finance')
  const locale = useLocale()
  const testing = company.state.code === 'TEST'
  const answer = answerWords({ answerer: answererOf(company), outcome: company.simulateOutcome })
  const live = goLiveHeld(company, model.busy)
  const backHeld = !company.can.manage ? w('held.noTestMode') : model.busy ? w('held.busy') : null
  const fake = company.connection.accounts.length === 1 && company.connection.accounts[0]!.mode === 'FAKE'
  return (
    <Card padded className="fw-fin-card">
      <div className="fw-fin-card-head">
        <h2 className="fw-fin-h2">
          <FlaskConical size={16} aria-hidden /> {w('sdi.title')}
        </h2>
        <Pill tone={testing ? 'warning' : 'success'}>{testing ? w('sdi.stateTest') : w('sdi.stateLive', { date: company.liveSince ? formatDate(company.liveSince, { locale }) : '—' })}</Pill>
      </div>
      <p className="fw-fin-hint">{w('sdi.explain')}</p>
      {model.notice && (
        <Banner
          tone={model.notice.tone}
          title={w(model.notice.words.key, model.notice.words.params)}
          action={
            <Button size="sm" variant="quiet" onClick={() => actions?.onDismissNotice?.()}>
              {t('common.dismiss')}
            </Button>
          }
        />
      )}
      {model.problem && model.confirm !== 'test' && <Banner tone="danger" title={s(model.problem.key, model.problem.params)} />}
      <KeyValue
        dense
        labelCase="sentence"
        columns={2}
        items={[
          { label: w('sdi.who'), value: testing ? w(answer.key, answer.params) : w(fake ? 'sdi.liveFake' : 'sdi.liveReal') },
          { label: w('sdi.testSent'), value: w('sdi.testSentValue', { count: company.testSent }) },
          { label: w('sdi.connection'), value: company.connection.accounts.length === 0 ? w('sdi.noConnection') : company.connection.accounts.map((account) => `${account.label} · ${account.mode}`).join(', ') },
        ]}
      />
      {testing && company.state.simulated && (
        <Field label={w('sdi.simulate')} hint={w('sdi.simulateHint')}>
          <Select value={company.simulateOutcome} disabled={!company.can.manage || model.busy} onChange={(event) => actions?.onSimulate?.(event.target.value as SimulatedOutcome)}>
            {company.simulateOptions.map((option) => (
              <option key={option.outcome} value={option.outcome}>
                {w(`sdi.outcome.${option.outcome}`)}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {testing && !company.state.simulated && <p className="fw-fin-hint">{w('sdi.simulateFake')}</p>}
      {testing && company.goLive.problems.length > 0 && (
        <ul className="fw-fin-list" aria-label={w('sdi.goLiveHeld')}>
          {goLiveProblems(company.goLive.problems).map((entry) => (
            <li key={entry.key}>{w(entry.key)}</li>
          ))}
        </ul>
      )}
      {testing && !company.can.manage && <p className="fw-fin-hint">{w('held.noTestMode')}</p>}
      <span className="fw-fin-actions">
        {testing ? (
          <Button size="sm" variant="primary" heldReason={live ? w(live.key) : null} onClick={() => actions?.onConfirm?.('live')}>
            <Send size={14} aria-hidden /> {w('sdi.goLive')}
          </Button>
        ) : (
          <Button size="sm" heldReason={backHeld} onClick={() => actions?.onConfirm?.('test')}>
            {w('sdi.backToTest')}
          </Button>
        )}
      </span>
      {model.confirm === 'live' && (
        <ActionConfirm
          impact={{
            level: 'confirm',
            title: w('live.title'),
            confirmLabel: w('live.go'),
            consequences: goLiveConsequences(company.testSent).map((entry) => w(entry.key, entry.params)),
            reach: 'channel',
            reversal: { verb: w('live.reversal'), fidelity: 'lossy' },
            acknowledge: w('live.acknowledge', { company: company.legalName }),
          }}
          onConfirm={() => actions?.onGoLive?.()}
          onCancel={() => actions?.onConfirm?.(null)}
        />
      )}
      {model.confirm === 'test' && (
        <DialogFrame title={w('sdi.backTitle')} held={backHeld} go={() => actions?.onBackToTest?.()} goLabel={model.busy ? t('common.working') : w('sdi.backGo')} onClose={() => actions?.onConfirm?.(null)} problem={model.problem ? { key: model.problem.key, ...(model.problem.params ? { params: model.problem.params } : {}) } : null}>
          <p className="fw-fin-hint">{w('sdi.backExplain')}</p>
          <p className="fw-fin-hint">{w('sdi.stepUpNote')}</p>
        </DialogFrame>
      )}
    </Card>
  )
}

function SwapCard({ model, actions }: { model: EInvoicingModel; actions?: EInvoicingActions }) {
  const t = useT('finance')
  const w = useT(DEPTH)
  const locale = useLocale()
  const copies = model.copies.value
  const held = makeCopiesHeld(copies?.readiness ?? null, model.canIssue, model.busy)
  return (
    <Card padded className="fw-fin-card">
      <div className="fw-fin-card-head">
        <h2 className="fw-fin-h2">{w('swap.title')}</h2>
        {copies && <Pill tone={copies.readiness.ready ? 'success' : 'warning'}>{w(copies.readiness.ready ? 'swap.readyPill' : 'swap.notReadyPill')}</Pill>}
      </div>
      <p className="fw-fin-hint">{w('swap.explain')}</p>
      {model.copies.problem ? (
        <EmptyState title={w('swap.failed')} description={t(model.copies.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>} />
      ) : !copies ? (
        <div className="fw-fin-stack-tight" aria-busy="true">
          <Skeleton height={14} />
          <Skeleton height={14} />
        </div>
      ) : (
        <>
          <MetricStrip
            minTileWidth={110}
            metrics={[
              { label: w('swap.copied'), value: String(copies.readiness.copied) },
              { label: w('swap.missingLabel'), value: String(copies.readiness.missing) },
              { label: w('swap.openLabel'), value: String(copies.readiness.open) },
            ]}
          />
          <ul className="fw-fin-list">
            {readinessWords(copies.readiness).map((entry) => (
              <li key={entry.key}>{w(entry.key, entry.params)}</li>
            ))}
            {copies.readiness.providers.length > 0 && <li>{w('swap.providers', { names: copies.readiness.providers.join(', ') })}</li>}
          </ul>
          <span className="fw-fin-actions">
            <Button size="sm" heldReason={held ? w(held.key) : null} onClick={() => actions?.onMakeCopies?.()}>
              {model.busy ? t('common.working') : w('swap.make')}
            </Button>
          </span>
          {copies.sends.length > 0 && (
            <SummaryTable
              label={w('swap.recent')}
              columns={[w('swap.col.file'), w('swap.col.copy'), w('swap.col.receipts')]}
              rows={copies.sends.slice(0, 8).map((send) => ({
                id: send.submissionId,
                cells: [
                  <span key="f" className="fw-fin-cell">
                    <span className="fw-fin-code fw-fin-ellipsis">{send.fileName}</span>
                    <span className="fw-fin-cell-sub">{send.copiedAt ? w('swap.copiedAt', { when: formatDateTime(send.copiedAt, { locale }) }) : w('swap.attempt', { count: send.attempt })}</span>
                  </span>,
                  <Pill key="s" tone={COPY_TONE[send.copy.state]}>{w(`swap.state.${send.copy.state}`)}</Pill>,
                  String(send.receipts.length),
                ],
              }))}
              stackOnPhone
            />
          )}
          <p className="fw-fin-hint">{w('swap.ourRecord')}</p>
        </>
      )}
    </Card>
  )
}
