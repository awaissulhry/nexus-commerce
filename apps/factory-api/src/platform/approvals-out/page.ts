import { isAnswered, KIND_RULES, type ApprovalKind, type ApprovalLocale, type ApprovalStatus } from '@nexus/factory-domain/approvals-out/kinds'
import { COUNTER_OFFER_RECORD } from '@nexus/factory-domain/approvals-out/kinds' // F-PR-16
import { answerHeld, decidedForPartyPageWords, decidedForPartyWords, decidedWords, reversedWords, withReversalWords } from '@nexus/factory-domain/approvals-out/rules'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { CommandCaller } from '../../core/command'
import { sameWords, type ApprovalContent } from './adapter'
import { adapterOf } from './records'
import { filesOf, refOf, type PartnerRow } from './store'
import { partnerRefsOf } from '../portal/tasks/partner-label' // F-PR-16

/**
 * What a partner reads of one request (B-W2b-184; design links.approve: what we ask, the kind's own panel — revised order
 * old → new, design proof, concession, sample/colour/leather/artwork —, your decision, decided), the same for the APPROVAL
 * link and the portal. The request itself is read in the session's own scope (the partner role reads its party's requests);
 * the record's content, the request's files and the sender's name in the tenant's system scope after that (the partner role
 * reads neither an amendment nor an NCR): only what the adapter chose to show, never a cost, a margin or an office person.
 * Prices only on a revised order (the contract's price grain: the link's, or the portal person's).
 *
 * B-PR-30a/30b: a request we decided FOR the party reads "Decided by us for you: <why>" (`decided`, `decidedForYou`), signed with
 * our company's name — never who of us (the typed name of the office person stays the office's); an answer we put back reads
 * "Put back by us: <why>" after it (`reversed`), the answer itself kept as it was.
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
    // ---- F-PR-16 (B-TH-303's rule, the same as the party's tasks: platform/portal/tasks/partner-label.ts): the party reads its own
    // order and quote numbers ("#12 · revision 2"), never the office's shared series — in the record's words, the facts, the revised
    // order and why it is held. Only this request's party's rows are read. The office's reads (office.ts) keep the office's numbers.
    const refs = await partnerRefsOf(client, row.partyId, [{ type: row.recordType, id: row.recordId }], row.recordType === COUNTER_OFFER_RECORD ? [row.recordId] : [])
    const label = record?.label ?? sameWords('')
    return {
      label: { it: refs.own(label.it), en: refs.own(label.en) },
      content: { facts: content.facts.map((fact) => ({ ...fact, value: refs.own(fact.value) })), revisedOrder: content.revisedOrder ? { ...content.revisedOrder, orderNumber: refs.own(content.revisedOrder.orderNumber) } : null },
      company,
      files,
      recordHeld: recordHeld === null ? null : refs.own(recordHeld),
    }
    // ---- end F-PR-16
  })
  const held = answerHeld({ status, dueAt: row.dueAt, answeredAt: row.answeredAt, withdrawnAt: row.withdrawnAt }, now, locale) ?? facts.recordHeld
  const order = facts.content.revisedOrder
  // B-PR-30a/30b: our decision for the party, and a reversal, in the party's words (never who of us).
  const forParty = row.decidedForPartyReason
  const companyName = facts.company?.tradeName ?? facts.company?.legalName ?? ''
  const decidedText = isAnswered(status) ? (forParty !== null ? decidedForPartyPageWords(kind, status, forParty, locale) : decidedWords(kind, status, row.typedName, row.answeredAt, locale)) : null
  return {
    request: {
      id: row.id,
      kind,
      // B-W2b-F16: the record's label in both languages; `label` (English) stays while B-W2b-187's pop-up reads it.
      words: facts.label,
      label: facts.label.en,
      question: row.question,
      from: { companyName },
      dueAt: toUtcIso(row.dueAt),
      status,
      decided: decidedText === null ? null : withReversalWords(decidedText, row.reversedAt ? row.reverseReason : null, locale),
      answer: row.answeredAt ? { at: toUtcIso(row.answeredAt), typedName: forParty !== null ? companyName : (row.typedName ?? ''), words: row.answer, markupFileId: row.markupFileId } : null,
      decidedForYou: forParty !== null && isAnswered(status) ? decidedForPartyWords(forParty, locale) : null,
      reversed: row.reversedAt && row.reverseReason ? { at: toUtcIso(row.reversedAt), words: reversedWords(row.reverseReason, locale) } : null,
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

