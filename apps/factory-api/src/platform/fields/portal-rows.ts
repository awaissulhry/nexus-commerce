import type { FastifyRequest } from 'fastify'
import { ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { codesOf, columnIdOf, optionsInUse } from '@nexus/factory-domain/fields/access'
import type { FieldType } from '@nexus/factory-domain/fields/rules'
import type { Grain } from '@nexus/factory-domain/auth/grains/grains'
import { actorOf } from '../../core/context'
import { ApiError } from '../../core/errors'
import { systemCallerOf } from '../files/files'
import { wordsOf } from './fields'
import { customRecordOf, recordFactsOf, type CustomRecordKey } from './records'
import { fieldsOfModel, fieldsSeen, markedValue, referenceWords, valuesOfRecords, type FieldRow, type ValueRow } from './registry'

/**
 * The portal-shown custom values of a PAGE of a partner's own records (B-TH-061; threads plan TH-4, SHEET-G10; design
 * SHEET.portal-sheet-F02; wall W17, W39 / T39) — the portal sheet's columns, beside GET /fields/portal/:recordType/:recordId (one
 * record, ./fields.ts portalValues) and read the same way: in the tenant's system scope (the database gives a partner no grant on
 * custom fields), then kept to what the partner may see:
 *
 *   rows      only the records of the session's own party (and of the portal's company when given); any other id is simply not
 *             answered (never "it exists")
 *   columns   the fields shown in the portal (fieldSeenBy: a money one only with the price grain) for every customer or for this
 *             party (B-TH-056: never another customer's field, nor its name) — the union over the page's records, each record's
 *             cells only of the fields of ITS company and party; of a list, only the values these records use (a list may name
 *             other customers)
 *   cells     the value (money marked with its grain) and its words in both languages; never who changed it or when
 *
 * Reads only. The portal sheet (modules/sales/portal-orders/sheet.ts) and its "Download all" file are made from this.
 */

/** A column of the portal sheet: what the partner reads of a custom field (no ids, no customer, no company). */
export interface PortalColumn {
  readonly columnId: string
  readonly code: string
  readonly type: FieldType
  readonly labelIt: string
  readonly labelEn: string
  readonly unit: string | null
  readonly grain: Grain | null
  /** A select's values these records use (null: not a list field). */
  readonly options: readonly { readonly code: string; readonly labelIt: string; readonly labelEn: string }[] | null
}

/** One cell: the stored value (money marked with its grain) and its words. */
export interface PortalCell {
  readonly value: unknown
  readonly wordsIt: string | null
  readonly wordsEn: string | null
}

export interface PortalRows {
  readonly columns: readonly PortalColumn[]
  /** By record id, by column id; a record of the page with no value has an empty object. */
  readonly rows: ReadonlyMap<string, Readonly<Record<string, PortalCell>>>
}

/** The portal-shown custom values of the partner's own records among `recordIds` (see the module's head). */
export async function portalRowValues(request: FastifyRequest, recordType: CustomRecordKey, recordIds: readonly string[], companyId?: string): Promise<PortalRows> {
  const context = request.factoryContext
  if (!context) throw new ApiError('unauthenticated')
  if (context.audience !== 'partner') throw new ForbiddenError()
  const record = customRecordOf(recordType)
  if (!record || !record.portal) throw new NotFoundError('No such record type.')
  if (recordIds.length === 0) return { columns: [], rows: new Map() }
  const who = actorOf(context)
  const partyId = context.partyId
  const system = systemCallerOf(request)(context.tenantId)
  return system.withClient(async (client) => {
    const facts = [...(await recordFactsOf(client, record.model, recordIds)).values()].filter((row) => row.partyId === partyId && (companyId === undefined || row.companyId === companyId))
    if (facts.length === 0) return { columns: [], rows: new Map() }
    const all = await fieldsOfModel(client, record.model)
    const seenOn = new Map(facts.map((row) => [row.id, fieldsSeen(who, all, row.companyId, row.partyId ?? null)]))
    const shownIds = new Set([...seenOn.values()].flatMap((fields) => fields.map((field) => field.id)))
    const shown: FieldRow[] = all.filter((field) => shownIds.has(field.id))
    const values = await valuesOfRecords(client, record.model, facts.map((row) => row.id), shown.map((field) => field.id))
    const kept: ValueRow[] = facts.flatMap((row) => {
      const own = values.get(row.id)
      return own ? seenOn.get(row.id)!.flatMap((field) => (own.has(field.id) ? [own.get(field.id)!] : [])) : []
    })
    const references = await referenceWords(client, who, shown, kept)
    // Of a list, only the values these records use.
    const used = new Map<string, Set<string>>()
    for (const value of kept) for (const code of codesOf(value.value)) used.set(value.fieldId, (used.get(value.fieldId) ?? new Set<string>()).add(code))
    const columns: PortalColumn[] = shown.map((field) => ({
      columnId: columnIdOf(field),
      code: field.code,
      type: field.type,
      labelIt: field.labelIt,
      labelEn: field.labelEn,
      unit: field.unit,
      grain: field.grain,
      options: field.picklist ? optionsInUse(field.options, used.get(field.id) ?? new Set<string>()).map((option) => ({ code: option.code, labelIt: option.labelIt, labelEn: option.labelEn })) : null,
    }))
    const rows = new Map<string, Readonly<Record<string, PortalCell>>>(
      facts.map((row) => {
        const own = values.get(row.id)
        const cells = seenOn.get(row.id)!.flatMap((field) => {
          const value = own?.get(field.id)
          return value ? [[columnIdOf(field), { value: markedValue(field, value.value), ...wordsOf(field, value.value, references) }] as const] : []
        })
        return [row.id, Object.fromEntries(cells)]
      }),
    )
    return { columns, rows }
  })
}
