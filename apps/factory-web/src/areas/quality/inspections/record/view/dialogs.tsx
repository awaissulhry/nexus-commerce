'use client'

import { useEffect, useState } from 'react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Checkbox, Input, Kbd, RadioCard } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../lib/i18n/provider'
import { CheckList, Facts } from '../../../_shared/parts'
import type { FinalCell, Inspection } from '../../api'
import {
  isSerialCell,
  planProblems,
  releaseProblems,
  resultNow,
  secondPersonKeys,
  signProblems,
  type PlanDraft,
  type ReleaseDraft,
  type SignDraft,
} from '../../model'

/** Open checks first (what blocks the release), then the done ones, then the ones not needed. */
const GATE_ORDER: Record<'OK' | 'OPEN' | 'NOT_NEEDED', number> = { OPEN: 0, OK: 1, NOT_NEEDED: 2 }

function useSubmitKey(open: boolean, onSubmit: () => void) {
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault()
        onSubmit()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onSubmit])
}

function Problems({ keys, lines, title }: { keys: readonly string[]; lines?: readonly string[]; title?: string }) {
  const t = useT('quality')
  if (keys.length === 0 && (!lines || lines.length === 0)) return null
  return (
    <Banner tone="warning" title={title ?? t('common.fixFirst')}>
      <ul className="fw-q-lines">
        {keys.map((key) => (
          <li key={key}>{t(key)}</li>
        ))}
        {lines?.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </Banner>
  )
}

/** The computed result's reasons in our words (the domain's sentences are English). */
export function resultReasons(inspection: Pick<Inspection, 'counts' | 'plan' | 'checklist'>): { key: string; params?: Record<string, number> }[] {
  const reasons: { key: string; params?: Record<string, number> }[] = []
  if (inspection.counts.critical > 0) reasons.push({ key: 'result.reason.critical', params: { count: inspection.counts.critical } })
  const failed = inspection.checklist.filter((answer) => answer.ok === false).length
  if (failed > 0) reasons.push({ key: 'result.reason.checks', params: { count: failed } })
  if (inspection.counts.major > inspection.plan.acceptMajor) reasons.push({ key: 'result.reason.major', params: { count: inspection.counts.major, accept: inspection.plan.acceptMajor } })
  if (inspection.counts.minor > inspection.plan.acceptMinor) reasons.push({ key: 'result.reason.minor', params: { count: inspection.counts.minor, accept: inspection.plan.acceptMinor } })
  return reasons
}

// ---- Sign result (the first signature: a fresh code) -----------------------------------------------------------------------------

export function SignModal({
  open,
  inspection,
  draft,
  statementNeeded,
  busy,
  problem,
  lines,
  onDraft,
  onSign,
  onClose,
}: {
  open: boolean
  inspection: Inspection
  draft: SignDraft
  statementNeeded: boolean
  busy?: boolean
  problem?: string | null
  lines?: readonly string[]
  onDraft: (draft: SignDraft) => void
  onSign: () => void
  onClose: () => void
}) {
  const t = useT('quality')
  const [tried, setTried] = useState(false)
  useEffect(() => {
    if (open) setTried(false)
  }, [open])
  const computed = resultNow(inspection)
  const problems = signProblems(draft, inspection, statementNeeded)
  const held = busy ? t('common.working') : problems.length > 0 ? t(problems[0]!) : null
  const submit = () => {
    setTried(true)
    if (!held) onSign()
  }
  useSubmitKey(open, submit)
  const override = draft.result !== computed.result
  const reasons = resultReasons(inspection)
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('sign.title', { label: inspection.label })}
      size="lg"
      footer={
        <>
          <span className="fw-q-hint">
            <Kbd>⌘</Kbd>
            <Kbd>↵</Kbd> {t('sign.keyHint')}
          </span>
          <span className="grow" />
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={submit} heldReason={held}>
            {t(`sign.confirm.${draft.result}`)}
          </Button>
        </>
      }
    >
      <div className="fw-q-form">
        <Banner tone={computed.result === 'PASS' ? 'success' : 'danger'} title={t(`result.computed.${computed.result}`)}>
          {reasons.length === 0 ? (
            t('result.passWords')
          ) : (
            <ul className="fw-q-lines">
              {reasons.map((reason) => (
                <li key={reason.key}>{t(reason.key, reason.params)}</li>
              ))}
            </ul>
          )}
        </Banner>
        <Facts
          items={[
            { label: t('plan.lot'), value: inspection.plan.lotSize },
            { label: t('plan.sample'), value: inspection.plan.sampleSize },
            { label: t('defects.critical'), value: inspection.counts.critical },
            { label: t('defects.major'), value: t('sign.ofAccept', { count: inspection.counts.major, accept: inspection.plan.acceptMajor }) },
            { label: t('defects.minor'), value: t('sign.ofAccept', { count: inspection.counts.minor, accept: inspection.plan.acceptMinor }) },
          ]}
        />
        <fieldset className="fw-q-choices">
          <legend>
            <strong>{t('sign.decision')}</strong>
          </legend>
          {(['ACCEPT', 'CONDITIONAL', 'REJECT'] as const).map((choice) => {
            // Accept: PASS as computed. Conditional (W2a): PASS against a computed FAIL by the acceptance numbers only —
            // the written reason, and its release needs a second person (four eyes, Owner answer Q1). Reject: FAIL.
            const result = choice === 'REJECT' ? 'FAIL' : 'PASS'
            const checked = draft.result === result && (choice === 'REJECT' || (choice === 'ACCEPT') === (computed.result === 'PASS'))
            const heldKey =
              choice === 'ACCEPT' && computed.result !== 'PASS'
                ? 'sign.held.acceptFail'
                : choice === 'CONDITIONAL' && computed.result === 'PASS'
                  ? 'sign.held.conditionalPass'
                  : choice === 'CONDITIONAL' && !computed.byCountsOnly
                    ? 'sign.problem.passOverHard'
                    : null
            return (
              <RadioCard
                key={choice}
                name="decision"
                checked={checked}
                selected={checked}
                disabled={heldKey !== null}
                onChange={() => onDraft({ ...draft, result })}
                title={t(`sign.choice.${choice}`)}
                description={heldKey ? t(heldKey) : t(`sign.choiceHint.${choice}${choice === 'REJECT' && computed.result === 'PASS' ? '_override' : ''}`)}
              />
            )
          })}
        </fieldset>
        {override && (
          <Field label={t('sign.overrideReason')} hint={t('sign.overrideHint')} required>
            <Textarea value={draft.overrideReason} onChange={(event) => onDraft({ ...draft, overrideReason: event.target.value })} rows={3} />
          </Field>
        )}
        {statementNeeded && (
          <Checkbox checked={draft.statement} onChange={(event) => onDraft({ ...draft, statement: event.target.checked })} label={t('sign.statement')} />
        )}
        <Field label={t('sign.note')}>
          <Textarea value={draft.note} onChange={(event) => onDraft({ ...draft, note: event.target.value })} rows={2} />
        </Field>
        <p className="fw-q-hint">{t('sign.locked')}</p>
        <p className="fw-q-hint">{t('sign.codeWords')}</p>
        {tried && <Problems keys={problems} />}
        {problem && <Problems keys={[problem]} lines={lines} title={t('sign.refused')} />}
      </div>
    </Modal>
  )
}

// ---- Release to ship (the gate in words, the second person and why) ---------------------------------------------------------------

export function ReleaseModal({
  open,
  cell,
  draft,
  overridden,
  canRelease = true,
  busy,
  problem,
  lines,
  onDraft,
  onRelease,
  onClose,
}: {
  open: boolean
  cell: FinalCell | null
  draft: ReleaseDraft
  overridden: boolean
  /** The viewer may release garments; else the dialog shows the gate and holds Release with the reason. */
  canRelease?: boolean
  busy?: boolean
  problem?: string | null
  lines?: readonly string[]
  onDraft: (draft: ReleaseDraft) => void
  onRelease: () => void
  onClose: () => void
}) {
  const t = useT('quality')
  const [tried, setTried] = useState(false)
  useEffect(() => {
    if (open) setTried(false)
  }, [open])
  const problems = cell ? releaseProblems(draft, cell) : []
  const openChecks = cell ? cell.checks.filter((check) => check.state === 'OPEN' && check.code !== 'QUANTITY') : []
  const held = !canRelease ? t('held.noRelease') : busy ? t('common.working') : cell && cell.releasable === 0 ? t('held.nothingToRelease') : openChecks.length > 0 ? t('release.heldChecks', { count: openChecks.length, check: t(`gate.${openChecks[0]!.code}`) }) : problems.length > 0 ? t(problems[0]!) : null
  const submit = () => {
    setTried(true)
    if (!held) onRelease()
  }
  useSubmitKey(open, submit)
  const quantity = Number(draft.quantity) || 0
  const serial = cell ? isSerialCell(cell) : false
  const reasons = cell ? [...new Set([...(overridden ? (['OVERRIDE'] as const) : []), ...cell.secondPersonReasons])] : []
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={cell ? t('release.title', { cell: `${cell.colourwayCode} ${cell.size}` }) : t('release.titleNone')}
      subtitle={cell ? t('release.subtitle', { releasable: cell.releasable, pieces: cell.pieces, released: cell.released }) : undefined}
      size="lg"
      footer={
        <>
          <span className="grow" />
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={submit} heldReason={held}>
            {t('release.confirm', { count: quantity })}
          </Button>
        </>
      }
    >
      {cell && (
        <div className="fw-q-form">
          <div className="fw-q-section">
            <div className="fw-q-section-title">
              <strong>{t('release.gateTitle')}</strong>
              <p className="fw-q-hint">{t('release.gateIntro')}</p>
            </div>
            <CheckList
              label={t('release.gateTitle')}
              checks={[...cell.checks]
                .sort((a, b) => GATE_ORDER[a.state] - GATE_ORDER[b.state])
                .map((check) => ({ id: check.code, state: check.state, name: t(`gate.${check.code}`), text: check.message, fix: check.fix }))}
            />
          </div>
          <div className="fw-q-section">
            <div className="fw-q-section-title">
              <strong>{t('release.whoTitle')}</strong>
            </div>
            {reasons.length === 0 ? (
              <p className="fw-q-hint">{t('release.alone')}</p>
            ) : (
              <>
                <p className="fw-q-hint">{t('release.secondPerson')}</p>
                <ul className="fw-q-lines">
                  {secondPersonKeys(reasons).map((key) => (
                    <li key={key}>{t(key)}</li>
                  ))}
                </ul>
              </>
            )}
          </div>
          {serial ? (
            <fieldset className="fw-q-choices">
              <legend>
                <strong>{t('release.serials')}</strong>
              </legend>
              {cell.readySerials.length === 0 && <p className="fw-q-hint">{t('release.noSerials')}</p>}
              {cell.readySerials.map((serialRow) => (
                <Checkbox
                  key={serialRow.id}
                  checked={draft.serialIds.includes(serialRow.id)}
                  onChange={(event) => {
                    const serialIds = event.target.checked ? [...draft.serialIds, serialRow.id] : draft.serialIds.filter((id) => id !== serialRow.id)
                    onDraft({ ...draft, serialIds, quantity: String(serialIds.length) })
                  }}
                  label={<span className="fw-q-code">{serialRow.serial}</span>}
                />
              ))}
            </fieldset>
          ) : (
            <Field label={t('release.quantity')} hint={t('release.quantityHint', { count: cell.releasable })} required>
              <Input size="sm" inputMode="numeric" value={draft.quantity} onChange={(event) => onDraft({ ...draft, quantity: event.target.value })} />
            </Field>
          )}
          <Field label={t('release.note')}>
            <Textarea value={draft.note} onChange={(event) => onDraft({ ...draft, note: event.target.value })} rows={2} />
          </Field>
          <p className="fw-q-hint">{t('release.codeWords')}</p>
          {tried && <Problems keys={problems} />}
          {problem && <Problems keys={[problem]} lines={lines} title={t('release.refused')} />}
        </div>
      )}
    </Modal>
  )
}

// ---- the sampling plan ---------------------------------------------------------------------------------------------------------

export function PlanModal({ open, draft, busy, problem, onDraft, onSave, onClose }: { open: boolean; draft: PlanDraft; busy?: boolean; problem?: string | null; onDraft: (draft: PlanDraft) => void; onSave: () => void; onClose: () => void }) {
  const t = useT('quality')
  const problems = planProblems(draft)
  const held = busy ? t('common.working') : problems.length > 0 ? t(problems[0]!) : null
  useSubmitKey(open, () => {
    if (!held) onSave()
  })
  const field = (key: keyof PlanDraft, label: string, hint?: string, inputMode: 'numeric' | 'decimal' | 'text' = 'numeric') => (
    <Field label={label} hint={hint} required>
      <Input size="sm" inputMode={inputMode} value={draft[key]} onChange={(event) => onDraft({ ...draft, [key]: event.target.value })} />
    </Field>
  )
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('plan.title')}
      size="lg"
      footer={
        <>
          <span className="grow" />
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" onClick={onSave} heldReason={held}>
            {t('plan.save')}
          </Button>
        </>
      }
    >
      <div className="fw-q-form">
        <div className="fw-q-form-three">
          {field('lotSize', t('new.lotSize'), t('new.lotSizeHint'))}
          {field('sampleSize', t('new.sampleSize'), t('new.sampleSizeHint'))}
          {field('inspectionLevel', t('new.level'), t('new.levelHint'), 'text')}
        </div>
        <div className="fw-q-form-two">
          {field('aqlMajor', t('new.aqlMajor'), t('new.aqlHint'), 'decimal')}
          {field('acceptMajor', t('new.acceptMajor'), t('new.acceptHint'))}
          {field('aqlMinor', t('new.aqlMinor'), t('new.aqlHint'), 'decimal')}
          {field('acceptMinor', t('new.acceptMinor'), t('new.acceptHint'))}
        </div>
        <p className="fw-q-hint">{t('new.tablesLater')}</p>
        {problem && <Banner tone="danger" title={t(problem)} />}
      </div>
    </Modal>
  )
}

// ---- cancel ------------------------------------------------------------------------------------------------------------------------

export function CancelModal({ open, reason, busy, problem, onReason, onCancel, onClose }: { open: boolean; reason: string; busy?: boolean; problem?: string | null; onReason: (reason: string) => void; onCancel: () => void; onClose: () => void }) {
  const t = useT('quality')
  const held = busy ? t('common.working') : reason.trim().length < 3 ? t('cancel.reasonNeeded') : null
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('cancel.title')}
      size="md"
      footer={
        <>
          <span className="grow" />
          <Button onClick={onClose}>{t('common.back')}</Button>
          <Button variant="danger" onClick={onCancel} heldReason={held}>
            {t('cancel.confirm')}
          </Button>
        </>
      }
    >
      <div className="fw-q-form">
        <p>{t('cancel.body')}</p>
        <Field label={t('cancel.reason')} required>
          <Textarea value={reason} onChange={(event) => onReason(event.target.value)} rows={3} />
        </Field>
        {problem && <Banner tone="danger" title={t(problem)} />}
      </div>
    </Modal>
  )
}
