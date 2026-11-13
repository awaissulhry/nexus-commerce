'use client'

import { ArrowDown, ArrowUp, Eye, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { Banner, Card, Field, SummaryTable } from '@nexus/ui/components'
import { Button, Checkbox, Input, Select, Tag } from '@nexus/ui/primitives'
import { Textarea } from '../../../../../../lib/i18n/ds-parts'
import { ReadField, SaveBar } from '../../../../library/parts'
import type { TemplateView } from '../../api'
import { archivedBySave, changeCount, editHeld, nameIn, newPointDraft, pointProblems, restoredDraft, saveHeld, type PointDraft, type Phrase } from '../../model'
import { useWords } from '../../parts'
import type { TemplateRecordActions, TemplateRecordModel } from './TemplateRecordView'

/**
 * Measurement template › Points (design template.points: "About 23 points for a race suit, in measuring order", PRD-200): the
 * ACTIVE points in order — Order, Code, Name with its Italian and English words, Unit, plausible min–max, Required, How to
 * measure — then the archived ones (kept, no longer measured). Edit points: an ordered list (add, ↑ ↓, remove = archived by
 * the API, put an archived one back), saved as ONE PUT of the whole list with the template's version (the DS EditModeBar:
 * ⌘S, Discard); held with the reason in words when the person may not change it. "Preview as the MeasurementForm" opens what
 * a fitter will see. Fetches nothing.
 */
export function PointsTab({ model, template, actions, onPreview }: { model: TemplateRecordModel; template: TemplateView; actions?: TemplateRecordActions; onPreview: () => void }) {
  const { t, say, locale } = useWords()
  const held = editHeld(template, model.can)
  const active = [...template.points].filter((point) => point.status === 'ACTIVE').sort((a, b) => a.seq - b.seq)
  const archived = template.points.filter((point) => point.status === 'ARCHIVED')
  const edit = model.edit

  const head = (
    <div className="fw-lib-head">
      <div className="fw-lib-head-text">
        <h2 className="fw-lib-title">{t('points.title')}</h2>
        <p className="fw-lib-hint">{t('points.intro', { count: active.length, required: active.filter((point) => point.required).length })}</p>
      </div>
      <div className="fw-lib-actions">
        <Button size="sm" variant="secondary" heldReason={active.length === 0 ? t('points.previewHeld') : null} onClick={onPreview}>
          <Eye size={14} aria-hidden /> {t('points.preview')}
        </Button>
        {!edit && (
          <Button size="sm" variant="primary" heldReason={say(held)} onClick={() => actions?.onEdit?.(true)}>
            <Pencil size={14} aria-hidden /> {t('points.edit')}
          </Button>
        )}
      </div>
    </div>
  )

  if (!edit)
    return (
      <Card padded>
        <div className="fw-lib-stack">
          {head}
          {held && <Banner tone="info" title={say(held)} />}
          {active.length === 0 ? (
            <p className="fw-lib-hint">{t('points.empty')}</p>
          ) : (
            <SummaryTable
              label={t('points.title')}
              columns={[t('points.col.order'), t('points.col.code'), t('points.col.name'), t('points.col.unit'), t('points.col.range'), t('points.col.required'), t('points.col.howTo')]}
              widths={['56px', '14%', '22%', '72px', '14%', '96px', undefined]}
              align={['right', 'left', 'left', 'left', 'left', 'left', 'left']}
              stackOnPhone
              rows={active.map((point, index) => ({
                id: point.id,
                cells: [
                  <span key="o" className="fw-mtt-order">{index + 1}</span>,
                  <span key="c" className="fw-lib-mono">{point.code}</span>,
                  <span key="n" className="fw-lib-cell">
                    <span>{nameIn(point, locale)}</span>
                    <span className="fw-lib-sub">{[point.nameI18n.it ? `IT ${point.nameI18n.it}` : null, point.nameI18n.en ? `EN ${point.nameI18n.en}` : null].filter(Boolean).join(' · ') || t('points.noWords')}</span>
                  </span>,
                  t(`unit.${point.uom === 'MM' ? 'MM' : 'CM'}`),
                  point.minValue === null && point.maxValue === null ? '—' : `${point.minValue ?? '…'}–${point.maxValue ?? '…'}`,
                  point.required ? <Tag key="r" tone="info">{t('points.requiredYes')}</Tag> : t('points.requiredNo'),
                  <span key="h" className="fw-lib-sub">{point.howTo ?? '—'}</span>,
                ],
              }))}
            />
          )}
          {archived.length > 0 && (
            <p className="fw-mtt-archived">
              {t('points.archived', { count: archived.length, codes: archived.map((point) => point.code).join(', ') })}
            </p>
          )}
        </div>
      </Card>
    )

  const drafts = edit.drafts
  const problems = pointProblems(drafts)
  const saveReason = saveHeld(template, drafts, edit.busy)
  const leaving = archivedBySave(template, drafts)
  const back = archived.filter((point) => !drafts.some((draft) => draft.code.trim() === point.code))
  const set = (key: string, patch: Partial<PointDraft>) => actions?.onDrafts?.(drafts.map((draft) => (draft.key === key ? { ...draft, ...patch } : draft)))
  const move = (index: number, by: -1 | 1) => {
    const next = [...drafts]
    const [taken] = next.splice(index, 1)
    next.splice(index + by, 0, taken!)
    actions?.onDrafts?.(next)
  }
  const problemOf = (draft: PointDraft, field: string): string | undefined => say((edit.refused[draft.key]?.[field] ?? problems[draft.key]?.[field]) as Phrase | undefined) ?? undefined

  return (
    <Card padded>
      <div className="fw-lib-stack">
        {head}
        <p className="fw-lib-hint">{t('points.editIntro')}</p>
        <ol className="fw-mtt-points" aria-label={t('points.title')}>
          {drafts.map((draft, index) => (
            <li key={draft.key} className="fw-mtt-point">
              <div className="fw-mtt-point-head">
                <span className="fw-lib-inline">
                  <span className="fw-mtt-order">{index + 1}</span>
                  <b>{draft.code || t('points.newPoint')}</b>
                  {draft.isNew && <Tag tone="info">{t('points.new')}</Tag>}
                </span>
                <span className="fw-lib-actions">
                  <Button size="sm" variant="quiet" aria-label={t('points.up', { code: draft.code || index + 1 })} heldReason={index === 0 ? t('points.first') : null} onClick={() => move(index, -1)}>
                    <ArrowUp size={14} aria-hidden />
                  </Button>
                  <Button size="sm" variant="quiet" aria-label={t('points.down', { code: draft.code || index + 1 })} heldReason={index === drafts.length - 1 ? t('points.last') : null} onClick={() => move(index, 1)}>
                    <ArrowDown size={14} aria-hidden />
                  </Button>
                  <Button size="sm" variant="quiet" aria-label={t('points.remove', { code: draft.code || index + 1 })} heldReason={drafts.length === 1 ? t('edit.held.none') : null} onClick={() => actions?.onDrafts?.(drafts.filter((entry) => entry.key !== draft.key))}>
                    <Trash2 size={14} aria-hidden /> {draft.isNew ? t('points.drop') : t('points.archive')}
                  </Button>
                </span>
              </div>
              <div className="fw-mtt-point-fields">
                {draft.isNew ? (
                  <Field label={t('points.col.code')} required hint={t('points.codeHint')} error={problemOf(draft, 'code')}>
                    <Input size="sm" value={draft.code} maxLength={60} onChange={(event) => set(draft.key, { code: event.target.value.replace(/\s+/g, '_') })} />
                  </Field>
                ) : (
                  <ReadField label={t('points.col.code')} value={<span className="fw-lib-mono">{draft.code}</span>} hint={t('points.codeKept')} />
                )}
                <Field label={t('points.name')} required error={problemOf(draft, 'name')}>
                  <Input size="sm" value={draft.name} maxLength={200} onChange={(event) => set(draft.key, { name: event.target.value })} />
                </Field>
                <Field label={t('points.nameIt')}>
                  <Input size="sm" value={draft.nameIt} maxLength={200} onChange={(event) => set(draft.key, { nameIt: event.target.value })} />
                </Field>
                <Field label={t('points.nameEn')}>
                  <Input size="sm" value={draft.nameEn} maxLength={200} onChange={(event) => set(draft.key, { nameEn: event.target.value })} />
                </Field>
                <Field label={t('points.col.unit')}>
                  <Select size="sm" value={draft.uom} onChange={(event) => set(draft.key, { uom: event.target.value === 'MM' ? 'MM' : 'CM' })}>
                    <option value="CM">{t('unit.CM')}</option>
                    <option value="MM">{t('unit.MM')}</option>
                  </Select>
                </Field>
                <Field label={t('points.min')} error={problemOf(draft, 'min')}>
                  <Input size="sm" inputMode="decimal" value={draft.min} onChange={(event) => set(draft.key, { min: event.target.value })} />
                </Field>
                <Field label={t('points.max')} error={problemOf(draft, 'max')}>
                  <Input size="sm" inputMode="decimal" value={draft.max} onChange={(event) => set(draft.key, { max: event.target.value })} />
                </Field>
                <Field label={t('points.col.required')}>
                  <Checkbox checked={draft.required} onChange={(event) => set(draft.key, { required: event.target.checked })} label={t('points.requiredLabel')} />
                </Field>
                <div className="fw-mtt-wide">
                  <Field label={t('points.col.howTo')} error={problemOf(draft, 'howTo')}>
                    <Textarea rows={2} maxLength={2000} value={draft.howTo} onChange={(event) => set(draft.key, { howTo: event.target.value })} />
                  </Field>
                </div>
              </div>
            </li>
          ))}
        </ol>
        <div className="fw-lib-actions">
          <Button size="sm" heldReason={drafts.length >= 60 ? t('edit.held.tooMany', { max: 60 }) : null} onClick={() => actions?.onDrafts?.([...drafts, newPointDraft()])}>
            <Plus size={14} aria-hidden /> {t('points.add')}
          </Button>
          {back.map((point) => (
            <Button key={point.id} size="sm" variant="quiet" onClick={() => actions?.onDrafts?.([...drafts, restoredDraft(point)])}>
              <RotateCcw size={14} aria-hidden /> {t('points.putBack', { code: point.code })}
            </Button>
          ))}
        </div>
        {leaving.length > 0 && <Banner tone="warning" title={t('points.leaving', { count: leaving.length, codes: leaving.join(', ') })} />}
        <SaveBar count={changeCount(template, drafts)} onDiscard={() => actions?.onEdit?.(false)} onSave={() => actions?.onSave?.()} held={say(saveReason)} busy={edit.busy} saveLabel={t('points.save')} />
      </div>
    </Card>
  )
}
