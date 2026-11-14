import { idempotencyKeyFrom } from '../../core/command'
import { defineRoutes } from '../../core/manifest'
import {
  createFieldContract,
  createOptionContract,
  createPicklistContract,
  editFieldContract,
  editOptionContract,
  editorContract,
  editPicklistContract,
  fieldsContract,
  orderFieldsContract,
  orderOptionsContract,
  portalValuesContract,
  recordValuesContract,
  rowsContract,
  writeValuesContract,
} from './contract'
import { addOption, createField, createPicklist, editField, editOption, editor, editPicklist, fieldsFor, orderFields, orderOptions, portalValues, recordValues, rowValues, writeValues } from './fields'
import { manifest } from './manifest'

/**
 * Custom fields and picklists (B-W2b-421; PLT-111, PLT-115; design admin.fields — the screens are B-W2b-431's):
 *   GET   /fields/editor?recordType=ORDER                  the record types, that type's fields (archived too, with how many
 *                                                          records have a value), every list, whether the caller keeps them
 *   POST  /fields                                          a field added to a record type ("Add field to …")
 *   PATCH /fields/:fieldId                                 labels, section, place, required, unit, who sees it, portal; archive
 *                                                          or restore (status)
 *   POST  /fields/order                                    the order of one section's active fields
 *   POST  /fields/picklists                                a new list
 *   PATCH /fields/picklists/:picklistId                    its names; archive or restore
 *   POST  /fields/picklists/:picklistId/values             a value at the list's end
 *   PATCH /fields/picklists/:picklistId/values/:valueId    one value's cells (labels, colour, icon, description, active)
 *   POST  /fields/picklists/:picklistId/order              the list's order
 *   GET   /fields?recordType=ORDER[&companyId=]            the fields a form, a grid and a filter show this person
 *   GET   /fields/values/:recordType/:recordId             a record's custom-fields section
 *   PUT   /fields/values/:recordType/:recordId             set or clear its values, each at the version read
 *   POST  /fields/rows/:recordType {ids}                   a grid page's custom values
 *   GET   /fields/portal/:recordType/:recordId             a partner: the fields shown in the portal on its own record
 */
export default defineRoutes('fields', manifest, async (app) => {
  app.get('/fields/editor', { schema: editorContract }, async (request) => editor(request, request.query))
  app.post('/fields', { schema: createFieldContract }, async (request, reply) => reply.code(201).send({ field: await createField(request, request.body, idempotencyKeyFrom(request)) }))
  app.patch('/fields/:fieldId', { schema: editFieldContract }, async (request) => ({ field: await editField(request, request.params.fieldId, request.body, idempotencyKeyFrom(request)) }))
  app.post('/fields/order', { schema: orderFieldsContract }, async (request) => orderFields(request, request.body, idempotencyKeyFrom(request)))
  app.post('/fields/picklists', { schema: createPicklistContract }, async (request, reply) => reply.code(201).send({ picklist: await createPicklist(request, request.body, idempotencyKeyFrom(request)) }))
  app.patch('/fields/picklists/:picklistId', { schema: editPicklistContract }, async (request) => ({ picklist: await editPicklist(request, request.params.picklistId, request.body, idempotencyKeyFrom(request)) }))
  app.post('/fields/picklists/:picklistId/values', { schema: createOptionContract }, async (request, reply) =>
    reply.code(201).send({ picklist: await addOption(request, request.params.picklistId, request.body, idempotencyKeyFrom(request)) }),
  )
  app.patch('/fields/picklists/:picklistId/values/:valueId', { schema: editOptionContract }, async (request) => ({
    picklist: await editOption(request, request.params.picklistId, request.params.valueId, request.body, idempotencyKeyFrom(request)),
  }))
  app.post('/fields/picklists/:picklistId/order', { schema: orderOptionsContract }, async (request) => ({ picklist: await orderOptions(request, request.params.picklistId, request.body, idempotencyKeyFrom(request)) }))
  app.get('/fields', { schema: fieldsContract }, async (request) => fieldsFor(request, request.query))
  app.get('/fields/values/:recordType/:recordId', { schema: recordValuesContract }, async (request) => recordValues(request, request.params.recordType, request.params.recordId))
  app.put('/fields/values/:recordType/:recordId', { schema: writeValuesContract }, async (request) => writeValues(request, request.params.recordType, request.params.recordId, request.body, idempotencyKeyFrom(request)))
  app.post('/fields/rows/:recordType', { schema: rowsContract }, async (request) => rowValues(request, request.params.recordType, request.body.ids))
  app.get('/fields/portal/:recordType/:recordId', { schema: portalValuesContract }, async (request) => portalValues(request, request.params.recordType, request.params.recordId))
})
