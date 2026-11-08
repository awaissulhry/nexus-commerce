'use client'

import Link from 'next/link'
import { Banner, SummaryTable } from '@nexus/ui/components'
import { Pill, Tag } from '@nexus/ui/primitives'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { dash, Facts, RecordFrame, Section } from '../../../_shared/parts'
import type { StepUpState } from '../../../_shared/hooks'
import type { Inline } from '../../depth/api'
import { labelIn, otherStatusOf, type DepthCan } from '../../depth/model'
import { DepthMessages, DepthStepUp, useDepthT } from '../../depth/parts'
import type { AmendmentsState } from '../../depth/use-amendments'
import { AmendmentsSection, type AmendmentsActions } from '../../depth/view/AmendmentsSection'

export const INLINE_TABS = ['check', 'decision'] as const
export type InlineTab = (typeof INLINE_TABS)[number]

/** SCR-076-inline — an in-process check's record (B-W2b-99; the list's in-line rows open it). */
export interface InlineRecordModel {
  readonly prefix: string
  readonly tab: InlineTab
  readonly read: Inline
  readonly depth: DepthCan
  readonly workOrdersView: boolean
  readonly amendments: AmendmentsState
}

export interface InlineRecordActions extends AmendmentsActions {
  onStepUpSubmit?: (code: string) => void
  onStepUpCancel?: () => void
}

const OUTCOME_TONE = { PASS: 'success', FAIL: 'danger', NOT_APPLICABLE: 'neutral' } as const

/**
 * An in-process check (design quality.inspections "In-line (W2b)"; B-W2b-99, recorded on the line tablet SCR-176): what was
 * checked — first piece, cutting, roving or end of line — on which work order, bundle, operation and line; pieces looked at,
 * defective pieces, defects and the DHU; a first piece holding the run; the plan's checks with each answer; who checked in
 * words (a worker named only behind the site's legal gate, never the operator in a list); the signature; the Amendments
 * once decided. Read here: the line answers it.
 */
export function InlineRecordView({ model, actions, stepUp }: { model: InlineRecordModel; actions?: InlineRecordActions; stepUp?: StepUpState }) {
  return (
    <DepthMessages>
      <Record model={model} actions={actions} stepUp={stepUp} />
    </DepthMessages>
  )
}

function Record({ model, actions, stepUp }: { model: InlineRecordModel; actions?: InlineRecordActions; stepUp?: StepUpState }) {
  const td = useDepthT()
  const t = useT('quality')
  const locale = useLocale()
  const check = model.read
  const base = `${model.prefix}/quality/inspections/inline/${encodeURIComponent(check.id)}`
  const status = otherStatusOf({ key: '', kind: 'INLINE', id: check.id, createdAt: check.createdAt, row: check })
  const amended = model.amendments.read?.value?.record.amended ?? false
  const where = check.workOrder?.number ?? check.line?.code ?? ''
  const inspector = check.inspector.workerHidden ? td('inline.inspectorHidden') : check.inspector.name ?? td(check.inspector.kind === 'FLOOR' ? 'who.bench' : 'who.office')
  const when = (iso: string | null) => (iso ? formatDateTime(iso, { locale }) : null)
  return (
    <RecordFrame
      back={{ href: `${model.prefix}/quality/inspections?kind=inline`, label: t('record.back') }}
      title={td(`inline.label.${check.kind}`, { where })}
      meta={
        <span className="fw-q-cell-row">
          {check.line && <span className="fw-q-code">{check.line.code}</span>}
          {check.operation && <span className="fw-q-hint">· {td('inline.operation', { seq: check.operation.seq, name: check.operation.name })}</span>}
          {check.bundle && <span className="fw-q-hint">· {td('inline.bundle', { code: check.bundle.code })}</span>}
        </span>
      }
      status={
        <span className="fw-q-tags">
          <Pill tone={status.tone} dot>
            {td(status.key)}
          </Pill>
          {amended && <Tag tone="info">{td('status.AMENDED')}</Tag>}
          {check.holdsRun && <Tag tone="warning">{td('inline.holdsRun')}</Tag>}
        </span>
      }
      tabs={INLINE_TABS.map((tab) => ({ id: tab, label: td(`inline.tab.${tab}`) }))}
      active={model.tab}
      tabHref={(tab) => `${base}?tab=${tab}`}
    >
      {check.status === 'OPEN' && <Banner tone="info" title={td(check.kind === 'FIRST_PIECE' ? 'inline.openFirstPiece' : 'inline.openOnLine')} />}
      {model.tab === 'check' ? (
        <div className="fw-q-stack">
          <div className="fw-qd-two">
            <Section id="facts" title={td('inline.facts')}>
              <Facts
                items={[
                  { label: td('inline.kind'), value: td(`new.inline.kind.${check.kind}`) },
                  { label: td('subject.label'), value: check.workOrder ? model.workOrdersView ? <Link className="fw-q-link" href={`${model.prefix}/production/work-orders/${encodeURIComponent(check.workOrder.id)}`}>{check.workOrder.number}</Link> : check.workOrder.number : '—' },
                  { label: td('inline.line'), value: check.line ? `${check.line.code} · ${check.line.name}` : '—' },
                  { label: td('inline.pieces'), value: check.pieces },
                  { label: td('inline.defective'), value: check.defectivePieces },
                  { label: td('inline.defects'), value: check.defects },
                  { label: td('inline.dhuLabel'), value: check.dhu ? td('inline.dhu', { dhu: check.dhu }) : '—' },
                  { label: td('inline.defect'), value: check.defect ? `${check.defect.code} · ${labelIn(check.defect, locale)}` : '—' },
                  ...(check.suggested ? [{ label: td('inline.suggested'), value: td(`outcome.${check.suggested}`) }] : []),
                ]}
              />
            </Section>
            <Section id="plan" title={td('plan.label')}>
              <Facts
                items={[
                  { label: td('plan.label'), value: check.plan ? <Link className="fw-q-link" href={`${model.prefix}/quality/plans/${encodeURIComponent(check.plan.planId)}`}>{td('plan.version', { code: check.plan.code, number: check.plan.number })}</Link> : td('plan.none') },
                  { label: td('col.sample'), value: check.sample ? td('inline.sample', { profile: check.sample.profileCode, letter: check.sample.codeLetter ?? '—', sample: check.sample.sampleSize ?? '—' }) : '—' },
                  { label: td('inline.inspector'), value: inspector },
                  { label: td('inline.operator'), value: check.operator ? check.operator.name : check.operatorHidden ? td('inline.operatorHidden') : '—' },
                ]}
              />
            </Section>
          </div>
          <Section id="checks" title={td('inline.checks')}>
            {check.checks.length === 0 ? (
              <p className="fw-q-hint">{td('inline.noChecks')}</p>
            ) : (
              <SummaryTable
                label={td('inline.checks')}
                columns={[td('inline.col.check'), td('inline.col.class'), td('inline.col.answers')]}
                rows={check.checks.map((entry) => {
                  const answers = check.results.filter((result) => result.code === entry.code)
                  return {
                    id: entry.id,
                    cells: [
                      <span key="c" className="fw-q-cell">
                        <span>{labelIn(entry, locale)}</span>
                        <span className="fw-q-hint">
                          {entry.code}
                          {entry.mandatory ? ` · ${td('checks.mandatory')}` : ''}
                        </span>
                      </span>,
                      entry.checkClass ? td(`class.${entry.checkClass}`) : '—',
                      answers.length === 0 ? (
                        <span key="a" className="fw-q-hint">
                          {td('checks.answer.none')}
                        </span>
                      ) : (
                        <span key="a" className="fw-q-cell-row">
                          {answers.map((result) => (
                            <Tag key={result.id} tone={OUTCOME_TONE[result.outcome]}>
                              {td('inline.answer', { unit: result.sampleIndex, answer: td(`checks.answer.${result.outcome}`) })}
                              {result.value ? ` · ${result.value}` : ''}
                            </Tag>
                          ))}
                        </span>
                      ),
                    ],
                  }
                })}
                stackOnPhone
              />
            )}
          </Section>
        </div>
      ) : (
        <div className="fw-q-stack">
          <Section id="decision" title={td('inline.decisionHeading')}>
            {check.status === 'OPEN' ? (
              <p className="fw-q-hint">{td('inline.notDecided')}</p>
            ) : check.status === 'CANCELLED' ? (
              <p className="fw-q-hint">{td('incoming.cancelled', { reason: check.cancelReason ?? '—' })}</p>
            ) : (
              <Facts
                items={[
                  { label: td('inline.outcome'), value: td(status.key) },
                  { label: td('incoming.signedAt'), value: dash(when(check.decidedAt)) },
                  { label: td('incoming.signature'), value: <span className="fw-q-code">{check.signatureSha256 ? `${check.signatureSha256.slice(0, 16)}…` : td('inline.noSignature')}</span> },
                  { label: td('inline.note'), value: dash(check.note) },
                ]}
              />
            )}
          </Section>
          {check.status === 'DECIDED' ? (
            <AmendmentsSection state={model.amendments} can={model.depth} actions={actions} />
          ) : (
            <Section id="amendments" title={td('amend.heading')}>
              <p className="fw-q-hint">{td('amend.notSigned')}</p>
            </Section>
          )}
        </div>
      )}
      {stepUp && <DepthStepUp state={stepUp} onSubmit={(code) => actions?.onStepUpSubmit?.(code)} onCancel={() => actions?.onStepUpCancel?.()} />}
    </RecordFrame>
  )
}
