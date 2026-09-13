import { expect, it } from 'vitest'
import { coerceForShape } from './sheet-values.js'
import { resolveAttributes } from './attribute-resolver.js'
import { resolveChannelField } from './resolve-channel-field.js'
import { INFORMATION_DICTIONARY_PLAN } from './information-dictionary-plan.js'
import { buildSheetColumns } from './sheet-columns.service.js'
import { completenessFor } from './sheet-rows.service.js'
import { buildCoordinateValidators, evaluateRow } from './readiness.service.js'
import { columnRequiredByAny } from '@nexus/shared/master-sheet'

it('preserves composition pairs, zero and extension properties; rejects incorrect totals and duplicate materials', () => {
  const facts = INFORMATION_DICTIONARY_PLAN.add[0]
  const value = [{ material: 'cotton', percentage: 100, origin: 'IT' }, { material: 'elastane', percentage: 0 }]
  expect(coerceForShape(facts as any, value)).toEqual({ ok: true, value })
  expect(coerceForShape(facts as any, [])).toEqual({ ok: true, value: [] })
  for (const bad of [[{ material: 'cotton', percentage: 20 }], [...value, value[0]], [{ material: 'cotton', percentage: -1 }], 'Cotton 100%']) expect(coerceForShape(facts as any, bad).ok).toBe(false)
})
it('marks legacy care content as fallback and gives a localized custom field the same source contract', () => {
  const product = { id: 'p', parentId: null, categoryAttributes: { care_instructions: 'Lavare a mano' }, localizedContent: {}, variantAttributes: {} }
  const values = resolveAttributes({ product, parent: null, locale: 'de', localizableKeys: ['care_instructions'] })
  expect(values.care_instructions).toMatchObject({ value: 'Lavare a mano', requestedLocale: 'de', effectiveLocale: 'it', translationState: 'fallback' })
  const mapped = resolveChannelField({ fieldKey: 'care', rule: { source: '', transforms: [{ type: 'expr', expr: 'upper($care_instructions)' }] }, product, resolvedAttrs: values, locale: 'de' })
  expect(mapped).toMatchObject({ needsTranslation: true, effectiveLocale: 'it', translationState: 'fallback' })
  // LX.F R-LX-13 — the legacy slot is RETIRED for content (design Appendix C), so
  // text in it can no longer change a cell; the shipped source store answers.
  expect(resolveAttributes({ product: { ...product, localizedContent: { it: { care_instructions: 'Nuovo testo' } } }, parent: null, locale: 'de', localizableKeys: ['care_instructions'] }).care_instructions.value).toBe('Lavare a mano')
  // POSITIVE CONTROL — the same text on the language tier DOES answer, in German.
  expect(resolveAttributes({ product: { ...product, translations: [{ language: 'de', attributes: { care_instructions: 'Handwäsche' }, source: 'manual' }] } as any, parent: null, locale: 'de', localizableKeys: ['care_instructions'] }).care_instructions)
    .toMatchObject({ value: 'Handwäsche', effectiveLocale: 'de' })
})
it('uses dictionary conditions consistently in missing filters, completeness and validation without requiring optional extensions', () => {
  const columns = buildSheetColumns({ fields: [{ id: 'attr_battery_type', label: 'Battery type', type: 'text', category: 'category', editable: true,
    familyRules: { heated: { required: false, sortOrder: 1 } }, validation: { requiredWhen: { field: 'batteries_included', equals: true } } }], coordinates: [], scopeKind: 'master', familySchema: true }).columns
  // VT.1 (2026-09-13): every scope now leads with the engine-owned `variation_theme` column, so the field under
  // test is selected by KIND rather than by position 0.
  const column = columns.filter(c => c.kind !== 'variationTheme')[0], shape = { isParent: false, productType: null, familyId: 'heated' }
  expect(columnRequiredByAny(column, { ...shape, values: { batteries_included: { value: true } } })).toBe(true)
  expect(columnRequiredByAny(column, { ...shape, values: { batteries_included: { value: false } } })).toBe(false)
  expect(completenessFor(columns, shape, { batteries_included: { value: true } } as any).required.total).toBe(1)
  const validators = buildCoordinateValidators(columns, { channel: 'MASTER' as any, marketplace: 'IT', label: 'Master', inMarket: true }, shape)
  expect(evaluateRow({ batteries_included: true }, validators)).toEqual([expect.objectContaining({ field: 'battery_type', severity: 'error' })])
  expect(evaluateRow({ batteries_included: false }, validators)).toEqual([])
})

it('reads historical mixed-case regional slots and preserves them when authoring canonical content', async () => {
  const { mergeLocalizedContent, validateLocalizedPatch } = await import('./localized-content.js')
  const prior = { 'pt-BR': { title: 'Histórico', description: 'Mantido' } }
  const next = mergeLocalizedContent(prior, { 'pt-BR': { title: 'Atualizado' } })
  expect(next['pt-BR']).toEqual(prior['pt-BR'])
  expect(validateLocalizedPatch({ 'pt-BR': { title: 'Atualizado' } })).toEqual([])
  // LX.F R-LX-13 — the historical slot is PRESERVED byte-for-byte (the two
  // assertions above) and is no longer READ for content: a `pt-BR` cell resolves
  // from the shipped stores, so it is empty until the backfill writes a row.
  expect(resolveAttributes({ product: { id: 'p', parentId: null, localizedContent: next, categoryAttributes: {}, variantAttributes: {} }, locale: 'pt-BR' }).title)
    .toMatchObject({ value: null, requestedLocale: 'pt' })  // LX.4: one normaliser, language-only
  // POSITIVE CONTROL — the regional tag normalises to one language on the tier.
  expect(resolveAttributes({ product: { id: 'p', parentId: null, localizedContent: next, categoryAttributes: {}, variantAttributes: {},
    translations: [{ language: 'pt', name: 'Atualizado', source: 'manual' }] } as any, locale: 'pt-BR' }).title)
    .toMatchObject({ value: 'Atualizado', effectiveLocale: 'pt', requestedLocale: 'pt' })
})
