'use client'

import { useRef } from 'react'
import Link from 'next/link'
import { Camera, ExternalLink } from 'lucide-react'
import { Banner, Card, Field, KeyValue, Stepper } from '@nexus/ui/components'
import { Button, Input, Select, Spinner } from '@nexus/ui/primitives'
import { EditModeBar, Textarea } from '../../../../../lib/i18n/ds-parts'
import { DEFECT_CLASSES, QUALITY_STAGES, UOMS, type NcrRecord } from '../../api'
import { bandHeld, stepsOf, type Say } from '../../model'
import { ContainmentDue, DecidedBar, QuantityText, SeverityTag, zoneWords } from '../../parts'
import { changesOf, draftHeld, draftOf, recordHref, ZONES, type NcrRecordActions, type NcrRecordModel, type ProblemDraft } from '../view-model'
import { codeLabel, type RecordWords } from './words'

const STEPS = ['OPEN', 'CONTAINED', 'DECIDED', 'CLOSED'] as const

/**
 * Problem & evidence (design rec NCR › problem: ncr-what "What happened" and ncr-side "Stage and next step"). A form with
 * an explicit save (the DS EditModeBar, ⌘S) while the NCR is open or contained and the person follows NCRs up; read-only
 * text after it is decided (said in a banner). The garment zone is the design's GarmentZoneMap (new), composed as a zone
 * picker in words until the DS has the map. Photos are the NCR's own files (kind PHOTO). The aside: the Stepper, what the
 * next stage still needs, the owner, the containment countdown, the PPE register entry.
 */
export function ProblemTab({ model, record, words, actions }: { model: NcrRecordModel; record: NcrRecord; words: RecordWords; actions?: NcrRecordActions }) {
  const { t, r, say, person, when, locale } = words
  const ncr = record.ncr
  const held = bandHeld(record)
  const editHeld: Say | null = held.edit ?? (model.can.manage ? null : { key: 'held.noManage' })
  const editable = editHeld === null
  const draft: ProblemDraft = model.draft ?? draftOf(ncr, model.timeZone)
  const changes = editable ? changesOf(ncr, draft, model.timeZone) : {}
  const count = Object.keys(changes).length
  const unitFixed = Number(ncr.decided.decided) > 0
  const steps = stepsOf(record)
  const set = (patch: Partial<ProblemDraft>) => actions?.onDraft?.(patch)
  const file = useRef<HTMLInputElement>(null)
  const defects = model.choices.defects.items
  const defectLabel = ncr.defect ? `${ncr.defect.code} · ${locale.startsWith('it') ? ncr.defect.labelIt : ncr.defect.labelEn}` : t('new.defectNone')
  const people = model.people ?? []
  const ownerOptions = ncr.ownerId && !people.some((entry) => entry.id === ncr.ownerId) ? [{ id: ncr.ownerId, name: person(ncr.ownerId), me: false }, ...people] : people

  const facts = [
    { label: r('fact.style'), value: ncr.style ? [`${ncr.style.code} · ${ncr.style.name}`, ncr.colourway?.code, ncr.size].filter(Boolean).join(' · ') : '—', hint: ncr.style?.ppe ? r('fact.ppe') : undefined },
    { label: r('fact.serial'), value: ncr.serial ?? '—' },
    { label: r('fact.workOrder'), value: ncr.workOrder ? <Link className="fw-q-link" href={recordHref(model.prefix, { type: 'WorkOrder', id: ncr.workOrder.id, label: ncr.workOrder.number })}>{ncr.workOrder.number}</Link> : '—' },
    { label: r('fact.lot'), value: ncr.lot ? <Link className="fw-q-link" href={recordHref(model.prefix, { type: 'Lot', id: ncr.lot.id, label: ncr.lot.code })}>{ncr.lot.code}</Link> : '—' },
    { label: r('fact.item'), value: ncr.item ? `${ncr.item.code} · ${ncr.item.name}` : '—' },
    { label: r('fact.supplier'), value: ncr.supplier ? `${ncr.supplier.code} · ${ncr.supplier.name}` : '—' },
    { label: r('fact.foundBy'), value: ncr.foundBy.kind === 'USER' ? person(ncr.foundBy.userId) : ncr.foundBy.kind === 'WORKER' ? r('fact.foundByWorker') : '—' },
    { label: r('fact.raised'), value: `${when(ncr.createdAt)} · ${person(ncr.createdById)}` },
  ]

  return (
    <div className="fw-q-main-side">
      <div className="fw-q-stack">
        <Card padded>
          <section className="fw-q-stack" aria-labelledby="ncr-what">
            <h2 id="ncr-what" className="fw-ncr-h3">
              {r('problem.what')}
            </h2>
            {!editable && <Banner tone="info" title={say(editHeld) ?? ''} />}
            {editable ? (
              <div className="fw-ncr-form">
                <Field label={t('new.fieldTitle')} hint={t('new.fieldTitleHint')} required className="is-wide">
                  <Input value={draft.title} maxLength={200} onChange={(event) => set({ title: event.target.value })} />
                </Field>
                <Field label={t('new.description')} className="is-wide">
                  <Textarea value={draft.description} rows={4} maxLength={4000} onChange={(event) => set({ description: event.target.value })} />
                </Field>
                <Field label={t('new.affected')} required>
                  <Input inputMode="decimal" value={draft.quantityAffected} onChange={(event) => set({ quantityAffected: event.target.value })} />
                </Field>
                <Field label={t('new.suspect')} hint={t('new.suspectHint')}>
                  <Input inputMode="decimal" value={draft.quantitySuspect} onChange={(event) => set({ quantitySuspect: event.target.value })} />
                </Field>
                <Field label={t('new.unit')} hint={unitFixed ? r('problem.unitFixed') : undefined}>
                  {unitFixed ? (
                    <span className="fw-q-num">{t(`uom.${ncr.uom}`)}</span>
                  ) : (
                    <Select value={draft.uom} onChange={(event) => set({ uom: event.target.value as ProblemDraft['uom'] })}>
                      {UOMS.map((uom) => (
                        <option key={uom} value={uom}>
                          {t(`uom.${uom}`)}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                <Field label={t('new.severity')}>
                  <Select value={draft.severity} onChange={(event) => set({ severity: event.target.value as ProblemDraft['severity'] })}>
                    {DEFECT_CLASSES.map((severity) => (
                      <option key={severity} value={severity}>
                        {t(`severity.${severity}`)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={t('new.defect')} hint={model.choices.defects.problem ? t('new.defectsFailed') : undefined}>
                  <Select value={draft.defectCodeId} onFocus={() => actions?.onNeed?.('defects')} onChange={(event) => set({ defectCodeId: event.target.value })}>
                    <option value="">{t('new.defectNone')}</option>
                    {ncr.defect && !defects?.some((entry) => entry.id === ncr.defect?.id) && <option value={ncr.defect.id}>{defectLabel}</option>}
                    {(defects ?? []).map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {`${entry.code} · ${codeLabel(entry, locale)} (${t(`severity.${entry.severity}`)})`}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={t('new.zone')} hint={t('new.zoneHint')}>
                  <Select value={draft.zone} onChange={(event) => set({ zone: event.target.value })}>
                    <option value="">{t('new.zoneNone')}</option>
                    {draft.zone && !(ZONES as readonly string[]).includes(draft.zone) && <option value={draft.zone}>{draft.zone}</option>}
                    {ZONES.map((zone) => (
                      <option key={zone} value={zone}>
                        {t(`zone.${zone}`)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={t('new.foundAt')}>
                  <Select value={draft.foundAt} onChange={(event) => set({ foundAt: event.target.value as ProblemDraft['foundAt'] })}>
                    {QUALITY_STAGES.map((stage) => (
                      <option key={stage} value={stage}>
                        {t(`foundAt.${stage}`)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={r('problem.foundOn')} hint={r('problem.zoneTime')}>
                  <Input type="datetime-local" value={draft.foundOn} onChange={(event) => set({ foundOn: event.target.value })} />
                </Field>
                <Field label={t('new.owner')} hint={model.people === null ? r('people.reading') : undefined}>
                  <Select value={draft.ownerId} onChange={(event) => set({ ownerId: event.target.value })}>
                    <option value="">{t('new.ownerNone')}</option>
                    {ownerOptions.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.me ? t('common.me', { name: entry.name }) : entry.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={r('problem.containmentDue')} hint={r('problem.zoneTime')}>
                  <Input type="datetime-local" value={draft.containmentDueAt} onChange={(event) => set({ containmentDueAt: event.target.value })} />
                </Field>
              </div>
            ) : (
              <KeyValue
                columns={2}
                labelCase="sentence"
                items={[
                  { label: t('new.fieldTitle'), value: ncr.title },
                  { label: t('new.description'), value: ncr.description ?? '—' },
                  { label: t('col.quantity'), value: <QuantityText ncr={ncr} /> },
                  { label: t('new.severity'), value: <SeverityTag severity={ncr.severity} /> },
                  { label: t('new.defect'), value: defectLabel },
                  { label: t('new.zone'), value: zoneWords(t, ncr.zone) ?? t('new.zoneNone') },
                  { label: t('new.foundAt'), value: t(`foundAt.${ncr.foundAt}`) },
                  { label: r('problem.foundOn'), value: when(ncr.foundOn) },
                  { label: t('new.owner'), value: person(ncr.ownerId) },
                  { label: r('problem.containmentDue'), value: when(ncr.containmentDueAt) },
                ]}
              />
            )}
            {editable && count > 0 && (
              <EditModeBar
                count={count}
                message={r('problem.unsaved', { count })}
                applyLabel={r('problem.save')}
                busy={model.saving}
                applyHeldReason={draftHeld(draft) ? r(draftHeld(draft)!) : null}
                onApply={() => actions?.onSave?.()}
                onDiscard={() => actions?.onDiscard?.()}
                saveShortcut
              />
            )}
          </section>
        </Card>

        <Card padded>
          <section className="fw-q-stack" aria-labelledby="ncr-photos">
            <div className="fw-ncr-head">
              <h2 id="ncr-photos" className="fw-ncr-h3">
                {t('new.photos')}
              </h2>
              <Button size="sm" heldReason={!model.can.filesUpload ? t('new.photosHeld') : model.uploading > 0 ? r('photos.uploading') : null} onClick={() => file.current?.click()}>
                {model.uploading > 0 ? <Spinner size={12} /> : <Camera size={14} aria-hidden />} {t('new.photosAdd')}
              </Button>
              <input
                ref={file}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(event) => {
                  const picked = [...(event.target.files ?? [])]
                  event.target.value = ''
                  if (picked.length > 0) actions?.onPhotos?.(picked)
                }}
              />
            </div>
            {model.photos.problem ? (
              <p className="fw-q-hint">{r('photos.failed')}</p>
            ) : model.photos.items === null ? (
              <p className="fw-q-loading" role="status">
                <Spinner size={14} /> {r('photos.reading')}
              </p>
            ) : model.photos.items.length === 0 ? (
              <p className="fw-q-hint">{r('photos.none')}</p>
            ) : (
              <ul className="fw-ncr-r-files">
                {model.photos.items.map((photo) => (
                  <li key={photo.id}>
                    <Button size="sm" variant="quiet" onClick={() => actions?.onOpenPhoto?.(photo)} aria-label={r('photos.open', { name: photo.name })}>
                      <ExternalLink size={13} aria-hidden /> {photo.name}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <p className="fw-q-hint">{r('photos.hint')}</p>
          </section>
        </Card>

        <Card padded>
          <section className="fw-q-stack" aria-labelledby="ncr-about">
            <h2 id="ncr-about" className="fw-ncr-h3">
              {r('problem.about')}
            </h2>
            <KeyValue columns={2} labelCase="sentence" items={facts} />
          </section>
        </Card>
      </div>

      <aside className="fw-q-stack" aria-label={r('side.label')}>
        <Card padded>
          <section className="fw-q-stack" aria-labelledby="ncr-side">
            <h2 id="ncr-side" className="fw-ncr-h3">
              {r('side.title')}
            </h2>
            {ncr.stage === 'CANCELLED' ? (
              <Banner tone="info" title={r('side.cancelled', { reason: ncr.cancelReason ?? '—' })} />
            ) : (
              <Stepper current={steps.current} steps={STEPS.map((stage) => ({ key: stage, label: t(`stage.${stage}`) }))} />
            )}
            {steps.next && steps.missing.length > 0 ? (
              <div className="fw-q-stack">
                <p className="fw-q-hint">{r('side.missing', { stage: t(`stage.${steps.next}`) })}</p>
                <ul className="fw-q-lines">
                  {steps.missing.map((line, index) => (
                    <li key={index}>{say(line)}</li>
                  ))}
                </ul>
              </div>
            ) : steps.next ? (
              <p className="fw-q-hint">{r('side.ready', { stage: t(`stage.${steps.next}`) })}</p>
            ) : null}
            <DecidedBar ncr={ncr} />
            <KeyValue
              labelCase="sentence"
              dense
              items={[
                { label: t('new.owner'), value: person(ncr.ownerId) },
                { label: r('problem.containmentDue'), value: <ContainmentDue ncr={ncr} now={model.now} /> },
                { label: r('side.register'), value: record.register ? <Link className="fw-q-link" href={recordHref(model.prefix, { type: 'PpeRegisterEntry', id: record.register.id, label: record.register.reference })}>{record.register.reference}</Link> : ncr.style?.ppe ? r('side.registerNone') : r('side.registerNotPpe') },
              ]}
            />
            {ncr.stage === 'CLOSED' && <p className="fw-q-hint">{r('side.closed', { when: when(ncr.closedAt), who: person(ncr.closedById), note: ncr.closeNote ?? '—' })}</p>}
          </section>
        </Card>
      </aside>
    </div>
  )
}
