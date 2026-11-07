import { isAnswered, KIND_RULES, type ApprovalKind, type ApprovalLocale, type ApprovalStatus } from '@nexus/factory-domain/approvals-out/kinds'
import { answerHeld, decidedWords, dueWords, stateWords } from '@nexus/factory-domain/approvals-out/rules'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { CommandCaller } from '../../core/command'
import type { ApprovalContent } from './adapter'
import { adapterOf } from './records'
import { filesOf, refOf, type PartnerRow } from './store'

/**
 * What a partner reads of one request (B-W2b-184; design links.approve: what we ask, the kind's own panel — revised order
 * old → new, design proof, concession, sample/colour/leather/artwork —, your decision, decided), the same for the APPROVAL
 * link and the portal. The request itself is read in the session's own scope (the partner role reads its party's requests);
 * the record's content, the request's files and the sender's name in the tenant's system scope after that (the partner role
 * reads neither an amendment nor an NCR): only what the adapter chose to show, never a cost, a margin or an office person.
 * Prices only on a revised order (the contract's price grain: the link's, or the portal person's).
 */

export async function partnerPage(system: CommandCaller, row: PartnerRow, locale: ApprovalLocale, now: Date) {
  const kind = row.kind as ApprovalKind
  const status = row.status as ApprovalStatus
  const adapter = adapterOf(kind, row.recordType)
  const ref = refOf(row)
  const facts = await system.withClient(async (client) => {
    const record = adapter ? await adapter.read(client, row.recordId, kind, { partyId: row.partyId, now }) : null
    const content: ApprovalContent = adapter ? await adapter.content(client, ref, locale) : { facts: [], revisedOrder: null }
    const company = await client.company.findUnique({ where: { id: row.companyId }, select: { legalName: true, tradeName: true } })
    const files = await filesOf(client, row.id)
    const recordHeld = status === 'OPEN' && adapter?.answerHeld ? await adapter.answerHeld(client, ref, locale) : null
    return { label: record?.label ?? '', content, company, files, recordHeld }
  })
  const held = answerHeld({ status, dueAt: row.dueAt, answeredAt: row.answeredAt, withdrawnAt: row.withdrawnAt }, now, locale) ?? facts.recordHeld
  const order = facts.content.revisedOrder
  return {
    request: {
      id: row.id,
      kind,
      kindName: KIND_RULES[kind].name[locale],
      label: facts.label,
      question: row.question,
      from: { companyName: facts.company?.tradeName ?? facts.company?.legalName ?? '' },
      dueAt: toUtcIso(row.dueAt),
      dueWords: dueWords(row.dueAt, locale),
      status,
      stateWords: stateWords(status, locale),
      decided: isAnswered(status) ? decidedWords(kind, status, row.typedName, row.answeredAt, locale) : null,
      answer: row.answeredAt ? { at: toUtcIso(row.answeredAt), typedName: row.typedName ?? '', words: row.answer, markupFileId: row.markupFileId } : null,
      version: row.version,
    },
    content: {
      facts: facts.content.facts.map((fact) => ({ ...fact })),
      revisedOrder: order
        ? {
            orderNumber: order.orderNumber,
            revision: order.revision,
            reason: order.reason,
            currency: order.currency,
            lines: order.diff.lines.map((line) => ({
              change: line.change,
              lineId: line.lineId,
              seq: line.seq,
              style: order.styles[line.styleId] ?? { code: '', name: '' },
              colour: order.colourways[line.colourwayId] ?? { code: '', name: '' },
              piecesBefore: line.piecesBefore,
              piecesAfter: line.piecesAfter,
              sizes: line.sizes.map((size) => ({ ...size })),
              priceChanged: line.priceChanged,
            })),
            header: order.diff.header.map((entry) => ({ ...entry })),
            prices: order.diff.prices,
            netAmountBefore: order.diff.netAmountBefore,
            netAmountAfter: order.diff.netAmountAfter,
            grossAmountBefore: order.diff.grossAmountBefore,
            grossAmountAfter: order.diff.grossAmountAfter,
          }
        : null,
    },
    files: facts.files.map((file) => ({ id: file.id, originalName: file.originalName, contentType: file.contentType, sizeBytes: file.sizeBytes })),
    /** What the person may answer now; `held` says why not (answered, withdrawn, past due, the record moved on). */
    may: { answer: held === null, withChanges: held === null && KIND_RULES[kind].withChanges, held },
    locale,
  }
}

