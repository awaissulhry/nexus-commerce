import { ReasonList } from '../src/generated/prisma/enums'
import { seedUuid, type SeedContext } from '../src/seeding'

/**
 * The reason lists seed (B-W2a-18's table), per tenant of seed/_core.ts: a base list for every ReasonList, in Italian and
 * English, with an icon of the design system's tag set and one of its swatches, an "Other" reason that asks for a note
 * (office) or a photo (floor) where a list needs one. The operation screen's scrap and rework reasons stay in
 * ScrapReason (seed/production.ts) and the defect library comes with wave 6/7; both are edited through the same editor.
 * Made-up wording a factory edits; written in the tenant's office scope; idempotent (stable ids, upserts that leave a
 * code as it is: a code never changes).
 */

const AT = new Date('2026-10-30T08:00:00.000Z')

// The design system's swatches (packages/ui tokens/colors.ts tagSwatches) and tag icons (primitives/icons/tag-icons).
const BLUE = '#1f6fde'
const AMBER = '#b87503'
const RED = '#e5484d'
const ORANGE = '#ea580c'
const EMERALD = '#059669'
const VIOLET = '#8b5cf6'
const INDIGO = '#6366f1'
const PINK = '#be185d'

type Reason = readonly [code: string, labelIt: string, labelEn: string, icon: string | null, colour: string | null, needsDetail?: boolean]

const OTHER = (icon: string | null = null): Reason => ['OTHER', 'Altro', 'Other', icon, null, true]

export const BASE_REASONS: Readonly<Record<ReasonList, readonly Reason[]>> = {
  [ReasonList.PAUSE]: [
    ['MATERIAL_WAIT', 'Attesa materiale', 'Waiting for material', 'package', AMBER],
    ['MACHINE', 'Macchina ferma', 'Machine stopped', 'alert', RED],
    ['INSTRUCTIONS', 'Attesa istruzioni', 'Waiting for instructions', 'flag', BLUE],
    ['BREAK', 'Pausa', 'Break', 'clock', EMERALD],
    OTHER(),
  ],
  [ReasonList.DOWNTIME]: [
    ['BREAKDOWN', 'Guasto', 'Breakdown', 'alert', RED],
    ['SETUP', 'Attrezzaggio', 'Set-up', 'zap', AMBER],
    ['PLANNED_MAINTENANCE', 'Manutenzione programmata', 'Planned maintenance', 'calendar', BLUE],
    ['POWER', 'Mancanza di corrente', 'Power cut', 'zap', ORANGE],
    OTHER(),
  ],
  [ReasonList.HELP_CALL]: [
    ['TEAM_LEADER', 'Capo reparto', 'Team leader', 'flag', BLUE],
    ['QUALITY', 'Qualità', 'Quality', 'shield', VIOLET],
    ['MAINTENANCE', 'Manutenzione', 'Maintenance', 'alert', RED],
    ['MATERIAL', 'Materiale', 'Material', 'package', AMBER],
    ['SAFETY', 'Sicurezza', 'Safety', 'shield', RED],
  ],
  [ReasonList.ADJUSTMENT]: [
    ['COUNT_ERROR', 'Errore di conteggio', 'Count error', null, BLUE],
    ['FOUND', 'Ritrovato', 'Found', null, EMERALD],
    ['DAMAGED', 'Danneggiato', 'Damaged', 'alert', RED],
    OTHER(),
  ],
  [ReasonList.HOLD]: [
    ['QUALITY_CHECK', 'Verifica qualità', 'Quality check', 'shield', VIOLET],
    ['MISSING_CERTIFICATE', 'Certificato mancante', 'Missing certificate', 'award', AMBER],
    ['CUSTOMER_REQUEST', 'Richiesta del cliente', 'Customer request', 'flag', BLUE],
    ['SUPPLIER_CHECK', 'Verifica fornitore', 'Supplier check', 'truck', INDIGO],
    OTHER(),
  ],
  [ReasonList.CANCEL]: [
    ['CUSTOMER_REQUEST', 'Richiesta del cliente', 'Customer request', null, BLUE],
    ['DUPLICATE', 'Duplicato', 'Duplicate', null, null],
    ['PRICE', 'Prezzo', 'Price', null, AMBER],
    ['LEAD_TIME', 'Tempi di consegna', 'Lead time', 'clock', ORANGE],
    OTHER(),
  ],
  [ReasonList.WRITE_OFF]: [
    ['DAMAGED', 'Danneggiato', 'Damaged', 'alert', RED],
    ['EXPIRED', 'Scaduto', 'Expired', 'calendar', AMBER],
    ['OBSOLETE', 'Obsoleto', 'Obsolete', 'box', INDIGO],
    ['LOST', 'Smarrito', 'Lost', null, ORANGE],
    OTHER('camera'),
  ],
  [ReasonList.RETURN]: [
    ['WRONG_SIZE', 'Taglia errata', 'Wrong size', 'shirt', BLUE],
    ['DEFECT', 'Difetto', 'Defect', 'alert', RED],
    ['DAMAGED_IN_TRANSIT', 'Danneggiato nel trasporto', 'Damaged in transit', 'truck', ORANGE],
    ['WRONG_ITEM', 'Articolo errato', 'Wrong item', 'package', AMBER],
    OTHER('camera'),
  ],
  [ReasonList.DISCREPANCY]: [
    ['SHORT', 'Quantità mancante', 'Short', 'package', AMBER],
    ['OVER', 'Quantità in eccesso', 'Over', 'package', BLUE],
    ['WRONG_ITEM', 'Articolo errato', 'Wrong item', 'box', ORANGE],
    ['DAMAGED', 'Danneggiato', 'Damaged', 'alert', RED],
  ],
  [ReasonList.CLAIM]: [
    ['QUALITY', 'Difetto di qualità', 'Quality defect', 'shield', VIOLET],
    ['SHORT_DELIVERY', 'Fornitura incompleta', 'Short delivery', 'package', AMBER],
    ['LATE_DELIVERY', 'Consegna in ritardo', 'Late delivery', 'clock', ORANGE],
    ['WRONG_ITEM', 'Articolo errato', 'Wrong item', 'box', RED],
    OTHER(),
  ],
  [ReasonList.DOWNGRADE]: [
    ['GRAIN_DEFECT', 'Difetto del fiore', 'Grain defect', 'leaf', AMBER],
    ['SHADE', 'Differenza di tonalità', 'Shade difference', 'sun', PINK],
    ['REPAIRED', 'Riparato', 'Repaired', 'shirt', BLUE],
    OTHER(),
  ],
}

export async function seed({ db, namespace }: SeedContext): Promise<void> {
  const id = (key: string): string => seedUuid(namespace, key)
  const tenantId = id('tenant')
  const actorId = id('actor')

  await db.withScope({ audience: 'office', tenantId, actorId }, (client) =>
    client.$transaction(async (tx) => {
      for (const [list, reasons] of Object.entries(BASE_REASONS) as [ReasonList, readonly Reason[]][]) {
        for (const [order, [code, labelIt, labelEn, icon, colour, needsDetail]] of reasons.entries()) {
          const reasonId = id(`reasons:${list}:${code}`)
          const words = { labelIt, labelEn, icon, colour, needsDetail: needsDetail ?? false, sortOrder: (order + 1) * 10 }
          await tx.reasonCode.upsert({
            where: { id: reasonId },
            create: { id: reasonId, list, code, ...words, createdAt: AT, updatedAt: AT, createdById: actorId },
            update: words,
            select: { id: true },
          })
        }
      }
    }),
  )
}
