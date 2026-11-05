'use client'

import { Banner, Field } from '@nexus/ui/components'
import { Button, Checkbox, Input, Radio, Select } from '@nexus/ui/primitives'
import { GHS_PICTOGRAMS, SIGNAL_WORDS, type ChemicalUse, type GhsPictogram, type QuantityUnit, type SignalWord } from '@nexus/factory-domain/safety/chemicals/rules'
import { DateField, FileDropzone, FileRow, Modal, Textarea } from '../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../lib/i18n/provider'
import type { Choices } from '../api'
import { atField, badStatement, CHEMICAL_USES, draftProblems, QUANTITY_UNITS, SHEET_LANGUAGES, sheetHeld, type ChemicalDraft, type Problem, type SheetDraft } from '../model'
import type { AddState, ChemicalsPageActions, ChemicalsPageModel, Read } from '../view-model'
import { GhsMark, useWords } from './parts'

/** The PDF a sheet takes (the API refuses anything else; 25 MB as every document). */
const PDF_ACCEPT = '.pdf,application/pdf'
const MAX_BYTES = 25 * 1024 * 1024

/**
 * The fields Add chemical and the chemical's Edit share (design pop:add "Product · supplier · use · SDS upload · H / P
 * statements · location · max quantity · roles"; the window adds PPE): the product, its supplier (a party of the company or
 * by name), use, GHS pictograms, signal word, H and P statements as CLP writes them, where it is kept and its cabinet, the
 * most kept with its unit, the role sheets of its site that use it and the PPE to handle it, a note. Each field says what is
 * wrong with it, in our words (factory-domain's rules: the API says the same).
 */
export function ChemicalFields({ draft, choices, problem, onDraft, sites }: { draft: ChemicalDraft; choices: Read<Choices> | null; problem: Problem | null; onDraft: (draft: ChemicalDraft) => void; sites?: readonly { id: string; name: string }[] | null }) {
  const t = useWords()
  const problems = draftProblems(draft, !!sites)
  const fieldError = (field: string, shown: boolean): string | undefined => {
    const api = atField(problem, field)
    if (api) return t(api)
    const own = problems.find((entry) => entry.field === field)
    return own && shown ? t(own.key) : undefined
  }
  const options = choices?.status === 'ready' ? choices.value : null
  const badHazard = badStatement(draft.hazards, 'hazard')
  const badPrecaution = badStatement(draft.precautions, 'precaution')
  const toggle = (list: readonly string[], id: string): string[] => (list.includes(id) ? list.filter((entry) => entry !== id) : [...list, id])

  return (
    <div className="fw-ch-form">
      {sites && (
        <Field label={t('field.site')} required error={fieldError('siteId', draft.name !== '')}>
          <Select value={draft.siteId ?? ''} onChange={(event) => onDraft({ ...draft, siteId: event.target.value || null })}>
            <option value="">{t('field.sitePick')}</option>
            {sites.map((site) => (
              <option key={site.id} value={site.id}>
                {site.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <div className="fw-ch-form-row">
        <Field label={t('field.name')} required error={fieldError('name', draft.name !== '')}>
          <Input value={draft.name} maxLength={200} placeholder={t('field.namePlaceholder')} onChange={(event) => onDraft({ ...draft, name: event.target.value })} />
        </Field>
        <Field label={t('field.use')} required error={fieldError('use', false)}>
          <Select value={draft.use} onChange={(event) => onDraft({ ...draft, use: event.target.value as ChemicalUse | '' })}>
            <option value="">{t('field.usePick')}</option>
            {CHEMICAL_USES.map((use) => (
              <option key={use} value={use}>
                {t(`use.${use}`)}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <fieldset className="fw-ch-fieldset">
        <legend className="fw-ch-h3">{t('field.supplier')}</legend>
        <span className="fw-ch-row">
          <Radio name="fw-ch-supplier" checked={draft.supplierMode === 'party'} label={t('field.supplierParty')} onChange={() => onDraft({ ...draft, supplierMode: 'party' })} />
          <Radio name="fw-ch-supplier" checked={draft.supplierMode === 'name'} label={t('field.supplierByName')} onChange={() => onDraft({ ...draft, supplierMode: 'name', supplierPartyId: null })} />
        </span>
        {draft.supplierMode === 'party' ? (
          <Field label={t('field.supplierParty')} error={fieldError('supplierPartyId', false)} hint={choices?.status === 'error' ? t(choices.problem) : undefined}>
            <Select value={draft.supplierPartyId ?? ''} disabled={!options} onChange={(event) => onDraft({ ...draft, supplierPartyId: event.target.value || null })}>
              <option value="">{options ? t('field.supplierPick') : t('common.reading')}</option>
              {(options?.suppliers ?? []).map((party) => (
                <option key={party.id} value={party.id}>
                  {party.name}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <Field label={t('field.supplierName')} hint={t('field.supplierNameHint')} error={fieldError('supplierName', true)}>
            <Input value={draft.supplierName} maxLength={200} onChange={(event) => onDraft({ ...draft, supplierName: event.target.value })} />
          </Field>
        )}
      </fieldset>
      <fieldset className="fw-ch-fieldset">
        <legend className="fw-ch-h3">{t('field.hazards')}</legend>
        <span className="fw-ch-muted">{t('field.pictograms')}</span>
        <div className="fw-ch-picks" role="group" aria-label={t('field.pictograms')}>
          {GHS_PICTOGRAMS.map((code) => (
            <label key={code} className="fw-ch-pick">
              <Checkbox checked={draft.ghsPictograms.includes(code)} onChange={() => onDraft({ ...draft, ghsPictograms: toggle(draft.ghsPictograms, code) })} aria-label={`${code} · ${t(`ghs.${code}`)}`} />
              <GhsMark code={code as GhsPictogram} say={t} decorative />
              <span>{t(`ghs.${code}`)}</span>
            </label>
          ))}
        </div>
        <div className="fw-ch-form-row">
          <Field label={t('field.signalWord')} error={fieldError('signalWord', true)}>
            <Select value={draft.signalWord} onChange={(event) => onDraft({ ...draft, signalWord: event.target.value as SignalWord | '' })}>
              <option value="">{t('field.signalNone')}</option>
              {SIGNAL_WORDS.map((word) => (
                <option key={word} value={word}>
                  {t(`signal.${word}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('field.hazardStatements')} hint={t('field.hazardHint')} error={badHazard ? t('field.badHazard', { code: badHazard }) : fieldError('hazardStatements', true)}>
            <Input value={draft.hazards} placeholder="H225 H319 EUH066" onChange={(event) => onDraft({ ...draft, hazards: event.target.value })} />
          </Field>
          <Field label={t('field.precautionStatements')} hint={t('field.precautionHint')} error={badPrecaution ? t('field.badPrecaution', { code: badPrecaution }) : fieldError('precautionStatements', true)}>
            <Input value={draft.precautions} placeholder="P210 P305+P351+P338" onChange={(event) => onDraft({ ...draft, precautions: event.target.value })} />
          </Field>
        </div>
      </fieldset>
      <div className="fw-ch-form-row">
        <Field label={t('field.place')} required hint={t('field.placeHint')} error={fieldError('storagePlace', draft.name !== '')}>
          <Input value={draft.storagePlace} maxLength={200} list="fw-ch-places" onChange={(event) => onDraft({ ...draft, storagePlace: event.target.value })} />
        </Field>
        <Field label={t('field.cabinet')} hint={t('field.cabinetHint')} error={fieldError('cabinetCode', true)}>
          <Input value={draft.cabinetCode} maxLength={40} list="fw-ch-cabinets" placeholder="CAB-CUT-1" onChange={(event) => onDraft({ ...draft, cabinetCode: event.target.value.toUpperCase() })} />
        </Field>
        <datalist id="fw-ch-places">
          {(options?.places ?? []).map((place) => (
            <option key={place} value={place} />
          ))}
        </datalist>
        <datalist id="fw-ch-cabinets">
          {(options?.cabinets ?? []).map((code) => (
            <option key={code} value={code} />
          ))}
        </datalist>
      </div>
      <div className="fw-ch-form-row">
        <Field label={t('field.maxQuantity')} hint={t('field.maxQuantityHint')} error={fieldError('maxQuantity', true)}>
          <Input value={draft.maxQuantity} inputMode="decimal" onChange={(event) => onDraft({ ...draft, maxQuantity: event.target.value })} />
        </Field>
        <Field label={t('field.unit')} error={fieldError('maxQuantityUnit', true)}>
          <Select value={draft.maxQuantityUnit} onChange={(event) => onDraft({ ...draft, maxQuantityUnit: event.target.value as QuantityUnit | '' })}>
            <option value="">{t('field.unitNone')}</option>
            {QUANTITY_UNITS.map((unit) => (
              <option key={unit} value={unit}>
                {t(`unit.${unit}`)}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <fieldset className="fw-ch-fieldset">
        <legend className="fw-ch-h3">{t('field.roles')}</legend>
        {choices === null ? (
          <span className="fw-ch-muted">{t('field.rolesSiteFirst')}</span>
        ) : choices.status === 'loading' ? (
          <span className="fw-ch-muted">{t('common.reading')}</span>
        ) : choices.status === 'error' ? (
          <span className="fw-ch-warn">{t(choices.problem)}</span>
        ) : choices.value.roles.length === 0 ? (
          <span className="fw-ch-muted">{t('field.noRoles')}</span>
        ) : (
          <div className="fw-ch-picks" role="group" aria-label={t('field.roles')}>
            {choices.value.roles.map((role) => (
              <Checkbox key={role.id} checked={draft.roleSheetIds.includes(role.id)} label={role.name} onChange={() => onDraft({ ...draft, roleSheetIds: toggle(draft.roleSheetIds, role.id) })} />
            ))}
          </div>
        )}
        {atField(problem, 'roleSheetIds') && <span className="fw-ch-warn">{t(atField(problem, 'roleSheetIds')!)}</span>}
      </fieldset>
      <fieldset className="fw-ch-fieldset">
        <legend className="fw-ch-h3">{t('field.ppe')}</legend>
        {choices?.status === 'ready' ? (
          choices.value.ppe.length === 0 ? (
            <span className="fw-ch-muted">{t('field.noPpe')}</span>
          ) : (
            <div className="fw-ch-picks" role="group" aria-label={t('field.ppe')}>
              {choices.value.ppe.map((item) => (
                <Checkbox key={item.id} checked={draft.ppeItemIds.includes(item.id)} label={item.name} onChange={() => onDraft({ ...draft, ppeItemIds: toggle(draft.ppeItemIds, item.id) })} />
              ))}
            </div>
          )
        ) : (
          <span className="fw-ch-muted">{choices === null ? t('field.rolesSiteFirst') : t('common.reading')}</span>
        )}
        {atField(problem, 'ppeItemIds') && <span className="fw-ch-warn">{t(atField(problem, 'ppeItemIds')!)}</span>}
      </fieldset>
      <Field label={t('field.note')} error={fieldError('note', true)}>
        <Textarea value={draft.note} rows={2} maxLength={1000} onChange={(event) => onDraft({ ...draft, note: event.target.value })} />
      </Field>
    </div>
  )
}

/**
 * A sheet's PDF and facts (Add chemical's "SDS upload"; the window's Replace SDS): the file (a PDF), its version as the
 * supplier wrote it, its revision day (today at the latest), the language it is written in.
 */
export function SheetFields({ draft, problem, today, onDraft }: { draft: SheetDraft; problem: Problem | null; today: string; onDraft: (draft: SheetDraft, file?: File | null) => void }) {
  const t = useWords()
  const locale = useLocale()
  const error = (field: string) => (atField(problem, field) ? t(atField(problem, field)!) : undefined)
  return (
    <div className="fw-ch-form">
      {draft.file ? (
        <FileRow name={draft.file.name} size={draft.file.size} status={draft.file.type && draft.file.type !== 'application/pdf' ? t('held.pdf') : undefined} tone={draft.file.type && draft.file.type !== 'application/pdf' ? 'danger' : 'neutral'} onRemove={() => onDraft({ ...draft, file: null }, null)} />
      ) : (
        <FileDropzone accept={PDF_ACCEPT} maxBytes={MAX_BYTES} hint={t('sheet.dropHint')} onFiles={(files) => {
          const file = files[0]
          if (file) onDraft({ ...draft, file: { name: file.name, type: file.type || 'application/pdf', size: file.size } }, file)
        }} />
      )}
      {error('fileId') && <span className="fw-ch-warn">{error('fileId')}</span>}
      <div className="fw-ch-form-row">
        <Field label={t('sheet.version')} required hint={t('sheet.versionHint')} error={error('versionLabel')}>
          <Input value={draft.versionLabel} maxLength={50} onChange={(event) => onDraft({ ...draft, versionLabel: event.target.value })} />
        </Field>
        <Field label={t('sheet.revisedOn')} required error={error('revisedOn')}>
          <DateField value={draft.revisedOn} max={today} locale={locale} ariaLabel={t('sheet.revisedOn')} onChange={(revisedOn) => onDraft({ ...draft, revisedOn })} />
        </Field>
        <Field label={t('sheet.language')} required error={error('language')}>
          <Select value={draft.language} onChange={(event) => onDraft({ ...draft, language: event.target.value })}>
            {[...new Set([draft.language, ...SHEET_LANGUAGES])].map((code) => (
              <option key={code} value={code}>
                {t(`lang.${code}`)}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </div>
  )
}

/**
 * Add chemical (design pop:add; band primary, `c`): the chemical's fields and, optionally, its first data sheet. Add puts it
 * in the register; with a PDF the sheet is uploaded and recorded right after (a sheet refused then is said, and the chemical
 * stays in the register: its window offers Replace SDS). Esc closes; the focus returns to the opener.
 */
export function AddChemicalDialog({ model, state, actions }: { model: ChemicalsPageModel; state: AddState; actions?: ChemicalsPageActions | undefined }) {
  const t = useWords()
  const allSites = model.scope.allSites
  const sites = allSites ? model.scope.sites.map((site) => ({ id: site.id, name: site.name })) : null
  const site = model.scope.sites.find((entry) => entry.id === state.draft.siteId)
  const problems = draftProblems(state.draft, !!sites || !state.draft.siteId)
  const withSheet = state.sheet.file !== null
  const sheetProblem = withSheet ? sheetHeld(state.sheet, model.today, state.busy) : null
  const held = state.busy ? t('held.busy') : problems[0] ? t(problems[0].key) : sheetProblem ? t(sheetProblem) : null
  const close = () => actions?.onAddress?.({ add: false })
  return (
    <Modal
      open
      onClose={close}
      title={t('add.title')}
      size="lg"
      footer={
        <>
          <Button onClick={close}>{t('common.cancel')}</Button>
          {state.addedWithoutSheet ? (
            <Button variant="primary" onClick={() => actions?.onAddress?.({ add: false, open: state.addedWithoutSheet, mode: 'replace' })}>
              {t('add.openToReplace')}
            </Button>
          ) : (
            <Button variant="primary" heldReason={held} onClick={() => actions?.onSaveAdd?.()}>
              {withSheet ? t('add.saveWithSheet') : t('add.save')}
            </Button>
          )}
        </>
      }
    >
      <div className="fw-ch-form">
        {!sites && <p className="fw-ch-muted">{t('add.atSite', { site: site?.name ?? t('add.noSite') })}</p>}
        {state.addedWithoutSheet && <Banner tone="warning" title={t('add.sheetRefused')}>{state.problem ? t(state.problem.key) : null}</Banner>}
        {!state.addedWithoutSheet && state.problem && !state.problem.field && <Banner tone="danger" title={t(state.problem.key)} />}
        <ChemicalFields draft={state.draft} choices={state.choices} problem={state.addedWithoutSheet ? null : state.problem} sites={sites} onDraft={(draft) => actions?.onAddDraft?.(draft)} />
        <fieldset className="fw-ch-fieldset">
          <legend className="fw-ch-h3">{t('add.sheetTitle')}</legend>
          <span className="fw-ch-muted">{t('add.sheetHint')}</span>
          <SheetFields draft={state.sheet} problem={state.addedWithoutSheet ? state.problem : null} today={model.today} onDraft={(sheet, file) => actions?.onAddSheet?.(sheet, file)} />
        </fieldset>
      </div>
    </Modal>
  )
}
