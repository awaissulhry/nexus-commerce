'use client'

import Link from 'next/link'
import { Banner, Card, Field, KeyValue, SourceIndicator } from '@nexus/ui/components'
import { Button, Select, Tag } from '@nexus/ui/primitives'
import { LABEL_KINDS, LABEL_QR_TARGETS } from '@nexus/factory-domain/compliance/labels/rules'
import { Textarea } from '../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../lib/i18n/provider'
import type { LabelDetail } from '../../api'
import type { LabelChecks } from '../api'
import { GPSR_MAX, kindOf, markingDraftOf, markingProblem, type MarkingDraft } from '../model'
import type { RecordDepth } from '../../view-model'
import { PanelRead } from './parts'

/**
 * The builder's W2b marking (design lb-builder "W2b: class warnings for B and C and removable protectors (PRD-335) · QR to
 * the DoC (PRD-349) · GPSR fields for non-PPE lines (PRD-346)", B-W2b-253's PUT …/marking): what the label is (PPE garment
 * label, glove marking, fibre and care, packaging), where its QR points and what it holds now, the GPSR contact with who it
 * must name ("Fill from operator roles"), the glove's EN 13594 level as the certificate grants it, and the class warnings
 * it must carry with their words per language — drafts that wait for the PPE consultant (GATE-PPE-TEXTS). A draft and a
 * person who keeps labels edit it (saved with the builder's Save); otherwise it reads as text.
 */
export function MarkingCard({ detail, depth, editable, prefix, onMarking, onRetry }: { detail: LabelDetail; depth: RecordDepth; editable: boolean; prefix: string; onMarking?: (marking: MarkingDraft) => void; onRetry?: () => void }) {
  const d = useT('compliance-labels-depth')
  const draft = editable ? (depth.marking ?? markingDraftOf(detail)) : null
  const set = (patch: Partial<MarkingDraft>) => draft && onMarking?.({ ...draft, ...patch })
  const problem = markingProblem(draft)
  const kind = draft?.kind ?? kindOf(detail)
  const qrTarget = draft?.qrTarget ?? detail.qrTarget
  return (
    <Card padded>
      <section className="fw-q-section" id="lb-sec-marking" aria-labelledby="lb-h-marking">
        <div className="fw-q-section-head">
          <div className="fw-q-section-title">
            <h2 id="lb-h-marking">{d('marking.title')}</h2>
            <p className="fw-q-hint">{d('marking.intro')}</p>
          </div>
        </div>
        {draft ? (
          <div className="fw-q-form-two">
            <Field label={d('marking.kind')} hint={d(`kindHint.${kind}`)}>
              <Select size="sm" value={draft.kind} onChange={(event) => set({ kind: event.target.value as MarkingDraft['kind'] })}>
                {LABEL_KINDS.map((entry) => (
                  <option key={entry} value={entry}>
                    {d(`kind.${entry}`)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={d('marking.qr')} hint={d(`qrHint.${qrTarget}`)}>
              <Select size="sm" value={draft.qrTarget} onChange={(event) => set({ qrTarget: event.target.value as MarkingDraft['qrTarget'] })}>
                {LABEL_QR_TARGETS.map((entry) => (
                  <option key={entry} value={entry}>
                    {d(`qr.${entry}`)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        ) : (
          <KeyValue
            columns={2}
            labelCase="sentence"
            items={[
              { label: d('marking.kind'), value: d(`kind.${kind}`), hint: d(`kindHint.${kind}`) },
              { label: d('marking.qr'), value: d(`qr.${qrTarget}`), hint: d(`qrHint.${qrTarget}`) },
              { label: d('marking.gpsr'), value: detail.gpsrContact?.trim() ? <span className="fw-lbd-lines">{detail.gpsrContact}</span> : d('marking.gpsrNone') },
            ]}
          />
        )}

        {draft && (
          <Field label={d('marking.gpsr')} hint={d('marking.gpsrHint', { max: GPSR_MAX })} error={problem ? d(problem) : undefined}>
            <Textarea rows={3} maxLength={GPSR_MAX + 50} value={draft.gpsrContact} onChange={(event) => set({ gpsrContact: event.target.value })} />
          </Field>
        )}

        <PanelRead read={depth.checks} failedTitle={d('marking.failed')} onRetry={onRetry} rows={2}>
          {(value) => <MarkingFacts checks={value} draft={draft} detail={detail} prefix={prefix} onFill={draft ? (text) => set({ gpsrContact: text }) : undefined} />}
        </PanelRead>
      </section>
    </Card>
  )
}

function MarkingFacts({ checks, draft, detail, prefix, onFill }: { checks: LabelChecks; draft: MarkingDraft | null; detail: LabelDetail; prefix: string; onFill?: (text: string) => void }) {
  const d = useT('compliance-labels-depth')
  const marking = checks.marking
  const sender = marking.gpsr.expected
  const suggested = marking.gpsr.suggested
  const typed = (draft?.gpsrContact ?? detail.gpsrContact ?? '').trim()
  const qr = marking.qr
  return (
    <div className="fw-q-stack">
      <p className="fw-lbd-source">
        <SourceIndicator kind={sender.name ? 'rule' : 'missing'} showLabel label={sender.name ? d(`sender.${sender.who}`, { name: sender.name }) : d('sender.none')} description={d('marking.senderWhy')} />
      </p>
      {onFill && (
        <span className="fw-q-actions">
          <Button size="sm" heldReason={!suggested ? d('held.noOperator') : typed === suggested.trim() ? d('held.sameContact') : null} onClick={() => suggested && onFill(suggested)}>
            {d('marking.fill')}
          </Button>
          <Link className="fw-q-link" href={`${prefix}/compliance/settings?tab=operators`}>
            {d('marking.operators')}
          </Link>
        </span>
      )}

      {qr && (
        <KeyValue
          columns={2}
          labelCase="sentence"
          items={[
            { label: d('marking.qrHolds'), value: qr.printed ?? d('marking.qrAtPrint'), hint: qr.address ?? d(qr.kind === 'BATCH' ? 'marking.qrBatchLater' : 'marking.qrNone') },
            {
              label: d('marking.qrLive'),
              value: qr.live === null ? d('marking.qrLiveUnknown') : qr.live ? d('marking.qrLiveYes') : d('marking.qrLiveNo'),
              hint: qr.origin,
            },
          ]}
        />
      )}

      {marking.glove && (
        <p className="fw-lbd-source">
          <SourceIndicator kind={marking.glove.granted ? 'linked' : 'warning'} showLabel label={d('marking.glove', { level: marking.glove.text })} description={marking.glove.granted ? d('marking.gloveGranted') : d('marking.gloveNotGranted')} />
        </p>
      )}

      <h3 className="fw-lb-h3">{d('warnings.title')}</h3>
      {marking.warnings.length === 0 ? (
        <p className="fw-q-hint">{d('warnings.none')}</p>
      ) : (
        <>
          <Banner tone="info" title={d('warnings.draftTitle')}>
            {d('warnings.draftBody')}
          </Banner>
          <ul className="fw-lbd-warnings">
            {marking.warnings.map((warning) => (
              <li key={warning.key}>
                <span className="fw-q-cell-row">
                  <b>{d(`warning.${warning.reason}`)}</b>
                  {warning.draft && <Tag tone="warning">{d('warnings.draft')}</Tag>}
                  <span className="fw-q-hint fw-q-code">{warning.key}</span>
                </span>
                <dl className="fw-lbd-texts">
                  {warning.texts.map((text) => (
                    <div key={text.language}>
                      <dt className="fw-q-code">{text.language.toUpperCase()}</dt>
                      <dd lang={text.language}>{text.text ?? <span className="fw-lbd-missing">{d('cell.MISSING')}</span>}</dd>
                    </div>
                  ))}
                </dl>
              </li>
            ))}
          </ul>
          <Link className="fw-q-link" href={`${prefix}/compliance/labels/${encodeURIComponent(detail.id)}?tab=languages`}>
            {d('warnings.languages')}
          </Link>
        </>
      )}
    </div>
  )
}
