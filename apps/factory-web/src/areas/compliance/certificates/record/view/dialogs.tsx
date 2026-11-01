'use client'

import { Search } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Checkbox, Input, SegmentedControl, Spinner, Tag, Toggle } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { useT } from '../../../../../lib/i18n/provider'
import { CheckList, type CheckLine } from '../../../../quality/_shared/parts'
import type { CertificateDetail } from '../../api'
import { coverageHeld, registerChecks, registerHeld, type CertificateRecordModel } from '../../model'
import { useProblemWords } from '../../view/parts'
import type { CertificateRecordActions } from './CertificateRecordView'

/** The register checklist in words (pdf, data, validity, coverage). */
export function useRegisterLines(certificate: CertificateDetail, today: string): CheckLine[] {
  const t = useT('certificates')
  const words = useProblemWords()
  return registerChecks(certificate, today).map((check) => ({
    id: check.id,
    state: check.ok ? 'OK' : 'OPEN',
    name: t(`register.check.${check.id}.name`),
    text: t(`register.check.${check.id}.${check.ok ? 'ok' : 'open'}`),
    fix: check.id === 'data' && check.problems && check.problems.length > 0 ? check.problems.map(words).join(' · ') : t(`register.check.${check.id}.fix`),
  }))
}

function Problem({ problem, lines }: { problem: string | null; lines: readonly string[] }) {
  const t = useT('certificates')
  if (!problem) return null
  return (
    <Banner tone="danger" title={t(problem)}>
      {lines.length > 0 && (
        <ul className="fw-q-lines fw-ce-data">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
    </Banner>
  )
}

/**
 * Register certificate (design ce-register): once registered only its status changes, a correction is a new certificate;
 * the checks first (PDF attached, the data checks incl. five years, a validity not ended, at least one coverage), the
 * confirm held with the first open one. A refusal shows the API's sentences under our words.
 */
export function RegisterDialog({ certificate, model, actions }: { certificate: CertificateDetail; model: CertificateRecordModel; actions?: CertificateRecordActions }) {
  const t = useT('certificates')
  const lines = useRegisterLines(certificate, model.today)
  const why = registerHeld(certificate, model.can, model.today)
  const held = why ? t(why) : model.busy ? t('held.busy') : null
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t('register.confirmTitle', { number: certificate.number })}
      size="md"
      footer={
        <>
          <Button onClick={() => actions?.onDialog?.(null)}>{t('common.back')}</Button>
          <Button variant="primary" heldReason={held} onClick={() => actions?.onRegister?.()}>
            {model.busy ? <Spinner size={12} /> : null} {t('register.confirm')}
          </Button>
        </>
      }
    >
      <div className="fw-ce-dialog">
        <p>{t('register.once')}</p>
        <CheckList checks={lines} label={t('register.title')} />
        <Problem problem={model.dialogProblem} lines={model.dialogLines} />
      </div>
    </Modal>
  )
}

/**
 * Mark suspended / Mark withdrawn / Reinstate (design ce-suspend): the impact first, as far as the register knows it (the
 * styles and parts it covers; their open work orders, stock and shipments are not served yet), then the notified body's
 * words. Suspending and withdrawing only protect; withdrawing is final.
 */
export function StatusDialog({ certificate, move, model, actions }: { certificate: CertificateDetail; move: 'suspend' | 'withdraw' | 'reinstate'; model: CertificateRecordModel; actions?: CertificateRecordActions }) {
  const t = useT('certificates')
  const covered = certificate.coverage.filter((entry) => entry.status === 'ACTIVE')
  const needsReason = move !== 'reinstate'
  const held = !model.can.manage ? t('held.manage') : needsReason && model.statusReason.trim() === '' ? t('status.held.reason') : model.statusReason.trim().length > 500 ? t('held.long') : model.busy ? t('held.busy') : null
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t(`move.${move}.title`, { number: certificate.number })}
      size="md"
      footer={
        <>
          <Button onClick={() => actions?.onDialog?.(null)}>{t('common.back')}</Button>
          <Button variant={move === 'reinstate' ? 'primary' : 'danger'} heldReason={held} onClick={() => actions?.onMove?.(move)}>
            {model.busy ? <Spinner size={12} /> : null} {t(`move.${move}.confirm`)}
          </Button>
        </>
      }
    >
      <div className="fw-ce-dialog">
        <p>{t(`move.${move}.what`)}</p>
        {covered.length > 0 ? (
          <div>
            <p className="fw-q-hint">{t(`move.${move}.impact`, { count: covered.length })}</p>
            <ul className="fw-q-lines">
              {covered.map((entry) => (
                <li key={entry.id}>
                  <span className="fw-q-code">{entry.style?.code ?? entry.item?.code ?? '—'}</span> {entry.style?.name ?? entry.item?.name ?? ''}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="fw-q-hint">{t('move.nothingCovered')}</p>
        )}
        <p className="fw-q-hint">{t('move.notServed')}</p>
        <Field label={t(needsReason ? 'move.reason' : 'move.reasonOptional')} required={needsReason} hint={t('move.reasonHint')}>
          <Textarea value={model.statusReason} rows={3} maxLength={500} onChange={(event) => actions?.onStatusReason?.(event.target.value)} />
        </Field>
        <Problem problem={model.dialogProblem} lines={model.dialogLines} />
      </div>
    </Modal>
  )
}

/**
 * Add coverage: a style — every colourway or some, the whole range or some sizes, made-to-measure — or a part (a
 * protector or a material it was tested with). One active coverage per style or part: to change it, end it first.
 */
export function AddCoverageDialog({ certificate, model, actions }: { certificate: CertificateDetail; model: CertificateRecordModel; actions?: CertificateRecordActions }) {
  const t = useT('certificates')
  const q = useT('quality')
  const draft = model.coverageDraft
  const set = (patch: Partial<typeof draft>) => actions?.onCoverageDraft?.({ ...draft, ...patch })
  const why = !model.can.manage ? 'held.manage' : coverageHeld(draft, certificate, model.busy)
  const style = draft.style?.value ?? null
  const options = draft.target === 'style' ? draft.styles : draft.materials
  const toggle = (list: readonly string[], value: string) => (list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value])
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t('coverage.addTitle', { number: certificate.number })}
      size="lg"
      footer={
        <>
          <Button onClick={() => actions?.onDialog?.(null)}>{t('common.back')}</Button>
          <Button variant="primary" heldReason={why ? t(why) : null} onClick={() => actions?.onAddCoverage?.()}>
            {model.busy ? <Spinner size={12} /> : null} {t('coverage.addConfirm')}
          </Button>
        </>
      }
    >
      <div className="fw-ce-dialog">
        <SegmentedControl
          ariaLabel={t('coverage.target')}
          value={draft.target}
          onChange={(value) => set({ target: value as typeof draft.target, query: '', styles: null, materials: null, style: null, item: null })}
          options={[
            { value: 'style', label: t('coverage.targetStyle'), disabled: !model.can.styles },
            { value: 'item', label: t('coverage.targetItem'), disabled: !model.can.materials },
          ]}
        />
        {(draft.target === 'style' && !model.can.styles) || (draft.target === 'item' && !model.can.materials) ? (
          <Banner tone="info" title={t(draft.target === 'style' ? 'check.held.styles' : 'coverage.held.materials')} />
        ) : (draft.target === 'style' && style) || (draft.target === 'item' && draft.item) ? (
          <div className="fw-q-cell-row">
            <span className="fw-q-code">{draft.target === 'style' ? style!.code : draft.item!.code}</span>
            <span>{draft.target === 'style' ? style!.name : draft.item!.name}</span>
            <Button size="sm" variant="link" onClick={() => set({ style: null, item: null })}>
              {t('check.changeStyle')}
            </Button>
          </div>
        ) : (
          <div className="fw-ce-pick">
            <Field label={t(draft.target === 'style' ? 'check.style' : 'coverage.item')}>
              <Input
                type="search"
                autoFocus
                leadingIcon={<Search size={14} aria-hidden />}
                value={draft.query}
                placeholder={t(draft.target === 'style' ? 'check.styleSearch' : 'coverage.itemSearch')}
                onChange={(event) => actions?.onCoverageQuery?.(event.target.value)}
              />
            </Field>
            {options?.problem ? (
              <p className="fw-q-hint">{q(options.problem)}</p>
            ) : options?.value ? (
              options.value.length === 0 ? (
                <p className="fw-q-hint">{t('check.noStyles')}</p>
              ) : (
                <ul className="fw-ce-options" aria-label={t(draft.target === 'style' ? 'check.styles' : 'coverage.items')}>
                  {draft.target === 'style'
                    ? draft.styles!.value!.map((option) => (
                        <li key={option.id}>
                          <Button size="sm" variant="quiet" onClick={() => actions?.onCoverageStyle?.(option)}>
                            <span className="fw-q-code">{option.code}</span> {option.name}
                          </Button>
                        </li>
                      ))
                    : draft.materials!.value!.map((option) => (
                        <li key={option.id}>
                          <Button size="sm" variant="quiet" onClick={() => actions?.onCoverageItem?.(option)}>
                            <span className="fw-q-code">{option.code}</span> {option.name} {option.isPpeComponent && <Tag tone="info">{t('coverage.ppeComponent')}</Tag>}
                          </Button>
                        </li>
                      ))}
                </ul>
              )
            ) : options ? (
              <p className="fw-q-loading">
                <Spinner size={12} /> {q('common.loading')}
              </p>
            ) : null}
          </div>
        )}
        {draft.target === 'style' && draft.style?.problem && <Banner tone="danger" title={q(draft.style.problem)} />}
        {draft.target === 'style' && draft.style && !draft.style.value && !draft.style.problem && (
          <p className="fw-q-loading">
            <Spinner size={12} /> {q('common.loading')}
          </p>
        )}
        {draft.target === 'style' && style && (
          <>
            <fieldset className="fw-ce-fieldset">
              <legend>{t('coverage.colourways')}</legend>
              <Toggle checked={draft.allColours} onChange={(next) => set({ allColours: next, colourwayIds: next ? [] : draft.colourwayIds })} aria-label={t('coverage.allColours')} />{' '}
              <span>{t('coverage.allColours')}</span>
              {!draft.allColours && (
                <div className="fw-ce-ticks">
                  {style.colourways
                    .filter((entry) => entry.status === 'ACTIVE')
                    .map((entry) => (
                      <Checkbox key={entry.id} label={`${entry.code} · ${entry.name}`} checked={draft.colourwayIds.includes(entry.id)} onChange={() => set({ colourwayIds: toggle(draft.colourwayIds, entry.id) })} />
                    ))}
                </div>
              )}
            </fieldset>
            <fieldset className="fw-ce-fieldset">
              <legend>{t('coverage.sizes')}</legend>
              <Toggle checked={draft.wholeRange} onChange={(next) => set({ wholeRange: next, sizes: next ? [] : draft.sizes })} aria-label={t('coverage.wholeRange')} />{' '}
              <span>{t('coverage.wholeRangeOf', { sizes: style.sizes.join(' ') || '—' })}</span>
              {!draft.wholeRange && (
                <div className="fw-ce-ticks">
                  {style.sizes.map((size) => (
                    <Checkbox key={size} label={size} checked={draft.sizes.includes(size)} onChange={() => set({ sizes: toggle(draft.sizes, size) })} />
                  ))}
                </div>
              )}
            </fieldset>
            <Field label={t('coverage.mtmField')} hint={t(style.mtmAllowed ? 'coverage.mtmHint' : 'coverage.mtmStyleOff')}>
              <span className="fw-q-cell-row">
                <Toggle checked={draft.allowsMadeToMeasure} onChange={(next) => set({ allowsMadeToMeasure: next })} aria-label={t('coverage.mtmField')} />
                {t(draft.allowsMadeToMeasure ? 'common.yes' : 'common.no')}
              </span>
            </Field>
          </>
        )}
        <Field label={t('coverage.note')} hint={t('coverage.noteHint')}>
          <Textarea value={draft.note} rows={2} maxLength={500} onChange={(event) => set({ note: event.target.value })} />
        </Field>
        <Problem problem={model.dialogProblem} lines={model.dialogLines} />
      </div>
    </Modal>
  )
}

/** End coverage: archived with the reason, never deleted; to widen it, add the new coverage after. */
export function EndCoverageDialog({ certificate, coverageId, model, actions }: { certificate: CertificateDetail; coverageId: string; model: CertificateRecordModel; actions?: CertificateRecordActions }) {
  const t = useT('certificates')
  const coverage = certificate.coverage.find((entry) => entry.id === coverageId)
  const held = !model.can.manage ? t('held.manage') : model.endReason.trim() === '' ? t('coverage.held.reason') : model.endReason.trim().length > 500 ? t('held.long') : model.busy ? t('held.busy') : null
  return (
    <Modal
      open
      onClose={() => actions?.onDialog?.(null)}
      title={t('coverage.endTitle', { code: coverage?.style?.code ?? coverage?.item?.code ?? '—' })}
      size="md"
      footer={
        <>
          <Button onClick={() => actions?.onDialog?.(null)}>{t('common.back')}</Button>
          <Button variant="danger" heldReason={held} onClick={() => actions?.onEndCoverage?.()}>
            {model.busy ? <Spinner size={12} /> : null} {t('coverage.endConfirm')}
          </Button>
        </>
      }
    >
      <div className="fw-ce-dialog">
        <ul className="fw-q-lines">
          <li>{t('coverage.endWhat')}</li>
          <li>{t('coverage.endKept')}</li>
          <li>{t('coverage.endWiden')}</li>
        </ul>
        <Field label={t('coverage.endReason')} required>
          <Textarea value={model.endReason} rows={2} maxLength={500} onChange={(event) => actions?.onEndReason?.(event.target.value)} />
        </Field>
        <Problem problem={model.dialogProblem} lines={model.dialogLines} />
      </div>
    </Modal>
  )
}
