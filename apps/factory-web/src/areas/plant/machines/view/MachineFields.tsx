'use client'

import { useEffect, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import { Field } from '@nexus/ui/components'
import { Input, Select, Spinner } from '@nexus/ui/primitives'
import { Textarea } from '../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../lib/i18n/provider'
import type { MachineClass, PlantSite, SupplierChoice } from '../../_shared/api'
import { costMinorOf, labelOf, yearOf, type PlantCan } from '../../_shared/model'
import { useWords } from '../../_shared/parts'
import type { MachineDraft } from '../view-model'

/**
 * A machine's facts as a form (design plant.machines/pop:new-machine and the record's Overview "Machine" card): the site
 * (a new machine only), the asset number printed on its QR tag (a new machine only: it never changes), the type, make,
 * model, serial and year, the station and work centre of its site, the supplier (with parties.view) and the purchase cost
 * (with the cost grain only). The field a refused save names carries the API's reason in our words.
 */
export function MachineFields({ draft, creating, sites, classes, suppliers, field, can, onDraft, onFindSupplier }: { draft: MachineDraft; creating: boolean; sites: readonly PlantSite[]; classes: readonly MachineClass[]; suppliers: SupplierChoice[] | null; field: string | null; can: PlantCan; onDraft?: (patch: Partial<MachineDraft>) => void; onFindSupplier?: (text: string) => void }) {
  const t = useWords()
  const locale = useLocale()
  const site = sites.find((entry) => entry.id === draft.siteId) ?? null
  const [query, setQuery] = useState(draft.supplier ? `${draft.supplier.code} · ${draft.supplier.legalName}` : '')
  const typed = useRef(false)
  const latest = useRef(onFindSupplier)
  latest.current = onFindSupplier
  useEffect(() => {
    if (!typed.current) return
    const timer = setTimeout(() => latest.current?.(query), 300)
    return () => clearTimeout(timer)
  }, [query])
  const costProblem = draft.cost.trim() !== '' && costMinorOf(draft.cost) === undefined
  const yearProblem = draft.year.trim() !== '' && yearOf(draft.year) === undefined
  const fieldError = (name: string) => (field === name ? t(`problem.field.${name}`) : undefined)
  return (
    <div className="fw-pl-form">
      {creating && (
        <Field label={t('machine.site')} required>
          <Select value={draft.siteId ?? ''} onChange={(event) => onDraft?.({ siteId: event.target.value || null, stationId: null, workCentreId: null })}>
            {sites.length !== 1 && <option value="">{t('machine.pickSite')}</option>}
            {sites.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {`${entry.code} · ${entry.name}`}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {creating && (
        <Field label={t('machine.assetNumber')} required hint={t('machine.assetNumberHint')} error={fieldError('assetNumber')}>
          <Input value={draft.assetNumber} maxLength={40} autoFocus onChange={(event) => onDraft?.({ assetNumber: event.target.value.toUpperCase() })} />
        </Field>
      )}
      <Field label={t('machine.type')} required>
        <Select value={draft.classId ?? ''} onChange={(event) => onDraft?.({ classId: event.target.value || null })}>
          <option value="">{classes.length === 0 ? t('machine.noTypes') : t('machine.pickType')}</option>
          {classes.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {labelOf(entry, locale)}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t('machine.make')}>
        <Input value={draft.make} maxLength={120} onChange={(event) => onDraft?.({ make: event.target.value })} />
      </Field>
      <Field label={t('machine.model')}>
        <Input value={draft.modelName} maxLength={120} onChange={(event) => onDraft?.({ modelName: event.target.value })} />
      </Field>
      <Field label={t('machine.serial')}>
        <Input value={draft.serialNumber} maxLength={120} onChange={(event) => onDraft?.({ serialNumber: event.target.value })} />
      </Field>
      <Field label={t('machine.year')} error={yearProblem ? t('machine.yearProblem') : fieldError('year')}>
        <Input value={draft.year} inputMode="numeric" maxLength={4} onChange={(event) => onDraft?.({ year: event.target.value })} />
      </Field>
      <Field label={t('machine.station')} hint={site ? t('machine.stationHint') : t('machine.siteFirst')} error={fieldError('stationId')}>
        <Select
          value={draft.stationId ?? ''}
          disabled={!site}
          onChange={(event) => {
            const station = site?.stations.find((entry) => entry.id === event.target.value) ?? null
            onDraft?.({ stationId: station?.id ?? null, ...(station && !draft.workCentreId ? { workCentreId: station.workCentreId } : {}) })
          }}
        >
          <option value="">{t('machine.noStation')}</option>
          {(site?.stations ?? []).map((entry) => (
            <option key={entry.id} value={entry.id}>
              {`${entry.code} · ${entry.name}`}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t('machine.workCentre')} error={fieldError('workCentreId')}>
        <Select value={draft.workCentreId ?? ''} disabled={!site} onChange={(event) => onDraft?.({ workCentreId: event.target.value || null })}>
          <option value="">{t('machine.noWorkCentre')}</option>
          {(site?.workCentres ?? []).map((entry) => (
            <option key={entry.id} value={entry.id}>
              {`${entry.code} · ${entry.name}`}
            </option>
          ))}
        </Select>
      </Field>
      {can.parties && (
        <Field label={t('machine.supplier')} hint={t('machine.supplierHint')} error={fieldError('supplierId')}>
          <Input
            type="search"
            leadingIcon={suppliers === null && query.trim().length > 1 ? <Spinner size={12} /> : <Search size={13} aria-hidden />}
            value={query}
            placeholder={t('machine.supplierSearch')}
            onChange={(event) => {
              typed.current = true
              setQuery(event.target.value)
              if (event.target.value.trim() === '') onDraft?.({ supplier: null })
            }}
          />
        </Field>
      )}
      {can.parties && (
        <Field label={t('machine.supplierPick')}>
          <Select value={draft.supplier?.id ?? ''} disabled={!suppliers || suppliers.length === 0} onChange={(event) => onDraft?.({ supplier: suppliers?.find((entry) => entry.id === event.target.value) ?? null })}>
            <option value="">{suppliers === null ? t('machine.supplierFirst') : suppliers.length === 0 ? t('report.noneFound') : t('machine.noSupplier')}</option>
            {draft.supplier && !suppliers?.some((entry) => entry.id === draft.supplier?.id) && <option value={draft.supplier.id}>{`${draft.supplier.code} · ${draft.supplier.legalName}`}</option>}
            {(suppliers ?? []).map((entry) => (
              <option key={entry.id} value={entry.id}>
                {`${entry.code} · ${entry.legalName}`}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {can.cost && (
        <Field label={t('machine.cost')} hint={t('machine.costHint')} error={costProblem ? t('machine.costProblem') : undefined}>
          <Input value={draft.cost} inputMode="decimal" prefix="€" onChange={(event) => onDraft?.({ cost: event.target.value })} />
        </Field>
      )}
      <Field label={t('machine.note')} className="wide">
        <Textarea value={draft.note} rows={2} maxLength={500} onChange={(event) => onDraft?.({ note: event.target.value })} />
      </Field>
    </div>
  )
}

/** Why the machine's form may not be saved yet (a message key), or null. */
export function machineDraftHeld(draft: MachineDraft, creating: boolean, can: PlantCan): string | null {
  if (!can.manageMachines) return 'held.noManageMachines'
  if (creating && !draft.siteId) return 'held.siteNeeded'
  if (creating && !/^[A-Z0-9][A-Z0-9._/-]{0,39}$/.test(draft.assetNumber.trim().toUpperCase())) return 'held.assetNumberNeeded'
  if (!draft.classId) return 'held.typeNeeded'
  if (draft.year.trim() !== '' && yearOf(draft.year) === undefined) return 'held.yearBad'
  if (can.cost && draft.cost.trim() !== '' && costMinorOf(draft.cost) === undefined) return 'held.costBad'
  return null
}
