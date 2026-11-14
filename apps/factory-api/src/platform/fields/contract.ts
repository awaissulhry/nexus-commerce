import { z } from 'zod'
import { GRAINS } from '@nexus/factory-domain/auth/grains/grains'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { FIELD_AUDIENCES, FIELD_LIMITS, FIELD_STATUSES, FIELD_TYPES } from '@nexus/factory-domain/fields/rules'
import { grainedJson } from '@nexus/factory-domain/money/marked'
import { CUSTOM_RECORD_KEYS } from './records'

/**
 * Custom fields and picklists (B-W2b-421; PLT-111, PLT-115; design admin.fields with its popup "Add field to …", and the
 * custom-fields section of every record panel, its grid columns, filters, exports and imports). Words are checked in
 * factory-domain fields/rules and values (answers in words at `body/<field>`); the lengths here only stop oversized
 * bodies. Every write takes an Idempotency-Key and the version read.
 */

const recordType = z.enum(CUSTOM_RECORD_KEYS)
const version = z.number().int().min(1)
const words = () => z.string().max(FIELD_LIMITS.label * 2)
const code = () => z.string().trim().max(40)

export const optionView = output({
  id: id(),
  code: z.string(),
  labelIt: z.string(),
  labelEn: z.string(),
  colour: z.string().nullable(),
  icon: z.string().nullable(),
  sortOrder: z.number().int(),
  description: z.string().nullable(),
  /** A deactivated value is no longer offered; records that have it keep it and show it. */
  active: z.boolean(),
  version: z.number().int(),
})

export const picklistView = output({
  id: id(),
  companyId: id().nullable(),
  code: z.string(),
  labelIt: z.string(),
  labelEn: z.string(),
  status: z.enum(FIELD_STATUSES),
  version: z.number().int(),
  values: z.array(optionView),
  /** How many active fields pick from it (a list is archived only when none does). */
  fieldCount: z.number().int().min(0),
})
export type PicklistView = z.infer<typeof picklistView>

/** A field as a form, a grid and a filter read it (and the editor, with its counts). */
export const fieldView = output({
  id: id(),
  companyId: id().nullable(),
  code: z.string(),
  /** The list frame's and the export's column id: `cf:<code>`, a money field `cf:<grain>:<code>`. */
  columnId: z.string(),
  type: z.enum(FIELD_TYPES),
  labelIt: z.string(),
  labelEn: z.string(),
  section: z.string(),
  sortOrder: z.number().int(),
  required: z.boolean(),
  unit: z.string().nullable(),
  audience: z.enum(FIELD_AUDIENCES),
  grain: z.enum(GRAINS).nullable(),
  shownInPortal: z.boolean(),
  status: z.enum(FIELD_STATUSES),
  version: z.number().int(),
  /** SELECT, MULTI_SELECT: the list and its values (deactivated ones too: a record may hold one). */
  picklist: output({ id: id(), code: z.string(), labelIt: z.string(), labelEn: z.string(), values: z.array(optionView) }).nullable(),
  /** LINK: the model it links to, and the record type of the registry that opens it (null: none). */
  linkTo: z.string().nullable(),
  linkRecordType: recordType.nullable(),
})
export type FieldView = z.infer<typeof fieldView>

const editorField = fieldView.extend({ valueCount: z.number().int().min(0), createdAt: instant(), updatedAt: instant() })

export const recordTypeView = output({
  key: recordType,
  model: z.string(),
  labelIt: z.string(),
  labelEn: z.string(),
  /** Its active fields. */
  fieldCount: z.number().int().min(0),
  /** The record types that share its fields (customer and supplier: both a party). */
  sharedWith: z.array(recordType),
  listKey: z.string(),
  importer: z.string(),
})

/** One value of a record as its form shows it. */
export const valueView = output({
  code: z.string(),
  /** The stored value (money marked with its grain: absent without it). */
  value: grainedJson(),
  /** A select's label, a person's name, a linked record's code, a file's name (null: none, or a record you may not open). */
  wordsIt: z.string().nullable(),
  wordsEn: z.string().nullable(),
  version: z.number().int(),
  changedAt: instant(),
  changedById: id(),
})

// ---- the editor -------------------------------------------------------------------------------------------------------

export const editorContract = defineContract({
  querystring: input({ recordType: recordType.optional() }),
  response: {
    200: output({
      records: z.array(recordTypeView),
      recordType,
      fields: z.array(editorField),
      picklists: z.array(picklistView),
      canManage: z.boolean(),
    }),
  },
})

const fieldBody = {
  labelIt: words().optional(),
  labelEn: words().optional(),
  section: code().optional(),
  sortOrder: z.number().int().min(0).max(FIELD_LIMITS.sortOrder).optional(),
  required: z.boolean().optional(),
  unit: z.string().max(FIELD_LIMITS.unit * 2).nullable().optional(),
  audience: z.enum(FIELD_AUDIENCES).optional(),
  grain: z.enum(GRAINS).nullable().optional(),
  shownInPortal: z.boolean().optional(),
}

export const createFieldContract = defineContract({
  body: input({
    recordType,
    companyId: id().nullable().optional(),
    code: code(),
    type: z.enum(FIELD_TYPES),
    ...fieldBody,
    labelIt: words(),
    labelEn: words(),
    picklistId: id().nullable().optional(),
    linkTo: recordType.nullable().optional(),
  }),
  response: { 201: output({ field: fieldView }) },
})
export type CreateFieldBody = z.infer<typeof createFieldContract.body>

export const editFieldContract = defineContract({
  params: input({ fieldId: id() }),
  body: input({ version, ...fieldBody, status: z.enum(FIELD_STATUSES).optional() }),
  response: { 200: output({ field: fieldView }) },
})
export type EditFieldBody = z.infer<typeof editFieldContract.body>

const versioned = z.array(input({ id: id(), version })).min(1).max(FIELD_LIMITS.perRecordType)

export const orderFieldsContract = defineContract({
  body: input({ recordType, section: code(), fields: versioned }),
  response: { 200: output({ fields: z.array(fieldView) }) },
})

export const createPicklistContract = defineContract({
  body: input({ companyId: id().nullable().optional(), code: code(), labelIt: words(), labelEn: words() }),
  response: { 201: output({ picklist: picklistView }) },
})

export const editPicklistContract = defineContract({
  params: input({ picklistId: id() }),
  body: input({ version, labelIt: words().optional(), labelEn: words().optional(), status: z.enum(FIELD_STATUSES).optional() }),
  response: { 200: output({ picklist: picklistView }) },
})

const optionBody = {
  labelIt: words().optional(),
  labelEn: words().optional(),
  colour: z.string().max(7).nullable().optional(),
  icon: z.string().max(40).nullable().optional(),
  description: z.string().max(FIELD_LIMITS.description * 2).nullable().optional(),
}

export const createOptionContract = defineContract({
  params: input({ picklistId: id() }),
  body: input({ code: code(), ...optionBody, labelIt: words(), labelEn: words() }),
  response: { 201: output({ picklist: picklistView }) },
})

export const editOptionContract = defineContract({
  params: input({ picklistId: id(), valueId: id() }),
  body: input({ version, ...optionBody, active: z.boolean().optional() }),
  response: { 200: output({ picklist: picklistView }) },
})

export const orderOptionsContract = defineContract({
  params: input({ picklistId: id() }),
  body: input({ values: z.array(input({ id: id(), version })).min(1).max(FIELD_LIMITS.perList) }),
  response: { 200: output({ picklist: picklistView }) },
})

// ---- forms, grids, the portal ----------------------------------------------------------------------------------------

export const fieldsContract = defineContract({
  querystring: input({ recordType, companyId: id().optional() }),
  response: { 200: output({ recordType, fields: z.array(fieldView) }) },
})

const recordParams = input({ recordType, recordId: id() })

export const recordValuesContract = defineContract({
  params: recordParams,
  response: { 200: output({ recordType, recordId: id(), fields: z.array(fieldView), values: z.array(valueView), canEdit: z.boolean() }) },
})

export const writeValuesContract = defineContract({
  params: recordParams,
  body: input({
    values: z
      .array(input({ code: code(), value: grainedJson(), version: version.nullable() }))
      .min(1)
      .max(FIELD_LIMITS.perRequest),
  }),
  response: { 200: output({ recordType, recordId: id(), fields: z.array(fieldView), values: z.array(valueView), canEdit: z.boolean(), set: z.array(z.string()), cleared: z.array(z.string()) }) },
})
export type WriteValuesBody = z.infer<typeof writeValuesContract.body>

export const rowsContract = defineContract({
  params: input({ recordType }),
  body: input({ ids: z.array(id()).min(1).max(FIELD_LIMITS.perRequest) }),
  response: {
    200: output({
      recordType,
      fields: z.array(fieldView),
      /** The rows this person may see, each with its values by field code (rows without a value are listed empty). */
      rows: z.array(output({ id: id(), values: z.record(z.string(), output({ value: grainedJson(), wordsIt: z.string().nullable(), wordsEn: z.string().nullable() })) })),
    }),
  },
})

export const portalValuesContract = defineContract({
  params: recordParams,
  response: { 200: output({ recordType, recordId: id(), fields: z.array(fieldView), values: z.array(valueView) }) },
})
