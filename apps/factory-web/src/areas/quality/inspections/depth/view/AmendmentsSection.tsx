'use client'

import { Banner, EmptyState, Field, SummaryTable } from '@nexus/ui/components'
import { SignOffPanel, type SignOffStep } from '@nexus/ui/components/SignOffPanel/index'
import { Button, Input, Select, Skeleton, Tag } from '@nexus/ui/primitives'
import { GARMENT_ZONES } from '@nexus/factory-domain/quality/defects/rules'
import { Modal, Textarea, useDsWords } from '../../../../../lib/i18n/ds-parts'
import { formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { Section } from '../../../_shared/parts'
import type { Read } from '../../../_shared/model'
import { zoneWords } from '../../../defects/zones/zones'
import type { AmendField, Cause, Correction } from '../api'
import { amendHeld, amendProblems, answerHeld, correctionRef, draftFor, fieldKey, freeFields, inputOf, labelIn, type DepthCan } from '../model'
import { useDepthT } from '../parts'
import type { AmendmentsState } from '../use-amendments'

export interface AmendmentsActions {
  onOpen?: (dialog: { kind: 'amend' } | { kind: 'refuse'; amendmentId: string } | null) => void
  onDraft?: (draft: AmendmentsState['draft']) => void
  onRefuseReason?: (reason: string) => void
  onRequest?: () => void
  onSign?: (amendmentId: string) => void
  onRefuse?: () => void
  onRetry?: () => void
  onDismiss?: () => void
}

const STATE_TONE = { WAITING: 'warning', SIGNED: 'success', REFUSED: 'neutral' } as const

/** A correction's before → after (composed: the DS ChangeValue says "added"/"removed" in English only). */
function Change({ correction }: { correction: Pick<Correction, 'beforeWords' | 'afterWords'> }) {
  const td = useDepthT()
  return (
    <span className="fw-qd-change" aria-label={td('amend.change', { from: correction.beforeWords || td('amend.empty'), to: correction.afterWords || td('amend.empty') })}>
      <span className="fw-qd-before" aria-hidden>
        {correction.beforeWords || td('amend.empty')}
      </span>
      <span aria-hidden> → </span>
      <strong aria-hidden>{correction.afterWords || td('amend.empty')}</strong>
    </span>
  )
}

/**
 * Inspection › Decision & signature › Amendments (design dec-amend, QHS-145 on B-W2b-123), the same for an incoming
 * inspection and an in-process check: every correction after signing — A1, A2 … once countersigned — with the field, before
 * → after, the reason, who asked and who countersigned, when; a waiting one with its sign-off (DS SignOffPanel: the request
 * signed by who asked, then the second signature by another inspector or the quality manager with a fresh code — held
 * "You asked for this correction" for who asked) and Refuse with a reason. "Amend signed result" opens pop:ins-amend.
 * A correction never changes a verdict: the API refuses one in words. What stands is the record with its signed corrections.
 */
export function AmendmentsSection({ state, can, causes, actions }: { state: AmendmentsState; can: Pick<DepthCan, 'amendRequest'>; causes?: Read<readonly Cause[]> | null; actions?: AmendmentsActions }) {
  const td = useDepthT()
  const t = useT('quality')
  const locale = useLocale()
  const ds = useDsWords()
  const read = state.read
  const value = read?.value ?? null
  const held = amendHeld(value, can)
  const when = (iso: string) => formatDateTime(iso, { locale })
  const steps = (correction: Correction): SignOffStep[] => {
    const second: SignOffStep =
      correction.answer?.kind === 'SIGNED'
        ? { id: 'second', label: td('amend.step.second'), role: td('amend.step.secondRole'), state: 'signed', signer: correction.answer.by.name ?? td('amend.someone'), method: 'code', signedAt: when(correction.answer.at), fingerprint: correction.answer.signatureSha256 }
        : correction.answer?.kind === 'REFUSED'
          ? { id: 'second', label: td('amend.step.second'), role: td('amend.step.secondRole'), state: 'rejected', signer: correction.answer.by.name ?? td('amend.someone'), signedAt: when(correction.answer.at), rejectedReason: correction.answer.reason ?? '' }
          : {
              id: 'second',
              label: td('amend.step.second'),
              role: td('amend.step.secondRole'),
              state: 'waiting',
              whoMay: td('amend.whoMay'),
              heldReason: answerHeld(correction, value?.may ?? { sign: false }) ? td(answerHeld(correction, value?.may ?? { sign: false })!) : null,
              rules: [{ id: 'author', kind: 'authorNotApprover', state: correction.mine ? 'broken' : 'met', text: correction.mine ? td('amend.rule.mine') : td('amend.rule.other', { name: correction.askedBy.name ?? td('amend.someone') }) }],
              action: { label: td('amend.sign'), onClick: () => actions?.onSign?.(correction.id), busy: state.busy, busyLabel: t('common.working') },
            }
    return [{ id: 'asked', label: td('amend.step.asked'), state: 'signed', signer: correction.askedBy.name ?? td('amend.someone'), methodDetail: td('amend.method.session'), signedAt: when(correction.askedAt), fingerprint: correction.signatureSha256, note: td('amend.reasonWas', { reason: correction.reason }) }, second]
  }
  const waiting = value?.corrections.filter((correction) => correction.state === 'WAITING') ?? []
  return (
    <Section
      id="amendments"
      title={td('amend.heading')}
      sub={value ? (value.waiting > 0 ? td('amend.waitingCount', { count: value.waiting }) : td('amend.sub')) : td('amend.sub')}
      actions={
        <Button size="sm" onClick={() => actions?.onOpen?.({ kind: 'amend' })} heldReason={held ? td(held) : null}>
          {td('amend.menu')}
        </Button>
      }
    >
      {state.done && <Banner tone="success" title={td(state.done)} onDismiss={actions?.onDismiss} />}
      {state.problem && !state.dialog && (
        <Banner tone="danger" title={td(state.problem.includes('.') && !state.problem.startsWith('problem.') ? state.problem : 'amend.problem.unknown')} onDismiss={actions?.onDismiss}>
          {state.lines.length > 0 && (
            <ul className="fw-q-lines">
              {state.lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
        </Banner>
      )}
      {!read ? (
        <p className="fw-q-hint">{td('amend.notSigned')}</p>
      ) : read.problem ? (
        <EmptyState
          title={td('amend.failed')}
          description={t(read.problem)}
          action={
            <Button size="sm" onClick={() => actions?.onRetry?.()}>
              {t('common.retry')}
            </Button>
          }
        />
      ) : !value ? (
        <Skeleton width="100%" height={72} />
      ) : (
        <>
          <p className="fw-q-hint">{td('amend.locked')}</p>
          {value.corrections.length === 0 ? (
            <p className="fw-q-hint">{td('amend.none')}</p>
          ) : (
            <SummaryTable
              label={td('amend.heading')}
              columns={[td('amend.col.ref'), td('amend.col.field'), td('amend.col.change'), td('amend.col.reason'), td('amend.col.asked'), td('amend.col.second'), td('amend.col.state')]}
              rows={value.corrections.map((correction) => ({
                id: correction.id,
                cells: [
                  <span key="r" className="fw-q-code">
                    {correctionRef(correction) ?? '—'}
                  </span>,
                  <span key="f" className="fw-q-cell">
                    <span>{correction.fieldWords}</span>
                    {correction.row && <span className="fw-q-hint">{correction.row.label}</span>}
                  </span>,
                  <Change key="c" correction={correction} />,
                  correction.reason,
                  <span key="a" className="fw-q-cell">
                    <span>{correction.askedBy.name ?? td('amend.someone')}</span>
                    <span className="fw-q-hint">{when(correction.askedAt)}</span>
                  </span>,
                  correction.answer ? (
                    <span key="s" className="fw-q-cell">
                      <span>{correction.answer.by.name ?? td('amend.someone')}</span>
                      <span className="fw-q-hint">{when(correction.answer.at)}</span>
                    </span>
                  ) : (
                    '—'
                  ),
                  <Tag key="t" tone={STATE_TONE[correction.state]}>
                    {td(`amend.state.${correction.state}`)}
                  </Tag>,
                ],
              }))}
              stackOnPhone
            />
          )}
          {waiting.map((correction) => {
            const refuseHeld = answerHeld(correction, value.may)
            return (
              <div key={correction.id} className="fw-qd-signoff">
                <SignOffPanel title={td('amend.signOff', { field: correction.fieldWords })} headingLevel={4} steps={steps(correction)} labels={ds.signOffPanel} />
                <span>
                  <Button size="sm" variant="quiet" onClick={() => actions?.onOpen?.({ kind: 'refuse', amendmentId: correction.id })} heldReason={refuseHeld ? td(refuseHeld) : null}>
                    {td('amend.refuse')}
                  </Button>
                </span>
              </div>
            )
          })}
        </>
      )}
      <AmendDialog state={state} causes={causes ?? null} actions={actions} />
      <RefuseDialog state={state} actions={actions} />
    </Section>
  )
}

/** The input of a field's new value, by its kind: a long text, a decimal, one of the choices, a garment zone, a cause. */
function ValueInput({ id, field, value, causes, onChange }: { id?: string; field: AmendField; value: string; causes: Read<readonly Cause[]> | null; onChange: (value: string) => void }) {
  const td = useDepthT()
  const locale = useLocale()
  const input = inputOf(field)
  // The DS Field gives its generated id to its direct child: this wrapper hands it on to the control, so the label names it.
  if (input === 'textarea') return <Textarea id={id} rows={3} value={value} onChange={(event) => onChange(event.target.value)} />
  if (input === 'decimal') return <Input id={id} size="sm" inputMode="decimal" value={value} onChange={(event) => onChange(event.target.value)} />
  if (input === 'choice')
    return (
      <Select id={id} size="sm" aria-label={td('amend.value')} value={value} onChange={(event) => onChange(event.target.value)}>
        {field.nullable && <option value="">{td('amend.empty')}</option>}
        {(field.choices ?? []).map((choice) => (
          <option key={choice} value={choice}>
            {choice}
          </option>
        ))}
      </Select>
    )
  if (input === 'zone')
    return (
      <Select id={id} size="sm" aria-label={td('amend.value')} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{td('amend.empty')}</option>
        {GARMENT_ZONES.map((zone) => (
          <option key={zone.id} value={zone.id}>
            {zoneWords(zone.id, locale)}
          </option>
        ))}
      </Select>
    )
  if (input === 'cause')
    return causes?.value ? (
      <Select id={id} size="sm" aria-label={td('amend.value')} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{td('amend.empty')}</option>
        {causes.value
          .filter((cause) => cause.active || cause.id === value)
          .map((cause) => (
            <option key={cause.id} value={cause.id}>
              {`${cause.code} · ${labelIn(cause, locale)}`}
            </option>
          ))}
      </Select>
    ) : (
      <p className="fw-q-hint">{td(causes?.problem ? 'defects.causesFailed' : 'amend.causesReading')}</p>
    )
  return <Input id={id} size="sm" value={value} onChange={(event) => onChange(event.target.value)} />
}

/**
 * pop:ins-amend "Amend signed result": the field (those a correction may take, a field already waiting left out), the new
 * value, the reason (required), the preview from → to, and who signs second; Request amendment (it waits for the second
 * signature). The value before is the API's, never the screen's.
 */
function AmendDialog({ state, causes, actions }: { state: AmendmentsState; causes: Read<readonly Cause[]> | null; actions?: AmendmentsActions }) {
  const td = useDepthT()
  const t = useT('quality')
  const locale = useLocale()
  const value = state.read?.value ?? null
  const open = state.dialog?.kind === 'amend'
  const fields = value ? freeFields(value) : []
  const field = fields.find((entry) => fieldKey(entry) === state.draft.field) ?? null
  const problems = amendProblems(state.draft, field)
  const shownAfter = field && inputOf(field) === 'zone' ? zoneWords(state.draft.value, locale) : field && inputOf(field) === 'cause' ? (causes?.value?.find((cause) => cause.id === state.draft.value)?.code ?? state.draft.value) : state.draft.value
  return (
    <Modal
      open={open}
      onClose={() => actions?.onOpen?.(null)}
      title={td('amend.dialog.title')}
      subtitle={td('amend.locked')}
      size="lg"
      footer={
        <>
          <span className="grow" />
          <Button onClick={() => actions?.onOpen?.(null)}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={() => actions?.onRequest?.()} heldReason={state.busy ? t('common.working') : problems.length > 0 ? td(problems[0]!) : null}>
            {td('amend.dialog.request')}
          </Button>
        </>
      }
    >
      {open && value && (
        <div className="fw-q-form">
          <Field label={td('amend.dialog.field')}>
            <Select
              size="sm"
              aria-label={td('amend.dialog.field')}
              value={state.draft.field}
              onChange={(event) => {
                const next = fields.find((entry) => fieldKey(entry) === event.target.value)
                if (next) actions?.onDraft?.(draftFor(next, state.draft.reason))
              }}
            >
              {fields.map((entry) => (
                <option key={fieldKey(entry)} value={fieldKey(entry)}>
                  {entry.row ? td('amend.dialog.fieldOnRow', { field: entry.words, row: entry.row.label }) : entry.words}
                </option>
              ))}
            </Select>
          </Field>
          {field && (
            <>
              <Field label={td('amend.dialog.value')} hint={field.amendedBy ? td('amend.dialog.amendedBefore') : undefined}>
                <ValueInput field={field} value={state.draft.value} causes={causes} onChange={(next) => actions?.onDraft?.({ ...state.draft, value: next })} />
              </Field>
              <div className="fw-qd-preview" aria-live="polite">
                <strong>{td('amend.dialog.preview')}</strong>
                <Change correction={{ beforeWords: field.valueWords, afterWords: shownAfter }} />
              </div>
            </>
          )}
          <Field label={td('amend.dialog.reason')} hint={td('amend.dialog.reasonHint')} required>
            <Textarea rows={2} value={state.draft.reason} onChange={(event) => actions?.onDraft?.({ ...state.draft, reason: event.target.value })} />
          </Field>
          <Banner tone="info" title={td('amend.dialog.second')}>
            {td('amend.whoMay')}
          </Banner>
          {state.problem && (
            <Banner tone="danger" title={td(state.problem.includes('.') && !state.problem.startsWith('problem.') ? state.problem : 'amend.problem.unknown')}>
              {state.lines.length > 0 && (
                <ul className="fw-q-lines">
                  {state.lines.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              )}
            </Banner>
          )}
        </div>
      )}
    </Modal>
  )
}

/** Refuse a correction: the reason (required); no code (a refusal changes nothing: what was signed stands). */
function RefuseDialog({ state, actions }: { state: AmendmentsState; actions?: AmendmentsActions }) {
  const td = useDepthT()
  const t = useT('quality')
  const open = state.dialog?.kind === 'refuse'
  return (
    <Modal
      open={open}
      onClose={() => actions?.onOpen?.(null)}
      title={td('amend.refuseTitle')}
      subtitle={td('amend.refuseSub')}
      footer={
        <>
          <span className="grow" />
          <Button onClick={() => actions?.onOpen?.(null)}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={() => actions?.onRefuse?.()} heldReason={state.busy ? t('common.working') : state.refuseReason.trim().length < 3 ? td('amend.problem.reason') : null}>
            {td('amend.refuse')}
          </Button>
        </>
      }
    >
      {open && (
        <div className="fw-q-form">
          <Field label={td('amend.refuseReason')} required>
            <Textarea rows={2} value={state.refuseReason} onChange={(event) => actions?.onRefuseReason?.(event.target.value)} />
          </Field>
          {state.problem && <Banner tone="danger" title={td(state.problem.includes('.') && !state.problem.startsWith('problem.') ? state.problem : 'amend.problem.unknown')} />}
        </div>
      )}
    </Modal>
  )
}
