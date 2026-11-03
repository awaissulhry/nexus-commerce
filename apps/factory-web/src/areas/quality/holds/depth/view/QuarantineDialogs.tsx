'use client'

import { useEffect, useRef } from 'react'
import { ScanLine, Warehouse } from 'lucide-react'
import { Banner, Field, SummaryTable } from '@nexus/ui/components'
import { Button, Input, Kbd, Select, Skeleton } from '@nexus/ui/primitives'
import { Modal } from '../../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { quantity } from '../../../../_shared/stock/model'
import { kindKey } from '../../model'
import { HoldsMessages, useUomWord } from '../../view/parts'
import { askProblems, confirmHeld, confirmProblems, type QuarantineDraft, type QuarantineModel } from '../model'

export interface QuarantineActions {
  onDraft?: (draft: QuarantineDraft) => void
  onAsk?: () => void
  onConfirm?: () => void
  onRetry?: () => void
  onClose?: () => void
}

/**
 * The quarantine move (QHS-078; design quality.holds qh-move, qh-grid "Ask quarantine move", floor.move "Scan the place —
 * the bin label is the confirmation"): Ask — a QUARANTINE place of the hold's site; Confirm — the place's code typed or
 * scanned (case, spaces and hyphens aside), with where the held stock lies now and what moves (our stock at an outside
 * workshop stays). Confirming moves the stock in the ledger in the same step; until the tablet's floor.move (W2b-5) the
 * office confirms it. Composed on the DS Modal; held with the reason until it can go.
 */
export function QuarantineDialogs({ model, actions }: { model: QuarantineModel; actions?: QuarantineActions }) {
  if (!model.dialog) return null
  return <HoldsMessages>{model.dialog.kind === 'ask' ? <AskDialog model={model} actions={actions} /> : <ConfirmDialog model={model} actions={actions} />}</HoldsMessages>
}

function Head({ model }: { model: QuarantineModel }) {
  const t = useT('holds')
  const hold = model.hold
  if (!hold) return null
  return (
    <p className="fw-q-hint">
      {t('qmove.of', { number: hold.number ?? '—', kind: t(kindKey(hold.subjectType)), code: hold.subjects[0]?.label ?? '—', more: hold.subjects.length > 1 ? t('subject.more', { count: hold.subjects.length - 1 }) : '' })}
    </p>
  )
}

function Refusal({ model }: { model: QuarantineModel }) {
  const t = useT('holds')
  if (!model.problem) return null
  return (
    <Banner tone="danger" title={t(model.problem)}>
      {model.lines && model.lines.length > 0 && (
        <ul className="fw-q-lines">
          {model.lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
    </Banner>
  )
}

function Lying({ model }: { model: QuarantineModel }) {
  const t = useT('holds')
  const q = useT('quality')
  const locale = useLocale()
  const uomWord = useUomWord()
  const detail = model.detail
  if (!detail || (detail.value === null && !detail.problem)) return <Skeleton height={64} />
  if (detail.problem || !detail.value) return <Banner tone="danger" title={q(detail.problem ?? 'problem.unavailable')} />
  const lying = detail.value.stock?.lying ?? []
  if (lying.length === 0) return <p className="fw-q-hint">{t('qmove.nothingLying')}</p>
  return (
    <SummaryTable
      label={t('qmove.lying')}
      stackOnPhone
      columns={[t('qmove.place'), t('qmove.onHand'), t('qmove.what')]}
      rows={lying.map((entry) => ({
        id: `${entry.locationId}|${entry.uom}`,
        cells: [`${entry.code} · ${entry.name}`, `${quantity(entry.onHand, locale)} ${uomWord(entry.uom)}`, entry.kind === 'SUBCONTRACTOR' ? t('qmove.stays') : entry.moves ? t('qmove.moves') : t('qmove.there')],
      }))}
    />
  )
}

function AskDialog({ model, actions }: { model: QuarantineModel; actions?: QuarantineActions }) {
  const t = useT('holds')
  const q = useT('quality')
  const places = model.detail?.value?.stock?.places ?? []
  const problems = askProblems(model.draft, model.detail?.value ?? null)
  const held = model.busy ? q('common.working') : problems.length > 0 ? t(problems[0]!) : null
  return (
    <Modal
      open
      onClose={() => actions?.onClose?.()}
      size="md"
      title={t('qmove.askTitle')}
      footer={
        <span className="fw-q-actions">
          <Button variant="secondary" onClick={() => actions?.onClose?.()}>
            {q('common.cancel')}
          </Button>
          <Button variant="primary" heldReason={held} onClick={() => actions?.onAsk?.()}>
            <Warehouse size={14} aria-hidden /> {t('qmove.askGo')}
          </Button>
        </span>
      }
    >
      <div className="fw-q-stack">
        <Head model={model} />
        <Refusal model={model} />
        <Field label={t('place.quarantinePlace')} hint={places.length === 0 && model.detail?.value ? t('place.noQuarantinePlace') : t('qmove.askHint')}>
          {model.detail?.value ? (
            <Select value={model.draft.locationId ?? ''} onChange={(event) => actions?.onDraft?.({ ...model.draft, locationId: event.target.value || null })} disabled={places.length === 0} aria-label={t('place.quarantinePlace')}>
              <option value="">{t('place.placePick')}</option>
              {places.map((place) => (
                <option key={place.id} value={place.id}>
                  {place.code} · {place.name}
                </option>
              ))}
            </Select>
          ) : (
            <Skeleton height={32} />
          )}
        </Field>
        <Lying model={model} />
        <p className="fw-q-hint">{t('qmove.askAfter')}</p>
      </div>
    </Modal>
  )
}

function ConfirmDialog({ model, actions }: { model: QuarantineModel; actions?: QuarantineActions }) {
  const t = useT('holds')
  const q = useT('quality')
  const input = useRef<HTMLInputElement | null>(null)
  const hold = model.hold
  const rightHeld = hold ? confirmHeld(hold, model.canTransfer) : null
  const problems = confirmProblems(model.draft, model.detail?.value ?? null)
  const held = rightHeld ? t(rightHeld) : model.busy ? q('common.working') : problems.length > 0 ? t(problems[0]!) : null
  const asked = hold?.quarantineLocation ?? null
  useEffect(() => {
    input.current?.focus()
  }, [])
  return (
    <Modal
      open
      onClose={() => actions?.onClose?.()}
      size="lg"
      title={t('qmove.confirmTitle')}
      footer={
        <span className="fw-q-actions">
          <Button variant="secondary" onClick={() => actions?.onClose?.()}>
            {q('common.cancel')}
          </Button>
          <Button variant="primary" heldReason={held} onClick={() => actions?.onConfirm?.()}>
            <ScanLine size={14} aria-hidden /> {t('qmove.confirmGo')} <Kbd>↵</Kbd>
          </Button>
        </span>
      }
    >
      <form
        className="fw-q-stack"
        onSubmit={(event) => {
          event.preventDefault()
          if (!held) actions?.onConfirm?.()
        }}
      >
        <Head model={model} />
        <Refusal model={model} />
        <p>{asked ? t('qmove.askedTo', { code: asked.code, name: asked.name }) : t('move.noPlace')}</p>
        <Field label={t('qmove.code')} hint={t('qmove.codeHint')} error={model.draft.code.trim() && problems.includes('qmove.problem.notPlace') ? t('qmove.problem.notPlace') : undefined}>
          <Input ref={input} value={model.draft.code} onChange={(event) => actions?.onDraft?.({ ...model.draft, code: event.target.value })} placeholder={asked?.code ?? ''} aria-label={t('qmove.code')} autoComplete="off" />
        </Field>
        <Lying model={model} />
        <p className="fw-q-hint">{t('qmove.confirmAfter')}</p>
      </form>
    </Modal>
  )
}
