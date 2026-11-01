'use client'

import { PauseCircle } from 'lucide-react'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Checkbox, Select, Spinner } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { unitTotals } from '../../../_shared/stock/model'
import { useUnitWord } from '../../../_shared/stock/parts'
import type { HoldActions, HoldDialogModel } from './dialog-model'
import { DAILY_NAMESPACE, holdHeldKey, reasonLabel, subjectProblemKey } from './model'
import { DailyMessages, useSay } from './parts'

/**
 * Put N lots on hold (design warehouse.stock pop:st-hold; ActionConfirm composed: the DS one speaks English only): what
 * is held (each lot, with what of it is in stock here, or why it cannot be held: the API's preview read in our words),
 * the reach ("37 hides, 412,5 m²; 2 work orders already reserved them"), the reason of the HOLD list (its note when it
 * asks for one), the quarantine move asked of the floor when the site has a quarantine place, and how it is undone (a
 * person of quality releases it, never the placer). "Put on hold" is held with the reason until it may go.
 */
export function HoldDialog({ model, actions }: { model: HoldDialogModel; actions?: HoldActions }) {
  return (
    <DailyMessages>
      <Dialog model={model} actions={actions} />
    </DailyMessages>
  )
}

function Dialog({ model, actions }: { model: HoldDialogModel; actions?: HoldActions }) {
  const t = useT(DAILY_NAMESPACE)
  const s = useT('stock')
  const say = useSay()
  const locale = useLocale()
  const unitWord = useUnitWord()
  const { draft } = model
  const count = model.subjects.length
  const lots = model.subjectType === 'Lot'
  const reasons = model.reasons.value ?? []
  const preview = model.preview.value
  const heldKey = model.reasons.value === null ? (model.reasons.problem ? 'hold.reasonsFailed' : 'hold.reasonsLoading') : holdHeldKey(draft, reasons, preview, model.posting)
  const held = heldKey ? t(heldKey) : null
  const set = (patch: Partial<typeof draft>) => actions?.onChange?.({ ...draft, ...patch })
  const reason = reasons.find((entry) => entry.code === draft.reasonCode)
  const hides = model.subjects.reduce((sum, subject) => sum + subject.hides, 0)
  const stock = unitTotals(
    model.subjects.flatMap((subject) => subject.stock),
    unitWord,
    locale,
  )
  const reach = stock === '—' ? t('hold.reachNone') : hides > 0 ? t('hold.reachHides', { count: hides, area: stock }) : stock
  const places = preview?.quarantinePlaces ?? []
  const close = () => actions?.onClose?.()

  if (model.done) {
    return (
      <Modal
        open
        onClose={close}
        size="md"
        title={lots ? t('hold.title', { count }) : t('hold.titleHides', { count })}
        footer={
          <Button size="sm" variant="primary" onClick={close}>
            {t('wo.close')}
          </Button>
        }
      >
        <Banner tone="success" title={lots ? t('hold.done', { count: model.done.count }) : t('hold.doneHides', { count: model.done.count })} />
      </Modal>
    )
  }

  return (
    <Modal
      open
      onClose={close}
      size="md"
      title={lots ? t('hold.title', { count }) : t('hold.titleHides', { count })}
      footer={
        <>
          <Button size="sm" onClick={close}>
            {s('common.cancel')}
          </Button>
          <Button size="sm" variant="warning" heldReason={held} onClick={() => actions?.onPlace?.()}>
            {model.posting ? <Spinner size={12} /> : <PauseCircle size={13} aria-hidden />} {t('hold.place')}
          </Button>
        </>
      }
    >
      <div className="fw-dy-form">
        {model.problem && <Banner tone="danger" title={say(model.problem)} />}
        {model.preview.problem && <Banner tone="danger" title={t('hold.previewFailed')} />}
        {model.reasons.problem && <Banner tone="danger" title={t('hold.reasonsFailed')} />}
        <p className="fw-dy-hint">{t('hold.intro')}</p>
        <Field label={t('hold.subjects')}>
          <ul className="fw-dy-list">
            {model.subjects.map((subject) => {
              const seen = preview?.subjects.find((entry) => entry.id === subject.id)
              const problem = seen ? subjectProblemKey(seen) : null
              return (
                <li key={subject.id}>
                  <span className="fw-dy-code">{subject.code}</span>
                  <span className="fw-st-num">{subject.hides > 0 ? t('hold.reachHides', { count: subject.hides, area: unitTotals(subject.stock, unitWord, locale) }) : unitTotals(subject.stock, unitWord, locale)}</span>
                  <span className="fw-dy-out">{!preview ? '' : problem ? t(problem) : t('hold.subjectOk')}</span>
                </li>
              )
            })}
          </ul>
        </Field>
        {model.leftOut > 0 && <p className="fw-dy-hint">{t('hold.leftOut', { count: model.leftOut })}</p>}
        {!preview && !model.preview.problem && (
          <p className="fw-dy-row fw-dy-hint" role="status">
            <Spinner size={12} /> {t('hold.preview')}
          </p>
        )}
        <p className="fw-dy-strong">{t('hold.reach', { stock: reach })}</p>
        <p className="fw-dy-hint" role="status">
          {model.reservedBy.value === null
            ? model.reservedBy.problem
              ? ''
              : t('hold.reservedLoading')
            : model.reservedBy.value.length === 0
              ? t('hold.reservedNone')
              : t('hold.reserved', { count: model.reservedBy.value.length, numbers: model.reservedBy.value.join(', ') })}
        </p>
        <Field label={t('hold.reason')} required>
          <Select value={draft.reasonCode} onChange={(event) => set({ reasonCode: event.target.value })} disabled={model.reasons.value === null}>
            <option value="">{model.reasons.value === null ? t('hold.reasonsLoading') : t('hold.reasonPick')}</option>
            {reasons.map((entry) => (
              <option key={entry.code} value={entry.code}>
                {reasonLabel(reasons, entry.code, locale)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('hold.reasonNote')} required={!!reason?.needsDetail} hint={t('hold.reasonNoteHint')}>
          <Textarea value={draft.reasonNote} onChange={(event) => set({ reasonNote: event.target.value })} limit={500} rows={2} />
        </Field>
        {places.length > 0 ? (
          <>
            <Checkbox checked={draft.askQuarantine} onChange={(event) => set({ askQuarantine: event.target.checked, quarantineLocationId: event.target.checked ? (draft.quarantineLocationId ?? places[0]?.id ?? null) : null })} label={t('hold.quarantine')} />
            {draft.askQuarantine && (
              <Field label={t('hold.quarantinePlace')} required>
                <Select value={draft.quarantineLocationId ?? ''} onChange={(event) => set({ quarantineLocationId: event.target.value || null })}>
                  {places.map((place) => (
                    <option key={place.id} value={place.id}>
                      {place.code} · {place.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </>
        ) : preview ? (
          <p className="fw-dy-hint">{t('hold.quarantineNone')}</p>
        ) : null}
        <p className="fw-dy-hint">{t('hold.reversal')}</p>
      </div>
    </Modal>
  )
}
