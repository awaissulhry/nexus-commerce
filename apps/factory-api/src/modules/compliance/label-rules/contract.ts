import { z } from 'zod'
import { WARNING_REASONS } from '@nexus/factory-domain/compliance/label-rules/marking'
import { FINDING_SEVERITIES, LABEL_RULE_KEYS, LABEL_RULE_OUTCOMES } from '@nexus/factory-domain/compliance/label-rules/rules'
import { LABEL_KINDS, LABEL_QR_TARGETS } from '@nexus/factory-domain/compliance/labels/rules'
import { businessDate, defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { templateDetail } from '../labels/contract'

/**
 * What a PPE label must say: the contracts (B-W2b-253; PRD-333, PRD-335, PRD-336, PRD-346, PRD-349). Codes, names,
 * addresses as printed and phrase texts; no price, no cost, no person. Every check carries its legal reference (LawRef:
 * law, plain words, link) and the checkKey of the requirement it answers at label print (B-W2b-254).
 */

const lawRef = output({ law: z.string(), plain: z.string(), href: z.string().nullable() })
const finding = output({ path: z.string(), message: z.string(), severity: z.enum(FINDING_SEVERITIES) })

const checkView = output({
  key: z.enum(LABEL_RULE_KEYS),
  /** The checkKey of the requirement this check answers (ComplianceRequirement.checkKey). */
  gateKey: z.string(),
  title: z.string(),
  outcome: z.enum(LABEL_RULE_OUTCOMES),
  /** The label must not print while this is so (FAIL, WAITING, UNKNOWN). */
  blocks: z.boolean(),
  words: z.string(),
  law: z.array(lawRef),
  findings: z.array(finding),
})

const senderView = output({
  /** Owner 11-09: the brand for a private-label style sold under its own name, our company otherwise. */
  who: z.enum(['BRAND', 'COMPANY']),
  name: z.string().nullable(),
  address: z.string().nullable(),
  contact: z.string().nullable(),
  /** The MANUFACTURER operator row it comes from; null: none applies. */
  operatorId: z.string().nullable(),
})

const levelView = output({ level: z.string(), knuckle: z.boolean() })

export const labelChecksView = output({
  label: output({
    id: id(),
    code: z.string(),
    revision: z.number().int(),
    status: z.string(),
    kind: z.enum(LABEL_KINDS),
    qrTarget: z.enum(LABEL_QR_TARGETS),
    gpsrContact: z.string().nullable(),
    languages: z.array(z.string()),
    version: z.number().int(),
  }),
  style: output({
    id: id(),
    code: z.string(),
    name: z.string(),
    ppeCategory: z.string(),
    ppeStandard: z.string().nullable(),
    ppeClass: z.string().nullable(),
    productType: z.string(),
    soldUnderOurName: z.boolean(),
  }),
  revisionId: id().nullable(),
  workOrder: output({ id: id(), number: z.string(), batchNumber: z.string().nullable(), released: z.boolean() }).nullable(),
  /** One entry per market checked (the one asked, else every switched-on market); one entry with market null when none. */
  markets: z.array(
    output({
      market: output({ code: z.string(), name: z.string(), switchedOn: z.boolean(), labelLanguages: z.array(z.string()), markings: z.array(z.string()), gpsrContactNeeded: z.boolean() }).nullable(),
      sender: senderView,
      blocks: z.boolean(),
      /** In order: ceMarking, classWarnings, gloveMarking, gpsr, qrCode. */
      checks: z.array(checkView),
    }),
  ),
  /** What the label must print beyond W1's fields, in the label's and the markets' languages. */
  marking: output({
    qr: output({
      target: z.enum(LABEL_QR_TARGETS),
      kind: z.enum(['BATCH', 'STYLE']),
      /** null: the batch is known only at print. */
      address: z.string().nullable(),
      printed: z.string().nullable(),
      recordType: z.string().nullable(),
      recordId: z.string().nullable(),
      reference: z.string().nullable(),
      origin: z.string(),
      /** The page shows something today; null: not known yet. */
      live: z.boolean().nullable(),
    }).nullable(),
    warnings: z.array(
      output({
        reason: z.enum(WARNING_REASONS),
        key: z.string(),
        texts: z.array(output({ language: z.string(), text: z.string().nullable() })),
        /** GATE-PPE-TEXTS: a draft until a PPE consultant says yes to this label's texts. */
        draft: z.boolean(),
      }),
    ),
    glove: output({ level: levelView, text: z.string(), granted: levelView.nullable() }).nullable(),
    gpsr: output({ typed: z.string().nullable(), expected: senderView, suggested: z.string().nullable() }),
  }),
  asOf: businessDate(),
})

export const templateChecksContract = defineContract({
  params: input({ templateId: id() }),
  querystring: input({
    styleId: id().optional(),
    styleRevisionId: id().optional(),
    workOrderId: id().optional(),
    marketCode: z.string().trim().min(2).max(40).optional(),
    colourwayId: id().optional(),
    size: z.string().trim().min(1).max(16).optional(),
  }),
  response: { 200: output({ checks: labelChecksView }) },
})

export const markingContract = defineContract({
  params: input({ templateId: id() }),
  body: input({
    version: z.number().int().min(1),
    kind: z.enum(LABEL_KINDS).optional(),
    /** The name with the postal and the electronic address, lines allowed; null or empty: none. */
    gpsrContact: z.string().max(500).nullable().optional(),
    qrTarget: z.enum(LABEL_QR_TARGETS).optional(),
  }),
  response: { 200: output({ template: templateDetail }) },
})
