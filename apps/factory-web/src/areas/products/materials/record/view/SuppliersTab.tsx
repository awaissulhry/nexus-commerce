'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Card, Field, KeyValue } from '@nexus/ui/components'
import { Input, Select } from '@nexus/ui/primitives'
import { Textarea } from '../../../../../lib/i18n/ds-parts'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { editText, moneyText } from '../../../styles/model'
import { ReadField, SaveBar } from '../../../library/parts'
import type { MaterialView } from '../../api'
import { costInput } from '../../model'
import { SupplierPricesSection } from '../../../../purchasing/suppliers/sources/view/SupplierPricesSection'
import type { MaterialRecordActions, MaterialRecordViewModel } from '../record-model'

/**
 * SCR-048 Suppliers & prices: the standard purchase price per base unit (GAP-006: what quotes and cost sheets use until
 * supplier price lists exist) — shown and set only with the cost grain, set with product.materials.cost, with a reason
 * kept in the audit row — and the default supplier with their article code (product.materials.manage). A material we
 * only make has no supplier. Below them (B-W2a-69) the Supplier prices: Purchasing's approved sources of the material,
 * read only (kept on the supplier's Items & prices tab).
 */
export function SuppliersTab({ material, model, actions }: { material: MaterialView; model: MaterialRecordViewModel; actions?: MaterialRecordActions }) {
  return (
    <div className="fw-lib-stack">
      <div className="fw-lib-pair">
        {model.can.seesCost ? <CostCard material={material} model={model} actions={actions} /> : <NoCostCard />}
        <SupplierCard material={material} model={model} actions={actions} />
      </div>
      {model.supplierPrices && material.sourcing !== 'MAKE' && <SupplierPricesSection model={model.supplierPrices} onRetry={actions?.onRetrySupplierPrices} />}
    </div>
  )
}

function NoCostCard() {
  const t = useT('library')
  return (
    <Card header={t('material.cost.title')}>
      <p className="fw-lib-hint">{t('material.cost.notInRole')}</p>
    </Card>
  )
}

function CostCard({ material, model, actions }: { material: MaterialView; model: MaterialRecordViewModel; actions?: MaterialRecordActions }) {
  const t = useT('library')
  const locale = useLocale()
  const [text, setText] = useState(editText(material.standardCost, locale))
  const [reason, setReason] = useState('')
  const next = costInput(text)
  const changed = next !== undefined && next !== (material.standardCost ?? null)
  const editable = model.can.materialsCost && material.status === 'ACTIVE'
  const unit = (uom: string) => t(`uom.${uom}`)
  const held = next === undefined ? t('materials.cost.badNumber') : null
  return (
    <Card header={t('material.cost.title')} description={t('material.cost.intro')}>
      <div className="fw-lib-stack">
        <KeyValue
          columns={1}
          labelCase="sentence"
          items={[
            { label: t('material.cost.perBase', { unit: unit(material.baseUom) }), value: material.standardCost ? moneyText(material.standardCost, material.currency, locale) : t('materials.list.missingCost') },
            ...(material.purchaseUom !== material.baseUom ? [{ label: t('material.cost.perUnit', { unit: unit(material.purchaseUom) }), value: material.standardCostPerPurchaseUnit ? moneyText(material.standardCostPerPurchaseUnit, material.currency, locale) : '—' }] : []),
            ...(material.consumptionUom !== material.baseUom ? [{ label: t('material.cost.perUnit', { unit: unit(material.consumptionUom) }), value: material.standardCostPerConsumptionUnit ? moneyText(material.standardCostPerConsumptionUnit, material.currency, locale) : '—' }] : []),
          ]}
        />
        {editable ? (
          <>
            <div className="fw-lib-form-grid">
              <Field label={t('material.costPer', { unit: unit(material.baseUom) })} hint={t('material.cost.clearHint', { currency: material.currency })} error={next === undefined ? t('materials.cost.badNumber') : undefined}>
                <Input inputMode="decimal" value={text} onChange={(event) => setText(event.target.value)} />
              </Field>
              <Field label={t('materials.cost.reason')} hint={t('materials.cost.reasonHint')}>
                <Textarea value={reason} rows={2} maxLength={500} onChange={(event) => setReason(event.target.value)} />
              </Field>
            </div>
            {changed && (
              <SaveBar
                count={1}
                onDiscard={() => {
                  setText(editText(material.standardCost, locale))
                  setReason('')
                }}
                onSave={() => void actions?.onSetCost?.(next ?? null, reason.trim())}
                held={held}
                busy={model.busy}
                saveLabel={t('material.cost.apply')}
              />
            )}
          </>
        ) : (
          <p className="fw-lib-hint">{material.status !== 'ACTIVE' ? t('material.held.archived') : t('material.cost.viewOnly')}</p>
        )}
      </div>
    </Card>
  )
}

function SupplierCard({ material, model, actions }: { material: MaterialView; model: MaterialRecordViewModel; actions?: MaterialRecordActions }) {
  const t = useT('library')
  const [supplier, setSupplier] = useState(material.defaultSupplier)
  const [code, setCode] = useState(material.supplierArticleCode ?? '')
  const [search, setSearch] = useState('')
  const typed = useRef(false)
  useEffect(() => {
    if (!typed.current) return
    const timer = setTimeout(() => actions?.onSupplierSearch?.(search), 300)
    return () => clearTimeout(timer)
  }, [search, actions])
  const editable = model.can.materialsManage && material.status === 'ACTIVE' && material.sourcing !== 'MAKE'
  const patch: Record<string, unknown> = {}
  if ((supplier?.id ?? null) !== (material.defaultSupplier?.id ?? null)) patch.defaultSupplierId = supplier?.id ?? null
  if ((code.trim() || null) !== material.supplierArticleCode) patch.supplierArticleCode = code.trim() || null
  const count = Object.keys(patch).length

  if (material.sourcing === 'MAKE')
    return (
      <Card header={t('material.supplier')}>
        <p className="fw-lib-hint">{t('material.supplierMade')}</p>
      </Card>
    )
  return (
    <Card header={t('material.supplier')} description={t('material.supplierIntro')}>
      {editable && model.can.parties ? (
        <div className="fw-lib-stack">
          <div className="fw-lib-form-grid">
            <Field label={t('newMaterial.supplierSearch')} hint={t('newMaterial.supplierHint')}>
              <Input
                type="search"
                value={search}
                onChange={(event) => {
                  typed.current = true
                  setSearch(event.target.value)
                }}
              />
            </Field>
            <Field label={t('material.defaultSupplier')}>
              <Select
                value={supplier?.id ?? ''}
                onChange={(event) => {
                  const found = model.suppliers?.results?.find((row) => row.id === event.target.value)
                  setSupplier(found ? { id: found.id, code: found.code, name: found.tradeName ?? found.legalName } : event.target.value === material.defaultSupplier?.id ? material.defaultSupplier : null)
                }}
              >
                <option value="">{t('newMaterial.noSupplier')}</option>
                {supplier && !model.suppliers?.results?.some((row) => row.id === supplier.id) && <option value={supplier.id}>{`${supplier.name} · ${supplier.code}`}</option>}
                {(model.suppliers?.results ?? []).map((row) => (
                  <option key={row.id} value={row.id} disabled={row.status === 'BLOCKED'}>
                    {`${row.tradeName ?? row.legalName} · ${row.code}${row.status === 'BLOCKED' ? ` (${t('newMaterial.blocked')})` : ''}`}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('material.supplierArticleCode')}>
              <Input value={code} maxLength={64} onChange={(event) => setCode(event.target.value)} />
            </Field>
          </div>
          {supplier && (
            <Link className="fw-lib-link" href={`${model.prefix}/purchasing/suppliers/${supplier.id}`}>
              {t('material.openSupplier', { name: supplier.name })}
            </Link>
          )}
          {count > 0 && (
            <SaveBar
              count={count}
              onDiscard={() => {
                setSupplier(material.defaultSupplier)
                setCode(material.supplierArticleCode ?? '')
              }}
              onSave={() => void actions?.onSave?.(patch)}
              held={null}
              busy={model.busy}
              saveLabel={t('material.save')}
            />
          )}
        </div>
      ) : (
        <div className="fw-lib-form-grid">
          <ReadField
            label={t('material.defaultSupplier')}
            value={
              material.defaultSupplier ? (
                <Link className="fw-lib-link" href={`${model.prefix}/purchasing/suppliers/${material.defaultSupplier.id}`}>
                  {`${material.defaultSupplier.name} · ${material.defaultSupplier.code}`}
                </Link>
              ) : (
                t('materials.list.noSupplier')
              )
            }
          />
          <ReadField label={t('material.supplierArticleCode')} value={material.supplierArticleCode} />
        </div>
      )}
    </Card>
  )
}
