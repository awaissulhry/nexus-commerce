'use client'

import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Card, Field } from '@nexus/ui/components'
import { Button, Input, Select, Toggle } from '@nexus/ui/primitives'
import { TANNAGES } from '@nexus/factory-domain/product/materials/rules'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { editText } from '../../../styles/model'
import { refusedField } from '../../../library/model'
import { ReadField, SaveBar } from '../../../library/parts'
import type { MaterialView } from '../../api'
import { compositionSum, numberText, plain } from '../../model'
import type { MaterialRecordActions, MaterialRecordViewModel } from '../record-model'

interface Properties {
  animalSpecies: string
  tannage: string
  grade: string
  finish: string
  thicknessMinMm: string
  thicknessMaxMm: string
  animalOrigin: boolean
  composition: Array<{ fibre: string; percent: string }>
  attributes: Array<{ name: string; value: string }>
}

function propertiesOf(material: MaterialView, locale: 'it' | 'en'): Properties {
  return {
    animalSpecies: material.animalSpecies ?? '',
    tannage: material.tannage ?? '',
    grade: material.grade ?? '',
    finish: material.finish ?? '',
    thicknessMinMm: editText(material.thicknessMinMm, locale),
    thicknessMaxMm: editText(material.thicknessMaxMm, locale),
    animalOrigin: material.animalOrigin,
    composition: (material.composition ?? []).map((share) => ({ fibre: share.fibre, percent: editText(share.percent, locale) })),
    attributes: Object.entries(material.attributes ?? {}).map(([name, value]) => ({ name, value })),
  }
}

const textOrNull = (value: string): string | null => (value.trim() === '' ? null : value.trim())

function patchOf(base: Properties, draft: Properties): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  for (const field of ['animalSpecies', 'grade', 'finish'] as const) if (draft[field].trim() !== base[field]) patch[field] = textOrNull(draft[field])
  if (draft.tannage !== base.tannage) patch.tannage = draft.tannage || null
  for (const field of ['thicknessMinMm', 'thicknessMaxMm'] as const) if (plain(draft[field]) !== plain(base[field])) patch[field] = plain(draft[field]) || null
  if (draft.animalOrigin !== base.animalOrigin) patch.animalOrigin = draft.animalOrigin
  const composition = draft.composition.filter((row) => row.fibre.trim() !== '' || plain(row.percent) !== '').map((row) => ({ fibre: row.fibre.trim(), percent: plain(row.percent) }))
  const baseComposition = base.composition.map((row) => ({ fibre: row.fibre, percent: plain(row.percent) }))
  if (JSON.stringify(composition) !== JSON.stringify(baseComposition)) patch.composition = composition.length ? composition : null
  const attributes = Object.fromEntries(draft.attributes.filter((row) => row.name.trim() !== '').map((row) => [row.name.trim(), row.value.trim()]))
  if (JSON.stringify(attributes) !== JSON.stringify(Object.fromEntries(base.attributes.map((row) => [row.name, row.value])))) patch.attributes = Object.keys(attributes).length ? attributes : null
  return patch
}

/**
 * SCR-048 Properties & grades: only the fields of its kind (PRD-029) — leather: animal, tannage, selection or grade,
 * finish, thickness range; any material: the fibre composition (it must add up to 100 % before Save: held with the
 * gap), animal origin (the label phrase, Reg. 1007/2011 art. 12) and other attributes (name = value). Explicit save.
 */
export function PropertiesTab({ material, model, actions }: { material: MaterialView; model: MaterialRecordViewModel; actions?: MaterialRecordActions }) {
  const t = useT('library')
  const locale = useLocale()
  const base = propertiesOf(material, locale)
  const [draft, setDraft] = useState<Properties>(base)
  const patch = patchOf(base, draft)
  const count = Object.keys(patch).length
  const editable = model.can.materialsManage && material.status === 'ACTIVE'
  const set = (next: Partial<Properties>) => setDraft((current) => ({ ...current, ...next }))
  const sum = compositionSum(draft.composition)
  const leather = material.kind === 'LEATHER'
  const refused = (field: string) => (model.refused && refusedField(model.refused.paths, field) ? t('newMaterial.refused') : undefined)
  const held = sum !== null && sum !== 100 ? t('material.props.held.sum', { sum: numberText(sum, locale, 2) }) : null

  if (!editable)
    return (
      <div className="fw-lib-pair">
        <Card header={t('material.props.title')} description={t('material.readOnly')}>
          <div className="fw-lib-form-grid">
            {leather && (
              <>
                <ReadField label={t('material.animalSpecies')} value={material.animalSpecies} />
                <ReadField label={t('material.tannage')} value={material.tannage ? t(`tannage.${material.tannage}`) : null} />
                <ReadField label={t('material.grade')} value={material.grade} />
                <ReadField label={t('material.finish')} value={material.finish} />
                <ReadField label={t('material.thickness')} value={material.thicknessMinMm ? `${numberText(Number(material.thicknessMinMm), locale, 2)}–${numberText(Number(material.thicknessMaxMm ?? material.thicknessMinMm), locale, 2)} mm` : null} />
              </>
            )}
            <ReadField label={t('material.animalOrigin')} value={t(material.animalOrigin ? 'common.yes' : 'common.no')} />
          </div>
        </Card>
        <Card header={t('material.props.composition')}>
          {material.composition && material.composition.length > 0 ? (
            <ul className="fw-lib-list">
              {material.composition.map((share) => (
                <li key={share.fibre}>
                  {numberText(Number(share.percent), locale, 2)} % {share.fibre}
                </li>
              ))}
            </ul>
          ) : (
            <p className="fw-lib-hint">{t('material.props.noComposition')}</p>
          )}
        </Card>
      </div>
    )

  return (
    <div className="fw-lib-stack">
      <div className="fw-lib-pair">
        <Card header={t('material.props.title')} description={t(leather ? 'material.props.leatherHint' : 'material.props.otherHint')}>
          <div className="fw-lib-form-grid">
            {leather && (
              <>
                <Field label={t('material.animalSpecies')} required hint={t('material.animalSpeciesHint')} error={refused('animalSpecies')}>
                  <Input value={draft.animalSpecies} maxLength={60} onChange={(event) => set({ animalSpecies: event.target.value })} />
                </Field>
                <Field label={t('material.tannage')} required error={refused('tannage')}>
                  <Select value={draft.tannage} onChange={(event) => set({ tannage: event.target.value })}>
                    <option value="">{t('newMaterial.pick')}</option>
                    {TANNAGES.map((value) => (
                      <option key={value} value={value}>
                        {t(`tannage.${value}`)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={t('material.grade')} required hint={t('material.gradeHint')} error={refused('grade')}>
                  <Input value={draft.grade} maxLength={40} onChange={(event) => set({ grade: event.target.value })} />
                </Field>
                <Field label={t('material.finish')} error={refused('finish')}>
                  <Input value={draft.finish} maxLength={80} onChange={(event) => set({ finish: event.target.value })} />
                </Field>
                <Field label={t('material.thicknessMin')} required error={refused('thicknessMinMm')}>
                  <Input inputMode="decimal" value={draft.thicknessMinMm} onChange={(event) => set({ thicknessMinMm: event.target.value })} />
                </Field>
                <Field label={t('material.thicknessMax')} required error={refused('thicknessMaxMm')}>
                  <Input inputMode="decimal" value={draft.thicknessMaxMm} onChange={(event) => set({ thicknessMaxMm: event.target.value })} />
                </Field>
              </>
            )}
            <Field label={t('material.animalOrigin')} hint={t('material.animalOriginHint')} error={refused('animalOrigin')}>
              <span className="fw-lib-inline">
                <Toggle checked={draft.animalOrigin} onChange={(next) => set({ animalOrigin: next })} aria-label={t('material.animalOrigin')} />
                {t(draft.animalOrigin ? 'common.yes' : 'common.no')}
              </span>
            </Field>
          </div>
        </Card>
        <Card header={t('material.props.composition')} description={sum === null ? t('material.props.compositionHint') : t('material.props.sum', { sum: numberText(sum, locale, 2) })}>
          <div className="fw-lib-rows">
            {draft.composition.map((row, index) => (
              <div key={index} className="fw-lib-row">
                <Field label={t('material.props.fibre')} error={refused(`composition/${index}/fibre`)}>
                  <Input value={row.fibre} maxLength={60} onChange={(event) => set({ composition: draft.composition.map((entry, at) => (at === index ? { ...entry, fibre: event.target.value } : entry)) })} />
                </Field>
                <Field label={t('material.props.percent')} error={refused(`composition/${index}/percent`)}>
                  <Input inputMode="decimal" value={row.percent} onChange={(event) => set({ composition: draft.composition.map((entry, at) => (at === index ? { ...entry, percent: event.target.value } : entry)) })} />
                </Field>
                <Button size="sm" variant="quiet" aria-label={t('material.props.removeFibre', { n: index + 1 })} onClick={() => set({ composition: draft.composition.filter((_, at) => at !== index) })}>
                  <Trash2 size={14} aria-hidden />
                </Button>
              </div>
            ))}
            <Button size="sm" heldReason={draft.composition.length >= 10 ? t('material.props.held.fibres') : null} onClick={() => set({ composition: [...draft.composition, { fibre: '', percent: '' }] })}>
              <Plus size={13} aria-hidden /> {t('material.props.addFibre')}
            </Button>
          </div>
        </Card>
      </div>
      <Card header={t('material.props.attributes')} description={t('material.props.attributesHint')}>
        <div className="fw-lib-rows">
          {draft.attributes.map((row, index) => (
            <div key={index} className="fw-lib-row">
              <Field label={t('material.props.attrName')} error={refused(`attributes/${row.name}`)}>
                <Input value={row.name} maxLength={60} onChange={(event) => set({ attributes: draft.attributes.map((entry, at) => (at === index ? { ...entry, name: event.target.value } : entry)) })} />
              </Field>
              <Field label={t('material.props.attrValue')}>
                <Input value={row.value} maxLength={500} onChange={(event) => set({ attributes: draft.attributes.map((entry, at) => (at === index ? { ...entry, value: event.target.value } : entry)) })} />
              </Field>
              <Button size="sm" variant="quiet" aria-label={t('material.props.removeAttr', { n: index + 1 })} onClick={() => set({ attributes: draft.attributes.filter((_, at) => at !== index) })}>
                <Trash2 size={14} aria-hidden />
              </Button>
            </div>
          ))}
          <Button size="sm" onClick={() => set({ attributes: [...draft.attributes, { name: '', value: '' }] })}>
            <Plus size={13} aria-hidden /> {t('material.props.addAttr')}
          </Button>
        </div>
      </Card>
      {count > 0 && <SaveBar count={count} onDiscard={() => setDraft(base)} onSave={() => void actions?.onSave?.(patch)} held={held} busy={model.busy} saveLabel={t('material.save')} />}
    </div>
  )
}
