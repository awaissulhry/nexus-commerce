'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Card, Field, KeyValue } from '@nexus/ui/components'
import { Input, Select } from '@nexus/ui/primitives'
import { ITEM_SOURCINGS, ITEM_TRACKINGS } from '@nexus/factory-domain/product/materials/rules'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { editText, moneyText } from '../../../styles/model'
import { ReadField, SaveBar } from '../../../library/parts'
import { refusedField } from '../../../library/model'
import type { MaterialView } from '../../api'
import { converterOf, crViText, needsFactor, plain, UOMS, type Uom } from '../../model'
import type { MaterialRecordActions, MaterialRecordViewModel } from '../record-model'
import { ConverterLine } from '../../view/NewMaterialDialog'

interface Identity {
  code: string
  name: string
  nameIt: string
  nameEn: string
  sourcing: MaterialView['sourcing']
  tracking: MaterialView['tracking']
  baseUom: Uom
  purchaseUom: Uom
  purchaseFactor: string
  consumptionUom: Uom
  consumptionFactor: string
}

function identityOf(material: MaterialView, locale: 'it' | 'en'): Identity {
  return {
    code: material.code,
    name: material.name,
    nameIt: material.nameI18n?.it ?? '',
    nameEn: material.nameI18n?.en ?? '',
    sourcing: material.sourcing,
    tracking: material.tracking,
    baseUom: material.baseUom,
    purchaseUom: material.purchaseUom,
    purchaseFactor: material.units.purchase.fixed ? '' : editText(material.units.purchase.factor, locale),
    consumptionUom: material.consumptionUom,
    consumptionFactor: material.units.consumption.fixed ? '' : editText(material.units.consumption.factor, locale),
  }
}

/** The fields that changed, as the PATCH sends them (a factor only when it must be typed). */
function patchOf(base: Identity, draft: Identity): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  if (draft.code.trim().toUpperCase() !== base.code) patch.code = draft.code.trim().toUpperCase()
  if (draft.name.trim() !== base.name) patch.name = draft.name.trim()
  if (draft.nameIt.trim() !== base.nameIt || draft.nameEn.trim() !== base.nameEn) {
    const names = { ...(draft.nameIt.trim() ? { it: draft.nameIt.trim() } : {}), ...(draft.nameEn.trim() ? { en: draft.nameEn.trim() } : {}) }
    patch.nameI18n = Object.keys(names).length ? names : null
  }
  for (const field of ['sourcing', 'tracking', 'baseUom', 'purchaseUom', 'consumptionUom'] as const) if (draft[field] !== base[field]) patch[field] = draft[field]
  const unitsMoved = draft.baseUom !== base.baseUom || draft.purchaseUom !== base.purchaseUom || draft.consumptionUom !== base.consumptionUom
  if (unitsMoved || plain(draft.purchaseFactor) !== plain(base.purchaseFactor)) patch.purchaseFactor = needsFactor(draft.purchaseUom, draft.baseUom) ? plain(draft.purchaseFactor) || null : null
  if (unitsMoved || plain(draft.consumptionFactor) !== plain(base.consumptionFactor)) patch.consumptionFactor = needsFactor(draft.consumptionUom, draft.baseUom) ? plain(draft.consumptionFactor) || null : null
  return patch
}

/**
 * SCR-048 Overview: what the material is and how it is bought, stocked and used (PRD-028, PRD-024, PRD-025, PRD-030) —
 * explicit save with ⌘S, the live converter under the units — and beside it the facts people ask first, each line
 * pointing to its tab. A unit change of a material on a BOM line or in stock is refused by the API with its reason.
 */
export function OverviewTab({ material, model, actions }: { material: MaterialView; model: MaterialRecordViewModel; actions?: MaterialRecordActions }) {
  const t = useT('library')
  const locale = useLocale()
  const base = identityOf(material, locale)
  const [draft, setDraft] = useState<Identity>(base)
  const patch = patchOf(base, draft)
  const count = Object.keys(patch).length
  const editable = model.can.materialsManage && material.status === 'ACTIVE'
  const set = (next: Partial<Identity>) => setDraft((current) => ({ ...current, ...next }))
  const unit = (uom: Uom) => t(`uom.${uom}`)
  const refused = (field: string) => (model.refused && refusedField(model.refused.paths, field) ? t('newMaterial.refused') : undefined)
  const held = draft.code.trim() === '' ? t('newMaterial.held.code') : draft.name.trim() === '' ? t('newMaterial.held.name') : null
  const converter = converterOf({ baseUom: draft.baseUom, purchaseUom: draft.purchaseUom, purchaseFactor: plain(draft.purchaseFactor) || (needsFactor(draft.purchaseUom, draft.baseUom) ? null : material.units.purchase.factor), consumptionUom: draft.consumptionUom, consumptionFactor: plain(draft.consumptionFactor) || (needsFactor(draft.consumptionUom, draft.baseUom) ? null : material.units.consumption.factor) })
  const tabHref = (tab: string) => `${model.prefix}/products/materials/${material.id}?tab=${tab}`
  const crvi = crViText(material, locale)

  return (
    <div className="fw-lib-split">
      <Card header={t('material.identity')} description={editable ? t('material.identityHint') : t('material.readOnly')}>
        {editable ? (
          <div className="fw-lib-stack">
            <div className="fw-lib-form-grid">
              <Field label={t('material.code')} required hint={t('material.codeHint')} error={refused('code')}>
                <Input value={draft.code} maxLength={40} onChange={(event) => set({ code: event.target.value.toUpperCase() })} />
              </Field>
              <Field label={t('material.name')} required error={refused('name')}>
                <Input value={draft.name} maxLength={200} onChange={(event) => set({ name: event.target.value })} />
              </Field>
              <Field label={t('material.nameIt')} hint={t('material.nameLangHint')}>
                <Input value={draft.nameIt} maxLength={200} onChange={(event) => set({ nameIt: event.target.value })} />
              </Field>
              <Field label={t('material.nameEn')} hint={t('material.nameLangHint')}>
                <Input value={draft.nameEn} maxLength={200} onChange={(event) => set({ nameEn: event.target.value })} />
              </Field>
              <Field label={t('material.sourcing')} error={refused('sourcing')}>
                <Select value={draft.sourcing} onChange={(event) => set({ sourcing: event.target.value as Identity['sourcing'] })}>
                  {ITEM_SOURCINGS.map((value) => (
                    <option key={value} value={value}>
                      {t(`sourcing.${value}`)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('material.tracking')} hint={t(`trackingHint.${draft.tracking}`)} error={refused('tracking')}>
                <Select value={draft.tracking} onChange={(event) => set({ tracking: event.target.value as Identity['tracking'] })}>
                  {ITEM_TRACKINGS.map((value) => (
                    <option key={value} value={value}>
                      {t(`tracking.${value}`)}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <h3 className="fw-lib-h3">{t('material.units')}</h3>
            <div className="fw-lib-form-grid">
              <Field label={t('material.baseUom')} hint={t('material.baseUomLocked')} error={refused('baseUom')}>
                <Select value={draft.baseUom} onChange={(event) => set({ baseUom: event.target.value as Uom })}>
                  {UOMS.map((uom) => (
                    <option key={uom} value={uom}>
                      {unit(uom)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('material.purchaseUom')} error={refused('purchaseUom')}>
                <Select value={draft.purchaseUom} onChange={(event) => set({ purchaseUom: event.target.value as Uom })}>
                  {UOMS.map((uom) => (
                    <option key={uom} value={uom}>
                      {unit(uom)}
                    </option>
                  ))}
                </Select>
              </Field>
              {needsFactor(draft.purchaseUom, draft.baseUom) && (
                <Field label={t('material.factorOf', { unit: unit(draft.purchaseUom), base: unit(draft.baseUom) })} required error={refused('purchaseFactor')}>
                  <Input inputMode="decimal" value={draft.purchaseFactor} onChange={(event) => set({ purchaseFactor: event.target.value })} />
                </Field>
              )}
              <Field label={t('material.consumptionUom')} error={refused('consumptionUom')}>
                <Select value={draft.consumptionUom} onChange={(event) => set({ consumptionUom: event.target.value as Uom })}>
                  {UOMS.map((uom) => (
                    <option key={uom} value={uom}>
                      {unit(uom)}
                    </option>
                  ))}
                </Select>
              </Field>
              {needsFactor(draft.consumptionUom, draft.baseUom) && (
                <Field label={t('material.factorOf', { unit: unit(draft.consumptionUom), base: unit(draft.baseUom) })} required error={refused('consumptionFactor')}>
                  <Input inputMode="decimal" value={draft.consumptionFactor} onChange={(event) => set({ consumptionFactor: event.target.value })} />
                </Field>
              )}
            </div>
            <ConverterLine converter={converter} base={draft.baseUom} locale={locale} />
            {count > 0 && <SaveBar count={count} onDiscard={() => setDraft(base)} onSave={() => void actions?.onSave?.(patch)} held={held} busy={model.busy} saveLabel={t('material.save')} />}
          </div>
        ) : (
          <div className="fw-lib-stack">
            <div className="fw-lib-form-grid">
              <ReadField label={t('material.code')} value={material.code} />
              <ReadField label={t('material.name')} value={material.name} />
              <ReadField label={t('material.nameIt')} value={material.nameI18n?.it} />
              <ReadField label={t('material.nameEn')} value={material.nameI18n?.en} />
              <ReadField label={t('material.sourcing')} value={t(`sourcing.${material.sourcing}`)} />
              <ReadField label={t('material.tracking')} value={t(`tracking.${material.tracking}`)} />
              <ReadField label={t('material.baseUom')} value={unit(material.baseUom)} />
              <ReadField label={t('material.purchaseUom')} value={unit(material.purchaseUom)} />
              <ReadField label={t('material.consumptionUom')} value={unit(material.consumptionUom)} />
            </div>
            <ConverterLine converter={converterOf({ baseUom: material.baseUom, purchaseUom: material.purchaseUom, purchaseFactor: material.units.purchase.factor, consumptionUom: material.consumptionUom, consumptionFactor: material.units.consumption.factor })} base={material.baseUom} locale={locale} />
          </div>
        )}
      </Card>

      <Card header={t('material.side.title')}>
        <div className="fw-lib-stack">
          <KeyValue
            columns={1}
            labelCase="sentence"
            items={[
              ...(model.can.seesCost
                ? [
                    {
                      label: t('material.side.cost'),
                      value: (
                        <Link className="fw-lib-link" href={tabHref('suppliers')}>
                          {material.standardCost ? `${moneyText(material.standardCost, material.currency, locale)} / ${unit(material.baseUom)}` : t('materials.list.missingCost')}
                        </Link>
                      ),
                      hint: material.standardCostPerPurchaseUnit && material.purchaseUom !== material.baseUom ? `${moneyText(material.standardCostPerPurchaseUnit, material.currency, locale)} / ${unit(material.purchaseUom)}` : undefined,
                    },
                  ]
                : []),
              {
                label: t('material.side.supplier'),
                value: (
                  <Link className="fw-lib-link" href={tabHref('suppliers')}>
                    {material.defaultSupplier ? `${material.defaultSupplier.name} · ${material.defaultSupplier.code}` : material.sourcing === 'MAKE' ? t('materials.list.made') : t('materials.list.noSupplier')}
                  </Link>
                ),
                hint: material.supplierArticleCode ? t('materials.list.theirCode', { code: material.supplierArticleCode }) : undefined,
              },
              {
                label: t('material.side.colours'),
                value: (
                  <Link className="fw-lib-link" href={tabHref('colours')}>
                    {t('material.side.colourCount', { count: material.colours.filter((colour) => colour.status === 'ACTIVE').length })}
                  </Link>
                ),
              },
              {
                label: t('material.side.crvi'),
                value: (
                  <Link className="fw-lib-link" href={tabHref('compliance')}>
                    {crvi ? t('materials.list.crvi', { limit: crvi }) : t('material.side.noCrvi')}
                  </Link>
                ),
              },
              { label: t('material.side.ppe'), value: t(material.isPpeComponent ? 'common.yes' : 'common.no') },
              ...(model.can.stock
                ? [
                    {
                      label: t('material.side.stock'),
                      value: (
                        <Link className="fw-lib-link" href={tabHref('stock')}>
                          {t('material.side.stockLink')}
                        </Link>
                      ),
                    },
                  ]
                : []),
            ]}
          />
          {material.warnings.length > 0 && (
            <ul className="fw-lib-list">
              {material.warnings.map((warning) => (
                <li key={warning.code} className="fw-lib-warn">
                  {t(`material.warning.${warning.code}`)}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>
    </div>
  )
}
