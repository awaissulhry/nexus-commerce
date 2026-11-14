import type { Prisma } from '../src/generated/prisma/client'
import { CustomFieldAudience, CustomFieldType, DocumentTemplateKind, MasterStatus, TemplateStatus } from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'
import { seed as seedAuth } from './auth'
import { seed as seedOptions } from './options'
import { seed as seedProduct } from './product'
import { seed as seedSalesPricing } from './sales-pricing'

/**
 * The configuration and templates seed (W2b-6 schema wave 56/57, B-W2b-379), per tenant of seed/_core.ts, written in the
 * tenant's office scope as the API writes these rows. It sorts after auth, options, product and sales-pricing, whose rows
 * it names, and runs them first anyway (each is idempotent). Every label, word and value is made up.
 *
 *   picklists   every company's "Lining type" (MESH, THERMAL, WATERPROOF; QUILTED deactivated: it stays on old records) and
 *               company A's "Finish grade" (A_GRADE, B_GRADE).
 *   fields      every company's: SEED-JKT styles' care code (TEXT, shown in the portal: the first row), lining type (SELECT),
 *               designer (PERSON), reference style (LINK to a Style); materials' thickness (NUMBER in mm); a rider's nickname
 *               on a party (TEXT, PERSONAL). Company A's: an order's target retail price (MONEY, price grain), fair date
 *               (DATE), rush packaging (YES_NO), finish grade (SELECT of its own list), a lot's mill certificate (FILE); a
 *               quote's old promotion code (TEXT, archived with its value kept).
 *   values      SEED-JKT-01's care code (the first row) and lining type; SEED-JKT-05's designer (the member) and reference
 *               style (SEED-JKT-01); the leather's thickness; SEED-SO-0004's target retail price, fair date, rush packaging
 *               and finish grade; SEED-Q-0003's old promotion code.
 *   documents   company A's quote template in Italian: version 1 RETIRED, version 2 ACTIVE, version 3 a DRAFT (the first
 *               row); its DDT template in English, version 1 ACTIVE.
 *   mails       every company's tracking-link mail (`shipping.tracking_link`) in Italian and English, ACTIVE; company A's own
 *               Italian one, a DRAFT (the first row).
 *   replies     company A's shared delay notice in Italian for orders (the first row) and in English; the member's own
 *               sample request for quotes; every company's "certificate sent" for any record.
 *   options     "Seed season order"'s configurable SEED-JKT-05 line starts with the standard armour (the first row) and the
 *               thermal liner (B-W2b-374's need: a template keeps its lines' options).
 *
 * The generated isolation tests (src/isolation.pg.vitest.test.ts) copy the FIRST row of each table by id (ids with eight
 * zeros) and insert the copy: so the first field is a plain TEXT field, the first value a text, the first versions DRAFTs
 * (a copy is another DRAFT: one ACTIVE per company, kind or event and language is a partial unique index), the first list
 * value one of an active list. Fixed instants, so nothing depends on the clock. Idempotent: rows are written once
 * (skipDuplicates), and each later step only moves a row still in the step before.
 */

const AT = new Date('2026-11-13T08:00:00.000Z')
const minutes = (n: number): Date => new Date(AT.getTime() + n * 60_000)

export interface ConfigSeed {
  readonly picklistIds: { readonly lining: string; readonly finish: string }
  readonly picklistValueIds: { readonly mesh: string; readonly thermal: string; readonly waterproof: string; readonly quilted: string; readonly aGrade: string; readonly bGrade: string }
  readonly fieldIds: {
    readonly careCode: string
    readonly liningType: string
    readonly designer: string
    readonly referenceStyle: string
    readonly thickness: string
    readonly riderNickname: string
    readonly targetRetail: string
    readonly fairDate: string
    readonly rushPackaging: string
    readonly finishGrade: string
    readonly millCertificate: string
    readonly oldPromo: string
  }
  readonly valueIds: readonly string[]
  readonly documentTemplateIds: { readonly quoteV1: string; readonly quoteV2: string; readonly quoteV3: string; readonly ddtEn: string }
  readonly emailTemplateIds: { readonly trackingIt: string; readonly trackingEn: string; readonly trackingItA: string }
  readonly messageTemplateIds: readonly string[]
  readonly templateLineOptionIds: readonly string[]
  readonly records: { readonly jkt01: string; readonly jkt05: string; readonly leather: string; readonly order: string; readonly quote: string; readonly seasonLine: string }
}

export async function seed(context: SeedContext): Promise<ConfigSeed> {
  const { db, namespace } = context
  const { ownerId, memberId } = await seedAuth(context)
  const product = await seedProduct(context)
  const options = await seedOptions(context)
  const pricing = await seedSalesPricing(context)
  const id = (key: string): string => seedUuid(namespace, key)
  const firstId = (key: string): string => `00000000${id(key).slice(8)}`
  const tenantId = id('tenant')
  const companyA = id('company:A')
  const office = { audience: 'office' as const, tenantId, actorId: ownerId }
  const stamp = (at: Date) => ({ createdAt: at, updatedAt: at, createdById: ownerId })
  const changed = (at: Date, by = ownerId) => ({ changedAt: at, changedById: by, ...stamp(at) })

  const records = {
    jkt01: product.styleId,
    jkt05: options.jacketStyleId,
    leather: product.leatherId,
    order: pricing.order.orderId,
    quote: pricing.draftQuote.quoteId,
    seasonLine: id('sales-pricing:template:SEASON:20'),
  }
  const result: ConfigSeed = {
    picklistIds: { lining: id('config:picklist:lining'), finish: id('config:picklist:finish:A') },
    picklistValueIds: {
      mesh: firstId('config:picklist:lining:MESH'),
      thermal: id('config:picklist:lining:THERMAL'),
      waterproof: id('config:picklist:lining:WATERPROOF'),
      quilted: id('config:picklist:lining:QUILTED'),
      aGrade: id('config:picklist:finish:A:A_GRADE'),
      bGrade: id('config:picklist:finish:A:B_GRADE'),
    },
    fieldIds: {
      careCode: firstId('config:field:Style:care_code'),
      liningType: id('config:field:Style:lining_type'),
      designer: id('config:field:Style:designer'),
      referenceStyle: id('config:field:Style:reference_style'),
      thickness: id('config:field:Item:thickness_mm'),
      riderNickname: id('config:field:Party:rider_nickname'),
      targetRetail: id('config:field:SalesOrder:target_retail_price'),
      fairDate: id('config:field:SalesOrder:fair_date'),
      rushPackaging: id('config:field:SalesOrder:rush_packaging'),
      finishGrade: id('config:field:SalesOrder:finish_grade'),
      millCertificate: id('config:field:Lot:mill_certificate'),
      oldPromo: id('config:field:Quote:old_promo_code'),
    },
    valueIds: [
      firstId('config:value:care_code:JKT-01'),
      id('config:value:lining_type:JKT-01'),
      id('config:value:designer:JKT-05'),
      id('config:value:reference_style:JKT-05'),
      id('config:value:thickness:leather'),
      id('config:value:target_retail:SO4'),
      id('config:value:fair_date:SO4'),
      id('config:value:rush_packaging:SO4'),
      id('config:value:finish_grade:SO4'),
      id('config:value:old_promo:Q3'),
    ],
    documentTemplateIds: {
      quoteV1: id('config:doc:A:QUOTE:it:1'),
      quoteV2: id('config:doc:A:QUOTE:it:2'),
      quoteV3: firstId('config:doc:A:QUOTE:it:3'),
      ddtEn: id('config:doc:A:DDT:en:1'),
    },
    emailTemplateIds: { trackingIt: id('config:mail:all:tracking:it:1'), trackingEn: id('config:mail:all:tracking:en:1'), trackingItA: firstId('config:mail:A:tracking:it:1') },
    messageTemplateIds: [firstId('config:reply:A:delay:it'), id('config:reply:A:delay:en'), id('config:reply:member:sample:it'), id('config:reply:all:certificate:en')],
    templateLineOptionIds: [firstId('config:template-option:SEASON:20:ARMOUR'), id('config:template-option:SEASON:20:LINER')],
    records,
  }
  const L = result.picklistIds
  const V = result.picklistValueIds
  const F = result.fieldIds
  const D = result.documentTemplateIds
  const M = result.emailTemplateIds
  const fieldKey = (recordType: string, code: string) => ({ recordType, code, key: `field:${recordType}:${code}` })
  const valueKey = (fieldId: string, recordType: string, recordId: string) => ({ fieldId, recordType, recordId, key: `value:${fieldId}:${recordId}` })
  const docKey = (kind: DocumentTemplateKind, language: string, revision: number) => ({ companyId: companyA, kind, language, revision, key: `doc:${kind}:${companyA}:${language}:${revision}` })
  const mailKey = (event: string, companyId: string | null, language: string, revision: number) => ({ companyId, event, language, revision, key: `mail:${event}:${companyId ?? 'all'}:${language}:${revision}` })
  const published = (at: Date) => ({ status: TemplateStatus.ACTIVE, publishedAt: at, publishedById: ownerId })
  const select = { id: true } as const

  await db.withScope(office, (client) =>
    client.$transaction(async (tx) => {
      // --- picklists (PLT-115) -------------------------------------------------------------------------------------------
      await tx.picklist.createMany({
        data: [
          { id: L.lining, companyId: null, code: 'lining_type', key: 'picklist:lining_type', labelIt: 'Tipo di fodera', labelEn: 'Lining type', ...stamp(minutes(0)) },
          { id: L.finish, companyId: companyA, code: 'finish_grade', key: 'picklist:finish_grade', labelIt: 'Grado di finitura', labelEn: 'Finish grade', ...stamp(minutes(0)) },
        ],
        skipDuplicates: true,
      })
      const option = (picklistId: string, code: string, labelIt: string, labelEn: string, sortOrder: number, extra: Partial<Prisma.PicklistValueCreateManyInput> = {}) => ({
        picklistId,
        code,
        key: `option:${picklistId}:${code}`,
        labelIt,
        labelEn,
        sortOrder,
        ...stamp(minutes(1)),
        ...extra,
      })
      await tx.picklistValue.createMany({
        data: [
          { id: V.mesh, ...option(L.lining, 'MESH', 'Rete traspirante', 'Breathable mesh', 10, { colour: '#0891b2', icon: 'wind', description: 'For summer jackets (made up).' }) },
          { id: V.thermal, ...option(L.lining, 'THERMAL', 'Termica', 'Thermal', 20, { colour: '#ea580c' }) },
          { id: V.waterproof, ...option(L.lining, 'WATERPROOF', 'Impermeabile', 'Waterproof', 30) },
          { id: V.quilted, ...option(L.lining, 'QUILTED', 'Trapuntata', 'Quilted', 40, { description: 'No longer offered; old styles keep it.' }) },
          { id: V.aGrade, ...option(L.finish, 'A_GRADE', 'Prima scelta', 'First grade', 10) },
          { id: V.bGrade, ...option(L.finish, 'B_GRADE', 'Seconda scelta', 'Second grade', 20) },
        ],
        skipDuplicates: true,
      })

      // --- custom fields (PLT-111) ---------------------------------------------------------------------------------------
      const fields: Prisma.CustomFieldCreateManyInput[] = [
        { id: F.careCode, ...fieldKey('Style', 'care_code'), type: CustomFieldType.TEXT, labelIt: 'Codice di manutenzione', labelEn: 'Care code', sortOrder: 10, shownInPortal: true, ...stamp(minutes(2)) },
        { id: F.liningType, ...fieldKey('Style', 'lining_type'), type: CustomFieldType.SELECT, labelIt: 'Tipo di fodera', labelEn: 'Lining type', sortOrder: 20, picklistId: L.lining, ...stamp(minutes(2)) },
        { id: F.designer, ...fieldKey('Style', 'designer'), type: CustomFieldType.PERSON, labelIt: 'Designer', labelEn: 'Designer', sortOrder: 30, ...stamp(minutes(2)) },
        { id: F.referenceStyle, ...fieldKey('Style', 'reference_style'), type: CustomFieldType.LINK, labelIt: 'Modello di riferimento', labelEn: 'Reference style', sortOrder: 40, linkTo: 'Style', ...stamp(minutes(2)) },
        { id: F.thickness, ...fieldKey('Item', 'thickness_mm'), type: CustomFieldType.NUMBER, labelIt: 'Spessore', labelEn: 'Thickness', unit: 'mm', section: 'specs', required: true, ...stamp(minutes(2)) },
        { id: F.riderNickname, ...fieldKey('Party', 'rider_nickname'), type: CustomFieldType.TEXT, labelIt: 'Soprannome del pilota', labelEn: 'Rider nickname', audience: CustomFieldAudience.PERSONAL, ...stamp(minutes(2)) },
        {
          id: F.targetRetail,
          companyId: companyA,
          ...fieldKey('SalesOrder', 'target_retail_price'),
          type: CustomFieldType.MONEY,
          labelIt: 'Prezzo al pubblico previsto',
          labelEn: 'Target retail price',
          audience: CustomFieldAudience.MONEY,
          grain: 'price',
          shownInPortal: true,
          ...stamp(minutes(2)),
        },
        { id: F.fairDate, companyId: companyA, ...fieldKey('SalesOrder', 'fair_date'), type: CustomFieldType.DATE, labelIt: 'Data della fiera', labelEn: 'Fair date', sortOrder: 20, ...stamp(minutes(2)) },
        { id: F.rushPackaging, companyId: companyA, ...fieldKey('SalesOrder', 'rush_packaging'), type: CustomFieldType.YES_NO, labelIt: 'Imballo urgente', labelEn: 'Rush packaging', sortOrder: 30, ...stamp(minutes(2)) },
        { id: F.finishGrade, companyId: companyA, ...fieldKey('SalesOrder', 'finish_grade'), type: CustomFieldType.SELECT, labelIt: 'Grado di finitura', labelEn: 'Finish grade', sortOrder: 40, picklistId: L.finish, ...stamp(minutes(2)) },
        { id: F.millCertificate, companyId: companyA, ...fieldKey('Lot', 'mill_certificate'), type: CustomFieldType.FILE, labelIt: 'Certificato della conceria', labelEn: 'Tannery certificate', ...stamp(minutes(2)) },
        { id: F.oldPromo, companyId: companyA, ...fieldKey('Quote', 'old_promo_code'), type: CustomFieldType.TEXT, labelIt: 'Codice promozione (vecchio)', labelEn: 'Promotion code (old)', ...stamp(minutes(2)) },
      ]
      await tx.customField.createMany({ data: fields, skipDuplicates: true })

      // --- values: written while their field is active ---------------------------------------------------------------
      const values: Prisma.CustomFieldValueCreateManyInput[] = [
        { id: result.valueIds[0]!, ...valueKey(F.careCode, 'Style', records.jkt01), value: 'Pulire con un panno umido; non lavare (seed).', ...changed(minutes(3)) },
        { id: result.valueIds[1]!, ...valueKey(F.liningType, 'Style', records.jkt01), value: 'THERMAL', ...changed(minutes(3)) },
        { id: result.valueIds[2]!, ...valueKey(F.designer, 'Style', records.jkt05), value: memberId, ...changed(minutes(3)) },
        { id: result.valueIds[3]!, ...valueKey(F.referenceStyle, 'Style', records.jkt05), value: records.jkt01, ...changed(minutes(3)) },
        { id: result.valueIds[4]!, ...valueKey(F.thickness, 'Item', records.leather), value: 1.2, ...changed(minutes(3)) },
        { id: result.valueIds[5]!, ...valueKey(F.targetRetail, 'SalesOrder', records.order), value: { amount: 89900, currency: 'EUR' }, ...changed(minutes(3)) },
        { id: result.valueIds[6]!, ...valueKey(F.fairDate, 'SalesOrder', records.order), value: '2027-01-21', ...changed(minutes(3)) },
        { id: result.valueIds[7]!, ...valueKey(F.rushPackaging, 'SalesOrder', records.order), value: false, ...changed(minutes(3), memberId) },
        { id: result.valueIds[8]!, ...valueKey(F.finishGrade, 'SalesOrder', records.order), value: 'A_GRADE', ...changed(minutes(3)) },
        { id: result.valueIds[9]!, ...valueKey(F.oldPromo, 'Quote', records.quote), value: 'SEED-PROMO-2026', ...changed(minutes(3)) },
      ]
      await tx.customFieldValue.createMany({ data: values, skipDuplicates: true })
      // A value no longer offered stays on the records that have it; a field no longer used is archived with its values.
      await tx.picklistValue.updateMany({ where: { id: V.quilted, active: true }, data: { active: false, updatedAt: minutes(4) } })
      await tx.customField.updateMany({ where: { id: F.oldPromo, status: MasterStatus.ACTIVE }, data: { status: MasterStatus.ARCHIVED, updatedAt: minutes(4) } })

      // --- document templates (PLT-231): version 1 published, then replaced by version 2; version 3 drafted -------------
      await tx.documentTemplate.createMany({
        data: [
          {
            id: D.quoteV1,
            ...docKey(DocumentTemplateKind.QUOTE, 'it', 1),
            header: 'Offerta per {{party.name}}: modelli e taglie come richiesto (seed).',
            terms: 'Condizioni di vendita del seed: testo inventato.',
            fieldsShown: ['discount'],
            ...stamp(minutes(5)),
          },
          { id: D.ddtEn, ...docKey(DocumentTemplateKind.DDT, 'en', 1), footer: 'Goods travel at the buyer’s risk unless agreed otherwise (seed).', ...stamp(minutes(5)) },
        ],
        skipDuplicates: true,
      })
      await tx.documentTemplate.updateMany({ where: { id: { in: [D.quoteV1, D.ddtEn] }, status: TemplateStatus.DRAFT }, data: { ...published(minutes(6)), updatedAt: minutes(6) } })
      await tx.documentTemplate.createMany({
        data: [
          {
            id: D.quoteV2,
            ...docKey(DocumentTemplateKind.QUOTE, 'it', 2),
            header: 'Offerta n. {{quote.number}} per {{party.name}} (seed).',
            terms: 'Condizioni di vendita del seed, versione 2: testo inventato.',
            footer: 'Grazie per la fiducia (seed).',
            fieldsShown: ['discount', 'delivery'],
            ...stamp(minutes(7)),
          },
        ],
        skipDuplicates: true,
      })
      const second = await tx.documentTemplate.findUniqueOrThrow({ where: { id: D.quoteV2 }, select: { status: true } })
      if (second.status === TemplateStatus.DRAFT) {
        // The version in use is retired first: one ACTIVE per company, kind and language.
        await tx.documentTemplate.updateMany({ where: { id: D.quoteV1, status: TemplateStatus.ACTIVE }, data: { status: TemplateStatus.RETIRED, retiredAt: minutes(8), updatedAt: minutes(8) } })
        await tx.documentTemplate.update({ where: { id: D.quoteV2 }, data: { ...published(minutes(8)), updatedAt: minutes(8) }, select })
      }
      await tx.documentTemplate.createMany({
        data: [
          {
            id: D.quoteV3,
            ...docKey(DocumentTemplateKind.QUOTE, 'it', 3),
            header: 'Offerta n. {{quote.number}} per {{party.name}}, valida fino al {{quote.validUntil}} (seed).',
            terms: 'Condizioni di vendita del seed, versione 3 in bozza: testo inventato.',
            fieldsShown: ['discount', 'delivery'],
            ...stamp(minutes(9)),
          },
        ],
        skipDuplicates: true,
      })

      // --- e-mail templates (PLT-232) ----------------------------------------------------------------------------------
      await tx.emailTemplate.createMany({
        data: [
          {
            id: M.trackingIt,
            ...mailKey('shipping.tracking_link', null, 'it', 1),
            subject: 'La spedizione {{shipment.number}} è partita',
            body: 'Gentile cliente,\nla spedizione {{shipment.number}} è partita. Segui il pacco qui: {{trackingUrl}}\n(testo inventato del seed)',
            ...stamp(minutes(10)),
          },
          {
            id: M.trackingEn,
            ...mailKey('shipping.tracking_link', null, 'en', 1),
            subject: 'Shipment {{shipment.number}} is on its way',
            body: 'Dear customer,\nshipment {{shipment.number}} has left. Follow the parcel here: {{trackingUrl}}\n(made-up seed words)',
            ...stamp(minutes(10)),
          },
          {
            id: M.trackingItA,
            ...mailKey('shipping.tracking_link', companyA, 'it', 1),
            subject: '{{company.tradeName}}: la spedizione {{shipment.number}} è partita',
            body: 'Gentile {{contact.name}},\nla tua spedizione è partita: {{trackingUrl}}\n(bozza inventata del seed)',
            ...stamp(minutes(11)),
          },
        ],
        skipDuplicates: true,
      })
      await tx.emailTemplate.updateMany({ where: { id: { in: [M.trackingIt, M.trackingEn] }, status: TemplateStatus.DRAFT }, data: { ...published(minutes(12)), updatedAt: minutes(12) } })

      // --- saved replies (COL-016) ---------------------------------------------------------------------------------------
      const replies = result.messageTemplateIds
      await tx.messageTemplate.createMany({
        data: [
          {
            id: replies[0]!,
            companyId: companyA,
            name: 'Avviso di ritardo',
            language: 'it',
            body: 'Gentile {{contact.name}},\nl’ordine {{order.number}} partirà il {{order.promiseDate}}. Ci scusiamo per il ritardo.\n(testo inventato)',
            recordType: 'SalesOrder',
            ...stamp(minutes(13)),
          },
          {
            id: replies[1]!,
            companyId: companyA,
            name: 'Delay notice',
            language: 'en',
            body: 'Dear {{contact.name}},\norder {{order.number}} will leave on {{order.promiseDate}}. We are sorry for the delay.\n(made-up words)',
            recordType: 'SalesOrder',
            ...stamp(minutes(13)),
          },
          {
            id: replies[2]!,
            companyId: companyA,
            name: 'Richiesta campione',
            language: 'it',
            body: 'Buongiorno,\nper l’offerta {{quote.number}} vi chiediamo un campione in taglia 52.\n(testo inventato)',
            recordType: 'Quote',
            ownerId: memberId,
            ...stamp(minutes(13)),
          },
          { id: replies[3]!, name: 'Certificate sent', language: 'en', body: 'Hello,\nthe certificate you asked for is attached.\n(made-up words)', ...stamp(minutes(13)) },
        ],
        skipDuplicates: true,
      })

      // --- the options a quote template's line starts with (B-W2b-374's need) ---------------------------------------
      // Only while the seed's line is there (the template route replaces a template's lines, and their options with them).
      if (await tx.quoteTemplateLine.findUnique({ where: { id: records.seasonLine }, select }))
        await tx.quoteTemplateLineOption.createMany({
        data: [
          { id: result.templateLineOptionIds[0]!, lineId: records.seasonLine, groupId: options.groupIds.armour, valueId: options.valueIds.armourStd, ...stamp(minutes(14)) },
          { id: result.templateLineOptionIds[1]!, lineId: records.seasonLine, groupId: options.groupIds.liner, valueId: options.valueIds.linerYes, ...stamp(minutes(14)) },
        ],
        skipDuplicates: true,
      })
    }),
  )
  return result
}
