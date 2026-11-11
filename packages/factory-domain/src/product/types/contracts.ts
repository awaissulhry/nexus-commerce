import { z } from 'zod'
import { id, input, instant, output } from '../../core/contracts'
import { localisedNames } from '../materials/contracts'
import { MASTER_STATUSES } from '../sizes/rules'
import { PPE_CATEGORIES, PRODUCT_TYPES } from '../styles/rules'
import { REQUIRABLE_ATTRIBUTES, TYPE_LIMITS } from './rules'

/**
 * The product types' contracts (B-W2b-221; PRD-008; design products.settings psettings.types): what apps/factory-api's
 * modules/product/types accepts and answers. A type's own values beside what it gives after inheritance (`effective`, each
 * value with the type it comes from). No money.
 */

const text = (max: number) => z.string().trim().min(1).max(max)
const version = () => z.number().int().min(1)
const ref = output({ id: id(), code: z.string(), name: z.string() })

export const typeParams = input({ typeId: id() })
export const styleTypeParams = input({ styleId: id() })

export const listTypesQuery = input({
  productType: z.enum(PRODUCT_TYPES).optional(),
  /** ACTIVE (default), ARCHIVED or ALL. */
  status: z.enum([...MASTER_STATUSES, 'ALL']).default('ACTIVE'),
  /** The types a style of this company may take (its own and the tenant-wide ones). */
  companyId: id().optional(),
})
export type ListTypesQuery = z.output<typeof listTypesQuery>

const typeFields = {
  name: text(TYPE_LIMITS.name),
  nameI18n: localisedNames().nullish(),
  parentId: id().nullish(),
  requiredAttributes: z.array(z.enum(REQUIRABLE_ATTRIBUTES)).max(TYPE_LIMITS.required),
  defaultSizeScaleId: id().nullish(),
  labelTemplateId: id().nullish(),
  measurementTemplateId: id().nullish(),
  defaultPpeCategory: z.enum(PPE_CATEGORIES).nullish(),
  /** With its edition ("EN 17092-4:2020"). */
  defaultPpeStandard: text(TYPE_LIMITS.standard).nullish(),
  defaultPpeClass: text(TYPE_LIMITS.ppeClass).nullish(),
}

export const createTypeBody = input({
  /** Left out or null: tenant-wide (every company's styles may take it). */
  companyId: id().nullish(),
  code: z.string().trim().min(1).max(TYPE_LIMITS.code).regex(/^\S+$/, { message: 'A code has no spaces.' }),
  productType: z.enum(PRODUCT_TYPES),
  ...typeFields,
  requiredAttributes: typeFields.requiredAttributes.optional(),
})
export type CreateTypeBody = z.output<typeof createTypeBody>

/** A change: only the fields sent change (null clears an optional one). The company never changes. */
export const updateTypeBody = input({
  version: version(),
  code: createTypeBody.shape.code.optional(),
  productType: z.enum(PRODUCT_TYPES).optional(),
  name: typeFields.name.optional(),
  nameI18n: typeFields.nameI18n,
  parentId: typeFields.parentId,
  requiredAttributes: typeFields.requiredAttributes.optional(),
  defaultSizeScaleId: typeFields.defaultSizeScaleId,
  labelTemplateId: typeFields.labelTemplateId,
  measurementTemplateId: typeFields.measurementTemplateId,
  defaultPpeCategory: typeFields.defaultPpeCategory,
  defaultPpeStandard: typeFields.defaultPpeStandard,
  defaultPpeClass: typeFields.defaultPpeClass,
})
export type UpdateTypeBody = z.output<typeof updateTypeBody>

export const typeStatusBody = input({ version: version(), reason: text(500).optional() })
export type TypeStatusBody = z.output<typeof typeStatusBody>

const inherited = <Schema extends z.ZodType>(value: Schema) => output({ value: value.nullable(), fromTypeId: id().nullable() })

export const typeView = output({
  id: id(),
  code: z.string(),
  name: z.string(),
  nameI18n: z.record(z.string(), z.string()).nullable(),
  companyId: id().nullable(),
  productType: z.enum(PRODUCT_TYPES),
  parent: ref.nullable(),
  status: z.enum(MASTER_STATUSES),
  version: z.number().int(),
  updatedAt: instant(),
  /** B-W2b-283 (FU1:04): the office person who changed the type last (null: nobody recorded); "Changed by" without audit.read. */
  changedBy: output({ id: id(), name: z.string() }).nullable().optional(),
  /** The type's own values (null: inherited or none). */
  own: output({
    requiredAttributes: z.array(z.string()),
    defaultSizeScaleId: id().nullable(),
    labelTemplateId: id().nullable(),
    measurementTemplateId: id().nullable(),
    defaultPpeCategory: z.enum(PPE_CATEGORIES).nullable(),
    defaultPpeStandard: z.string().nullable(),
    defaultPpeClass: z.string().nullable(),
  }),
  /** What a new style of it takes, after inheritance: each value with the type it comes from. */
  effective: output({
    requiredAttributes: z.array(output({ name: z.string(), fromTypeId: id() })),
    defaults: output({
      defaultSizeScaleId: inherited(id()),
      labelTemplateId: inherited(id()),
      measurementTemplateId: inherited(id()),
      defaultPpeCategory: inherited(z.enum(PPE_CATEGORIES)),
      defaultPpeStandard: inherited(z.string()),
      defaultPpeClass: inherited(z.string()),
    }),
  }),
  /** The size scale, label template and measurement template the defaults name (code and name). */
  refs: output({ sizeScale: ref.nullable(), labelTemplate: ref.extend({ revision: z.number().int() }).nullable(), measurementTemplate: ref.nullable() }),
  /** Its child types, and how many styles have it. */
  children: z.array(ref),
  styles: z.number().int(),
})
export type TypeView = z.infer<typeof typeView>

/** A style's type: what it gives, what the style still misses of it, and where the style differs from its defaults. */
export const styleTypeView = output({
  style: output({ id: id(), code: z.string(), version: z.number().int() }),
  type: typeView.nullable(),
  /** Required attributes (the type's and its parents') the style has not filled: B-W2b-231's release check. */
  missing: z.array(z.string()),
  /** The defaults the style does not follow (its own value kept). */
  differs: z.array(output({ field: z.string(), style: z.string().nullable(), type: z.string().nullable() })),
})
export type StyleTypeView = z.infer<typeof styleTypeView>

/** The style's type (null: none). Setting it is a change of the style's spec: its edit rule applies. */
export const setStyleTypeBody = input({ version: version(), typeId: id().nullable() })
export type SetStyleTypeBody = z.output<typeof setStyleTypeBody>

