/** Reviewable dictionary corrections. Applying them never modifies Product values or family assignments. */
export const INFORMATION_DICTIONARY_PLAN = {
  revision: '2026-09-11-information-v1',
  update: [
    ...['care_instructions', 'fabric_type', 'manufacturer_warranty'].map(code => ({ code, localizable: true, type: 'textarea',
      description: `${code === 'care_instructions' ? 'Care instructions' : code === 'fabric_type' ? 'Fabric description' : 'Warranty prose'} in the selected content language. Historical unlocalized content remains a marked source-language fallback.` })),
    ...['color', 'size'].map(code => ({ code, scope: 'per_variant', description: `Canonical variant ${code} code. Channel schemas and mappings supply their own labels and value projections.` })),
    ...['chestValue', 'waist__sizeValue', 'waist__widthValue', 'shoulder_to_bottom_hem_lengthValue', 'rise__heightValue'].map(code => ({ code, validation: { minimum: 0 } })),
    ...['chestUnit', 'waist__sizeUnit', 'waist__widthUnit', 'shoulder_to_bottom_hem_lengthUnit', 'rise__heightUnit'].map(code => ({ code, type: 'select', options: ['cm', 'in'].map(value => ({ code: value, label: value === 'cm' ? 'Centimetres' : 'Inches' })) })),
  ],
  add: [
    { code: 'material_composition', label: 'Material composition', type: 'text', scope: 'global', localizable: false,
      description: 'Material codes paired with percentages. Localized fabric wording is separate. Unknown saved properties are preserved.',
      validation: { shape: 'list', minItems: 0, maxItems: 30, uniqueBy: 'material', sum: { field: 'percentage', total: 100 }, recordFields: [
        { key: 'material', label: 'Material code', kind: 'text', required: true },
        { key: 'percentage', label: 'Percentage', kind: 'number', required: true, min: 0, max: 100 },
      ] } },
    { code: 'size_system', label: 'Size system', type: 'select', scope: 'global', localizable: false,
      description: 'System used by the canonical size codes. Provider scales remain channel mappings. A garment country label is a distinct historical fact.',
      options: [{ code: 'INT', label: 'International letters' }, { code: 'EU', label: 'European' }, { code: 'UK', label: 'United Kingdom' }, { code: 'US', label: 'United States' }, { code: 'IT', label: 'Italy' }, { code: 'FR', label: 'France' }, { code: 'DE', label: 'Germany' }], validation: {} },
  ],
} as const
