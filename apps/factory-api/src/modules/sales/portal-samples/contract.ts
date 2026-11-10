import { z } from 'zod'
import { APPROVAL_KINDS } from '@nexus/factory-domain/approvals-out/kinds'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { SCAN_STATES } from '@nexus/factory-domain/product/techpack/scan'
import { BRAND_ROUND_STATUSES, STYLE_STAGES, WAITING_RECORD_TYPES } from '@nexus/factory-domain/sales/portal-samples/rules'
import { SAMPLE_DECISIONS, SAMPLE_KINDS, SAMPLE_STAGES } from '@nexus/factory-domain/sales/samples/rules'

/**
 * The brand's samples and tech packs in the portal (B-W2b-262; PRD-245; design portal.customer.samples, SCR-225). Codes only
 * (the page says them in its own words); the brand's own facts as they are (style names, numbers). No money key at all: no
 * charge of a round, no cost of a tech pack (a PDF never carries one); no person of the office (who decided, who made it).
 */

const words = output({ it: z.string(), en: z.string() })
const style = output({ id: id(), code: z.string(), name: z.string() })
const roundRef = output({ id: id(), number: z.string(), kind: z.enum(SAMPLE_KINDS), roundNo: z.number().int(), label: words })

const techPack = output({
  /** The GeneratedDocument (a BRAND version of the style revision). */
  id: id(),
  revision: z.number().int(),
  revisionStatus: z.enum(['DRAFT', 'RELEASED', 'OBSOLETE']),
  version: z.number().int(),
  language: z.string(),
  /** The code printed under the QR ("7K3QM-2XA9B"). */
  printed: z.string(),
  createdAt: instant(),
  /** Against the party's own versions: CURRENT, DRAFT, NEWER_VERSION, NEWER_REVISION, OBSOLETE (factory-domain scanVerdict). */
  state: z.enum(SCAN_STATES),
})

const shipment = output({
  carrierName: z.string().nullable(),
  trackingNumber: z.string().nullable(),
  /** https only. */
  trackingUrl: z.string().nullable(),
  sentAt: instant().nullable(),
  receivedAt: instant().nullable(),
})

const waiting = output({
  requestId: id(),
  kind: z.enum(APPROVAL_KINDS),
  recordType: z.enum(WAITING_RECORD_TYPES),
  recordId: id(),
  /** What the request is about, as the approvals engine words it (the round, the swatch, the style). */
  label: words,
  style: style.nullable(),
  round: roundRef.nullable(),
  swatch: output({ id: id(), kind: z.enum(['COLOUR', 'LEATHER']) }).nullable(),
  question: z.string(),
  askedAt: instant(),
  dueAt: instant(),
  /** When the sample reached the brand (the round's outbound shipment), if it did. */
  receivedAt: instant().nullable(),
  version: z.number().int(),
})

const styleRow = output({
  id: id(),
  code: z.string(),
  name: z.string(),
  season: z.string().nullable(),
  stage: z.enum(STYLE_STAGES),
  latestRound: output({ id: id(), number: z.string(), kind: z.enum(SAMPLE_KINDS), roundNo: z.number().int(), status: z.enum(BRAND_ROUND_STATUSES) }).nullable(),
  /** The earliest of an open round's due day and a waiting request's due day. */
  nextDate: businessDate().nullable(),
  waiting: z.number().int(),
  openRounds: z.number().int(),
  /** The copy to open first (current or draft, the reader's language first), and how many BRAND versions there are. */
  techPack: techPack.nullable(),
  techPacks: z.array(techPack),
})

const roundRow = output({
  id: id(),
  number: z.string(),
  kind: z.enum(SAMPLE_KINDS),
  roundNo: z.number().int(),
  label: words,
  style,
  status: z.enum(BRAND_ROUND_STATUSES),
  stage: z.enum(SAMPLE_STAGES),
  decision: z.enum(SAMPLE_DECISIONS).nullable(),
  decidedAt: instant().nullable(),
  dueDate: businessDate().nullable(),
  pieces: z.number().int(),
  shipment: shipment.nullable(),
  /** The OPEN request of the brand about this round (its decision dialog), or null. */
  waitingRequestId: id().nullable(),
  createdAt: instant(),
})

export const samplesPageContract = defineContract({
  response: {
    200: output({
      asOf: instant(),
      /** The person may answer (portal.approve, not a preview); the dialog says why not otherwise. */
      mayApprove: z.boolean(),
      /** Null: the person's role does not read the approvals (portal.approvals.view): nothing is said of them. */
      waiting: z.array(waiting).nullable(),
      styles: z.array(styleRow),
      rounds: z.array(roundRow),
      /** The brand's own private-label styles only; a round of any style the brand asked for is in `rounds`. */
      counts: output({ waiting: z.number().int().nullable(), styles: z.number().int(), rounds: z.number().int(), open: z.number().int() }),
    }),
  },
})

export const techPackDownloadContract = defineContract({
  params: input({ documentId: id() }),
  body: input({ mode: z.enum(['download', 'preview']).default('preview') }),
  response: {
    200: output({
      techPack: output({ id: id(), styleCode: z.string(), revision: z.number().int(), version: z.number().int(), language: z.string(), printed: z.string(), name: z.string() }),
      /** A GET that lives 60 seconds: `inline` opens in place, `download` saves it. */
      download: output({ mode: z.enum(['inline', 'download']), method: z.literal('GET'), url: z.string(), headers: z.record(z.string(), z.string()), expiresAt: instant() }),
    }),
  },
})
