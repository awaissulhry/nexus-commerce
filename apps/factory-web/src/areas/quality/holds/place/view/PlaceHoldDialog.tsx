'use client'

import { useEffect } from 'react'
import { Hand } from 'lucide-react'
import { HOLD_SUBJECT_TYPES, type HoldSubjectType } from '@nexus/factory-domain/quality/holds/rules'
import { Banner, Field } from '@nexus/ui/components'
import { Button, Kbd, Select, Skeleton, Spinner, TagInput, Toggle, Input } from '@nexus/ui/primitives'
import { Modal, Textarea } from '../../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { blocksKey, isStock, kindKey, nounKey, quantityWords, placeable, placeProblems, withKind, type PlaceDraft, type PlaceModel } from '../../model'
import { HoldsMessages } from '../../view/parts'

/** Words of a work order's status change when the hold names it (the preview's `move`). */
const MOVE_KEY = { HOLD: 'place.wo.HOLD', ALREADY: 'place.wo.ALREADY', KEEP: 'place.wo.KEEP', REFUSED: 'place.wo.REFUSED' } as const

/**
 * Place hold (design quality.holds/pop:qh-place; opened by the page's primary, `c`, `?new=1`, and the row verbs of other
 * lists — an inspection's "Place hold"): one kind of record per hold, the records by scan or typed code (several at once)
 * or named by the list that opened it, the preview after each change (each record's problem in our words with the API's
 * sentence under it; what the hold blocks; the work orders that go on hold), the reason of the HOLD list and its note,
 * the owner, the expected release, the move to quarantine (stock only, on by default) and its place, a note. "Place hold
 * on 3 lots" is held with the reason until it can go; ⌘Enter places. One view model, nothing fetched.
 */
export function PlaceHoldDialog({ model, onDraft, onPlace, onClose }: { model: PlaceModel; onDraft?: (draft: PlaceDraft) => void; onPlace?: () => void; onClose: () => void }) {
  return (
    <HoldsMessages>
      <Dialog model={model} onDraft={onDraft} onPlace={onPlace} onClose={onClose} />
    </HoldsMessages>
  )
}

function Dialog({ model, onDraft, onPlace, onClose }: { model: PlaceModel; onDraft?: (draft: PlaceDraft) => void; onPlace?: () => void; onClose: () => void }) {
  const t = useT('holds')
  const q = useT('quality')
  const locale = useLocale()
  const draft = model.draft
  const preview = model.preview?.value ?? null
  const reasons = model.reasons.value ?? []
  const problems = placeProblems(draft, preview, reasons, model.today)
  const ready = placeable(preview)
  const held = model.held ? t(model.held) : model.busy ? q('common.working') : problems.length > 0 ? t(problems[0]!) : null
  const set = (change: Partial<PlaceDraft>) => onDraft?.({ ...draft, ...change })
  const fields = new Set(model.fields ?? [])
  const reason = reasons.find((entry) => entry.code === draft.reasonCode) ?? null

  useEffect(() => {
    if (!model.open) return
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !held) {
        event.preventDefault()
        onPlace?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!model.open) return null
  const count = ready.length
  const noun = t(nounKey(draft.subjectType), { count: Math.max(count, 1) })
  const labelOf = (entry: { labelIt: string; labelEn: string }) => (locale === 'it' ? entry.labelIt || entry.labelEn : entry.labelEn || entry.labelIt)
  const places = preview?.quarantinePlaces ?? []
  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={t('place.title')}
      footer={
        <span className="fw-q-actions">
          <Button variant="secondary" onClick={onClose}>
            {q('common.cancel')}
          </Button>
          <Button variant="primary" heldReason={held} onClick={() => onPlace?.()}>
            <Hand size={14} aria-hidden /> {count > 0 ? t('place.go', { count, noun }) : t('place.goNone')} <Kbd>⌘↵</Kbd>
          </Button>
        </span>
      }
    >
      <div className="fw-q-stack">
        {draft.fromLabel && <p className="fw-q-hint">{t('place.from', { label: draft.fromLabel })}</p>}
        {model.problem && (
          <Banner tone="danger" title={t(model.problem)}>
            {model.lines && model.lines.length > 0 && (
              <ul className="fw-q-lines">
                {model.lines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
          </Banner>
        )}
        <div className="fw-q-form fw-q-form-two">
          <Field label={t('place.kind')} hint={t('place.kindHint')}>
            <Select value={draft.subjectType} onChange={(event) => onDraft?.(withKind(draft, event.target.value as HoldSubjectType))} disabled={draft.ids.length > 0 && draft.sourceType !== null}>
              {HOLD_SUBJECT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {t(kindKey(type))}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('place.codes')} hint={draft.ids.length > 0 ? t('place.named', { count: draft.ids.length }) : t('place.codesHint')} error={fields.has('subjectIds') ? t('place.problem.records') : undefined}>
            <TagInput value={[...draft.codes]} onChange={(codes) => set({ codes })} placeholder={t('place.codesPlaceholder')} aria-label={t('place.codes')} maxTags={100} />
          </Field>
        </div>

        <section className="fw-hd-preview" aria-live="polite" aria-label={t('place.preview')}>
          {draft.ids.length + draft.codes.length === 0 ? (
            <p className="fw-q-hint">{t('place.previewEmpty')}</p>
          ) : model.preview === null || (model.preview.value === null && !model.preview.problem) ? (
            <p className="fw-q-loading" role="status">
              <Spinner size={14} /> {t('place.previewing')}
            </p>
          ) : model.preview.problem ? (
            <Banner tone="danger" title={t('place.previewFailed')}>
              {q(model.preview.problem)}
            </Banner>
          ) : preview ? (
            <>
              {count > 0 && (
                <p className="fw-hd-blocks">
                  <strong>{t('place.blocks', { what: t(blocksKey(draft.subjectType)), count, noun })}</strong>
                  {preview.quantity ? <span className="fw-q-hint"> {t('place.amount', { quantity: quantityWords(preview.quantity, t) ?? '' })}</span> : null}
                </p>
              )}
              <ul className="fw-q-lines" aria-label={t('place.records')}>
                {preview.subjects.map((row, index) => (
                  <li key={`${row.id ?? row.code ?? 'x'}-${index}`} className={row.problem ? 'fw-hd-problem' : undefined}>
                    <strong className="fw-q-code">{row.label ?? row.code ?? '—'}</strong>{' '}
                    {row.problem ? (
                      <>
                        — {t('place.recordProblem')} <span className="fw-q-hint fw-hd-api">{row.problem}</span>
                      </>
                    ) : (
                      <span className="fw-q-hint">— {quantityWords(row.quantity, t) ?? t('place.recordOk')}</span>
                    )}
                  </li>
                ))}
              </ul>
              {preview.workOrders.length > 0 && (
                <ul className="fw-q-lines" aria-label={t('place.workOrders')}>
                  {preview.workOrders.map((order) => (
                    <li key={order.id}>
                      <strong className="fw-q-code">{order.number}</strong> — {t(MOVE_KEY[order.move])}
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : null}
        </section>

        <div className="fw-q-form fw-q-form-two">
          <Field label={t('place.reason')} error={fields.has('reasonCode') ? t('place.problem.reason') : undefined}>
            {model.reasons.problem ? (
              <Banner tone="danger" title={q(model.reasons.problem)} />
            ) : model.reasons.value === null ? (
              <Skeleton height={32} />
            ) : (
              <Select value={draft.reasonCode ?? ''} onChange={(event) => set({ reasonCode: event.target.value || null })}>
                <option value="">{t('place.reasonPick')}</option>
                {reasons.map((entry) => (
                  <option key={entry.code} value={entry.code}>
                    {labelOf(entry)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('place.reasonNote')} hint={reason?.needsDetail ? t('place.reasonNoteNeeded') : t('place.reasonNoteHint')} error={fields.has('reasonNote') ? t('place.problem.reasonNote') : undefined}>
            <Input value={draft.reasonNote} onChange={(event) => set({ reasonNote: event.target.value })} maxLength={500} />
          </Field>
          <Field label={t('place.owner')} hint={t('place.ownerHint')} error={fields.has('ownerId') ? t('place.problem.owner') : undefined}>
            {model.people === null ? (
              <p className="fw-q-hint">{t('place.ownerAfter')}</p>
            ) : model.people.problem ? (
              <Banner tone="danger" title={q(model.people.problem)} />
            ) : model.people.value === null ? (
              <Skeleton height={32} />
            ) : (
              <Select value={draft.ownerId ?? ''} onChange={(event) => set({ ownerId: event.target.value || null })}>
                <option value="">{t('owner.nobody')}</option>
                {model.people.value.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.me ? t('owner.meNamed', { name: person.name }) : person.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('place.expected')} hint={t('place.expectedHint')} error={fields.has('expectedReleaseOn') ? t('place.problem.date') : undefined}>
            <Input type="date" min={model.today} value={draft.expectedReleaseOn} onChange={(event) => set({ expectedReleaseOn: event.target.value })} />
          </Field>
        </div>

        {isStock(draft.subjectType) ? (
          <div className="fw-q-form fw-q-form-two">
            <Field label={t('place.quarantine')} hint={t('place.quarantineHint')}>
              <Toggle checked={draft.askQuarantine} onChange={(on) => set({ askQuarantine: on, quarantineLocationId: on ? draft.quarantineLocationId : null })} aria-label={t('place.quarantine')} />
            </Field>
            {draft.askQuarantine && (
              <Field label={t('place.quarantinePlace')} hint={places.length === 0 && preview ? t('place.noQuarantinePlace') : t('place.quarantinePlaceHint')} error={fields.has('quarantineLocationId') ? t('place.problem.place') : undefined}>
                <Select value={draft.quarantineLocationId ?? ''} onChange={(event) => set({ quarantineLocationId: event.target.value || null })} disabled={places.length === 0}>
                  <option value="">{t('place.placePick')}</option>
                  {places.map((place) => (
                    <option key={place.id} value={place.id}>
                      {place.code} · {place.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </div>
        ) : (
          <p className="fw-q-hint">{t('place.noQuarantine')}</p>
        )}
        <Field label={t('place.note')} error={fields.has('note') ? t('place.problem.noteLong') : undefined}>
          <Textarea rows={3} value={draft.note} onChange={(event) => set({ note: event.target.value })} />
        </Field>
        <p className="fw-q-hint">{t('place.after')}</p>
      </div>
    </Modal>
  )
}
