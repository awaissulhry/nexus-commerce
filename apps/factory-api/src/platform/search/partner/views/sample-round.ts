import { roundLabel, type SampleKind } from '@nexus/factory-domain/sales/samples/rules'
import { definePartnerView, equalsTyped, idsOf } from '../view'

/**
 * A customer's sample rounds (B-TH-073; threads plan TH-5, PROJ-G16, wall tests T09 and T12; modules/sales/samples; the office
 * index's ../../indexers/sample-round.ts): every round made FOR its party (SampleRound.partyId), read in the PARTNER scope (the
 * party's row-level security and column grants of factory-db samples.json: never the instructions, who decided or who made it;
 * an internal round — no customer — is not the party's and is never read here, even on its own private-label style). The brand
 * discusses ONE round in the portal on its thread (platform/threads/partner; the round's thread is shared with the round's
 * customer only, records.ts): our round number, the kind and round in words under it ("Fit · round 2"), the stage, when it was
 * asked. Never the charge (a price), never the style's own words (a round names the style only through the style's own partner
 * view, ./style.ts, which opens only the party's private label: so a round never names another brand's style, T12). The portal
 * search's Samples group finds it by its number or its kind and round in either language.
 */
export default definePartnerView({
  recordType: 'SampleRound',
  group: 'samples',
  kinds: ['CUSTOMER'],
  async read(client, ids) {
    const rows = await client.sampleRound.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, companyId: true, number: true, kind: true, roundNo: true, stage: true, createdAt: true },
    })
    return rows.map((row) => ({
      id: row.id,
      companyId: row.companyId,
      theirRef: null,
      ourRef: row.number,
      subtitle: roundLabel(row.kind as SampleKind, row.roundNo, 'en'),
      status: row.stage,
      date: row.createdAt,
      words: [roundLabel(row.kind as SampleKind, row.roundNo, 'it')],
    }))
  },
  async lookup(client, typed, take) {
    return idsOf(await client.sampleRound.findMany({ where: { number: equalsTyped(typed) }, select: { id: true }, orderBy: { createdAt: 'desc' }, take }))
  },
})
