'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Banner, Field, Modal } from '@nexus/ui/components'
import { Button, Input, RadioCard, Select, Toggle } from '@nexus/ui/primitives'
import { ITEM_SOURCINGS, ITEM_TRACKINGS, TANNAGES } from '@nexus/factory-domain/product/materials/rules'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import type { LibraryCan } from '../../library/model'
import { refusedField } from '../../library/model'
import type { MaterialsListActions, NewMaterialModel } from '../list-model'
import { converterOf, createHeld, draftFor, draftProblems, fieldOfPath, ITEM_KINDS, needsFactor, numberText, UOMS, type NewMaterialDraft, type Uom } from '../model'

/** The fields this dialog explains in its own words when the domain's rules refuse them. */
const KNOWN_FIELDS = new Set([
  'code',
  'name',
  'baseUom',
  'purchaseFactor',
  'consumptionFactor',
  'tracking',
  'sourcing',
  'defaultSupplierId',
  'supplierArticleCode',
  'animalSpecies',
  'tannage',
  'grade',
  'thicknessMinMm',
  'thicknessMaxMm',
  'animalOrigin',
  'crViLimitMgKg',
])

/**
 * New material (design materials.new): the kind first (it decides the fields and the default units), code and name, the
 * three units with the live converter ("1 hide = 52.5 ft² = 487.7 dm²"), make or buy and tracking, the default supplier
 * and their article code, the leather fields when it is leather, the Cr VI rule (at most 3 mg/kg), and the standard
 * purchase price for a person with the cost grain. The domain's own rules check the draft as it is typed (the same
 * check the API runs); Create is held with the first thing to fix. ⌘↵ creates.
 */
export function NewMaterialDialog({ model, can, actions }: { model: NewMaterialModel; can: LibraryCan; actions?: MaterialsListActions }) {
  const t = useT('library')
  const locale = useLocale()
  const draft = model.draft
  const set = (patch: Partial<NewMaterialDraft>) => actions?.onDraft?.({ ...draft, ...patch })
  const problems = useMemo(() => draftProblems(draft), [draft])
  const started = draft.code.trim() !== '' || draft.name.trim() !== ''
  const held = createHeld(draft, problems, model.busy)
  const create = () => {
    if (!held) actions?.onCreate?.()
  }
  const fieldError = (field: string): string | undefined => {
    if (refusedField(model.refused, field)) return t('newMaterial.refused')
    if (!started) return undefined
    return problems.some((issue) => fieldOfPath(issue.path) === field) ? t(KNOWN_FIELDS.has(field) ? `newMaterial.why.${field}` : 'newMaterial.why.other') : undefined
  }
  const leather = draft.kind === 'LEATHER'
  const converter = converterOf({ baseUom: draft.baseUom, purchaseUom: draft.purchaseUom, purchaseFactor: draft.purchaseFactor.replace(',', '.'), consumptionUom: draft.consumptionUom, consumptionFactor: draft.consumptionFactor.replace(',', '.') })
  const unit = (uom: Uom) => t(`uom.${uom}`)
  const others = started ? problems.filter((issue) => !KNOWN_FIELDS.has(fieldOfPath(issue.path))) : []

  // The supplier search runs 300 ms after the last key.
  const [search, setSearch] = useState(model.suppliers?.q ?? '')
  const typed = useRef(false)
  useEffect(() => {
    if (!typed.current) return
    const timer = setTimeout(() => actions?.onSupplierSearch?.(search), 300)
    return () => clearTimeout(timer)
  }, [search, actions])

  return (
    <Modal
      open
      onClose={() => actions?.onNew?.(false)}
      title={t('newMaterial.title')}
      size="lg"
      footer={
        <>
          <Button onClick={() => actions?.onNew?.(false)}>{t('common.back')}</Button>
          <Button variant="primary" heldReason={held ? t(held, { count: problems.length }) : null} onClick={create} aria-keyshortcuts="Meta+Enter Control+Enter">
            {t('newMaterial.create')}
          </Button>
        </>
      }
    >
      <div
        className="fw-lib-dialog"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault()
            create()
          }
        }}
      >
        <p className="fw-lib-hint">{t('newMaterial.intro')}</p>
        <fieldset className="fw-lib-stack">
          <legend className="fw-lib-h3">{t('newMaterial.kind')}</legend>
          <div className="fw-lib-kinds" role="radiogroup" aria-label={t('newMaterial.kind')}>
            {ITEM_KINDS.map((kind) => (
              <RadioCard
                key={kind}
                name="material-kind"
                value={kind}
                checked={draft.kind === kind}
                selected={draft.kind === kind}
                onChange={() => actions?.onDraft?.(draftFor(kind, draft.companyId, draft))}
                title={t(`kind.${kind}`)}
                description={t(`kindHint.${kind}`)}
              />
            ))}
          </div>
        </fieldset>

        <div className="fw-lib-form-grid">
          {model.companies.length > 1 && (
            <Field label={t('newMaterial.company')} hint={t('newMaterial.companyHint')}>
              <Select value={draft.companyId ?? ''} onChange={(event) => set({ companyId: event.target.value || null })}>
                <option value="">{t('newMaterial.everyCompany')}</option>
                {model.companies.map((company) => (
                  <option key={company.id} value={company.id}>
                    {company.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label={t('material.code')} required hint={t('material.codeHint')} error={fieldError('code')}>
            <Input value={draft.code} maxLength={40} autoFocus onChange={(event) => set({ code: event.target.value.toUpperCase() })} />
          </Field>
          <Field label={t('material.name')} required error={fieldError('name')}>
            <Input value={draft.name} maxLength={200} onChange={(event) => set({ name: event.target.value })} />
          </Field>
        </div>

        <h3 className="fw-lib-h3">{t('material.units')}</h3>
        <div className="fw-lib-form-grid">
          <Field label={t('material.baseUom')} hint={t('material.baseUomHint')} error={fieldError('baseUom')}>
            <Select value={draft.baseUom} onChange={(event) => set({ baseUom: event.target.value as Uom })}>
              {UOMS.map((uom) => (
                <option key={uom} value={uom}>
                  {unit(uom)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('material.purchaseUom')} hint={t('material.purchaseUomHint')}>
            <Select value={draft.purchaseUom} onChange={(event) => set({ purchaseUom: event.target.value as Uom })}>
              {UOMS.map((uom) => (
                <option key={uom} value={uom}>
                  {unit(uom)}
                </option>
              ))}
            </Select>
          </Field>
          {needsFactor(draft.purchaseUom, draft.baseUom) && (
            <Field label={t('material.factorOf', { unit: unit(draft.purchaseUom), base: unit(draft.baseUom) })} required error={fieldError('purchaseFactor')} hint={draft.purchaseUom === 'HIDE' || draft.purchaseUom === 'SIDE' ? t('material.factorHide') : undefined}>
              <Input inputMode="decimal" value={draft.purchaseFactor} onChange={(event) => set({ purchaseFactor: event.target.value })} />
            </Field>
          )}
          <Field label={t('material.consumptionUom')} hint={t('material.consumptionUomHint')}>
            <Select value={draft.consumptionUom} onChange={(event) => set({ consumptionUom: event.target.value as Uom })}>
              {UOMS.map((uom) => (
                <option key={uom} value={uom}>
                  {unit(uom)}
                </option>
              ))}
            </Select>
          </Field>
          {needsFactor(draft.consumptionUom, draft.baseUom) && (
            <Field label={t('material.factorOf', { unit: unit(draft.consumptionUom), base: unit(draft.baseUom) })} required error={fieldError('consumptionFactor')}>
              <Input inputMode="decimal" value={draft.consumptionFactor} onChange={(event) => set({ consumptionFactor: event.target.value })} />
            </Field>
          )}
        </div>
        <ConverterLine converter={converter} base={draft.baseUom} locale={locale} />

        <div className="fw-lib-form-grid">
          <Field label={t('material.sourcing')} error={fieldError('sourcing')}>
            <Select value={draft.sourcing} onChange={(event) => set({ sourcing: event.target.value as NewMaterialDraft['sourcing'], ...(event.target.value === 'MAKE' ? { supplier: null, supplierArticleCode: '' } : {}) })}>
              {ITEM_SOURCINGS.map((value) => (
                <option key={value} value={value}>
                  {t(`sourcing.${value}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('material.tracking')} hint={t(`trackingHint.${draft.tracking}`)} error={fieldError('tracking')}>
            <Select value={draft.tracking} onChange={(event) => set({ tracking: event.target.value as NewMaterialDraft['tracking'] })}>
              {ITEM_TRACKINGS.map((value) => (
                <option key={value} value={value}>
                  {t(`tracking.${value}`)}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        {draft.sourcing !== 'MAKE' && (
          <>
            <h3 className="fw-lib-h3">{t('material.supplier')}</h3>
            {can.parties ? (
              <div className="fw-lib-form-grid">
                <Field label={t('newMaterial.supplierSearch')} hint={draft.supplier ? t('newMaterial.supplierPicked', { name: draft.supplier.name }) : t('newMaterial.supplierHint')}>
                  <Input
                    type="search"
                    value={search}
                    onChange={(event) => {
                      typed.current = true
                      setSearch(event.target.value)
                    }}
                  />
                </Field>
                <Field label={t('material.defaultSupplier')} error={fieldError('defaultSupplierId')}>
                  <Select
                    value={draft.supplier?.id ?? ''}
                    onChange={(event) => {
                      const found = model.suppliers?.results?.find((row) => row.id === event.target.value)
                      set({ supplier: found ? { id: found.id, code: found.code, name: found.tradeName ?? found.legalName } : null })
                    }}
                  >
                    <option value="">{t('newMaterial.noSupplier')}</option>
                    {draft.supplier && !model.suppliers?.results?.some((row) => row.id === draft.supplier?.id) && <option value={draft.supplier.id}>{draft.supplier.name}</option>}
                    {(model.suppliers?.results ?? []).map((row) => (
                      <option key={row.id} value={row.id} disabled={row.status === 'BLOCKED'}>
                        {`${row.tradeName ?? row.legalName} · ${row.code}${row.status === 'BLOCKED' ? ` (${t('newMaterial.blocked')})` : ''}`}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={t('material.supplierArticleCode')} error={fieldError('supplierArticleCode')}>
                  <Input value={draft.supplierArticleCode} maxLength={64} onChange={(event) => set({ supplierArticleCode: event.target.value })} />
                </Field>
              </div>
            ) : (
              <p className="fw-lib-hint">{t('newMaterial.noParties')}</p>
            )}
          </>
        )}

        {leather && (
          <>
            <h3 className="fw-lib-h3">{t('material.leather')}</h3>
            <div className="fw-lib-form-grid">
              <Field label={t('material.animalSpecies')} required hint={t('material.animalSpeciesHint')} error={fieldError('animalSpecies')}>
                <Input value={draft.animalSpecies} maxLength={60} onChange={(event) => set({ animalSpecies: event.target.value })} />
              </Field>
              <Field label={t('material.tannage')} required error={fieldError('tannage')}>
                <Select value={draft.tannage} onChange={(event) => set({ tannage: event.target.value as NewMaterialDraft['tannage'] })}>
                  <option value="">{t('newMaterial.pick')}</option>
                  {TANNAGES.map((value) => (
                    <option key={value} value={value}>
                      {t(`tannage.${value}`)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('material.grade')} required hint={t('material.gradeHint')} error={fieldError('grade')}>
                <Input value={draft.grade} maxLength={40} onChange={(event) => set({ grade: event.target.value })} />
              </Field>
              <Field label={t('material.thicknessMin')} required error={fieldError('thicknessMinMm')}>
                <Input inputMode="decimal" value={draft.thicknessMinMm} onChange={(event) => set({ thicknessMinMm: event.target.value })} />
              </Field>
              <Field label={t('material.thicknessMax')} required error={fieldError('thicknessMaxMm')}>
                <Input inputMode="decimal" value={draft.thicknessMaxMm} onChange={(event) => set({ thicknessMaxMm: event.target.value })} />
              </Field>
            </div>
          </>
        )}

        <h3 className="fw-lib-h3">{t('material.crvi')}</h3>
        <div className="fw-lib-form-grid">
          <Field label={t('material.requiresCrVi')} hint={t('material.requiresCrViHint')}>
            <span className="fw-lib-inline">
              <Toggle checked={draft.requiresCrViTest} onChange={(next) => set({ requiresCrViTest: next, crViLimitMgKg: next ? draft.crViLimitMgKg || '3' : '' })} aria-label={t('material.requiresCrVi')} />
              {t(draft.requiresCrViTest ? 'common.yes' : 'common.no')}
            </span>
          </Field>
          {draft.requiresCrViTest && (
            <Field label={t('material.crViLimit')} hint={t('material.crViLimitHint')} error={fieldError('crViLimitMgKg')}>
              <Input inputMode="decimal" value={draft.crViLimitMgKg} onChange={(event) => set({ crViLimitMgKg: event.target.value })} />
            </Field>
          )}
        </div>

        {can.materialsCost && (
          <>
            <h3 className="fw-lib-h3">{t('material.standardCost')}</h3>
            <div className="fw-lib-form-grid">
              <Field label={t('material.costPer', { unit: unit(draft.baseUom) })} hint={t('material.standardCostHint')}>
                <Input inputMode="decimal" value={draft.standardCost} onChange={(event) => set({ standardCost: event.target.value })} />
              </Field>
            </div>
          </>
        )}

        {others.length > 0 && (
          <Banner tone="warning" title={t('newMaterial.otherProblems', { count: others.length })}>
            <ul className="fw-lib-list">
              {others.map((issue) => (
                <li key={issue.path}>{issue.message}</li>
              ))}
            </ul>
          </Banner>
        )}
        {model.problem && (
          <Banner tone="danger" title={t(model.problem)}>
            {model.messages.length > 0 && (
              <ul className="fw-lib-list">
                {model.messages.map((message) => (
                  <li key={message}>{message}</li>
                ))}
              </ul>
            )}
          </Banner>
        )}
        <p className="fw-lib-hint">{t('newMaterial.after')}</p>
      </div>
    </Modal>
  )
}

/** "1 hide = 52.5 ft² = 487.74 dm²" — the units of a material in one sentence (fixed factors inside a dimension). */
export function ConverterLine({ converter, base, locale }: { converter: ReturnType<typeof converterOf>; base: Uom; locale: 'it' | 'en' }) {
  const t = useT('library')
  const unit = (uom: Uom) => t(`uom.${uom}`)
  if (!converter.purchase && !converter.consumption) return <p className="fw-lib-converter">{t('converter.one', { unit: unit(base) })}</p>
  const parts: string[] = []
  if (converter.purchase) {
    parts.push(`1 ${unit(converter.purchase.uom)} = ${numberText(converter.purchase.inBase, locale)} ${unit(base)}`)
    if (converter.consumption?.perPurchase) parts.push(`${numberText(converter.consumption.perPurchase, locale, 2)} ${unit(converter.consumption.uom)}`)
  } else if (converter.consumption) {
    parts.push(`1 ${unit(converter.consumption.uom)} = ${numberText(converter.consumption.inBase, locale)} ${unit(base)}`)
  }
  return (
    <p className="fw-lib-converter" aria-live="polite">
      <b>{t('converter.label')}</b> {parts.join(' = ')}
    </p>
  )
}
