/**
 * Ads fix 5d (review 7.11) — the Ad Group View's "+ Assign rule", as pure logic.
 *
 * A builder harvest rule that maps no ad group harvests across the WHOLE account. Assigning it to
 * one ad group used to add a look-only mapping entry, and the engine reads any mapping as the
 * rule's entire reach (`normalizeHarvestWire`): the rule then read search terms from that one ad
 * group only and, with nothing ticked to create, created nothing anywhere. One click narrowed an
 * account-wide rule to a rule that does nothing.
 *
 * So Assign refuses an account-wide rule and says why; the list shows it, disabled, with the same
 * reason. A rule that already maps ad groups still gains this ad group as a source of its first
 * mapping that has entries, feeding that mapping's destinations.
 */

export interface MappingBlock { groups?: Array<Record<string, unknown>> }

/** The row being assigned: the ad group and its campaign. */
export interface AssignRow {
  key: string
  adGroup: string
  campaignId: string
  campaign: string
}

/** The option shape the DS Listbox takes. */
export interface AssignOption { value: string; label: string; disabled?: boolean; title?: string; trailing?: string }

const groupsOf = (mappings: unknown): MappingBlock[] => (Array.isArray(mappings) ? (mappings as MappingBlock[]) : [])

/** True when the rule maps no ad group, which the engine reads as "every ad group in the account". */
export function isAccountWide(mappings: unknown): boolean {
  return !groupsOf(mappings).some((b) => Array.isArray(b?.groups) && b.groups.length > 0)
}

/** The sentence for a refused assignment — on the disabled option and in the notice. */
export function accountWideRefusal(ruleName: string, adGroup: string): string {
  return `“${ruleName}” harvests across the whole account, so it already reaches “${adGroup}”. Assigning it here would limit it to this one ad group, where it would create nothing. To limit where it harvests, choose its ad groups in the rule builder.`
}

export type AssignResult = { ok: true; mappings: MappingBlock[] } | { ok: false; reason: string }

/** Add `row` as a look-only source of the rule's first mapping that has entries — or refuse, with the reason. */
export function assignSource(ruleName: string, mappings: unknown, row: AssignRow): AssignResult {
  if (isAccountWide(mappings)) return { ok: false, reason: accountWideRefusal(ruleName, row.adGroup) }
  const blocks = structuredClone(groupsOf(mappings))
  const block = blocks.find((b) => Array.isArray(b.groups) && b.groups.length > 0)!
  const groups = block.groups!
  if (!groups.some((g) => String(g.id) === row.key)) {
    // A look-only SOURCE entry: this ad group starts feeding the mapping's existing destinations. Which
    // types get created stays the rule's mapping matrix — "harvest from this ad group?", not "create what, where?".
    groups.push({ id: row.key, name: row.adGroup, campaignId: row.campaignId, campaignName: row.campaign, status: 'ENABLED', adProduct: null, portfolioId: null, look: true, types: { P: false, E: false, product: false } })
  }
  return { ok: true, mappings: blocks }
}

/**
 * The "+ Assign rule" options for one row: every builder harvest rule not already mapped to it. An
 * account-wide rule is listed but disabled, with the reason, so the list never hides a rule silently.
 */
export function assignOptions(rules: Iterable<Record<string, unknown>>, row: Pick<AssignRow, 'adGroup'>, mappedHere: Set<string>): AssignOption[] {
  const out: AssignOption[] = []
  for (const r of rules) {
    const a0 = (Array.isArray(r.actions) ? r.actions[0] : null) as { type?: unknown; mappings?: unknown } | null
    const id = String(r.id)
    if (a0?.type !== 'keyword-harvesting' || mappedHere.has(id)) continue
    const label = String(r.name ?? r.id)
    out.push(isAccountWide(a0.mappings)
      ? { value: id, label, disabled: true, trailing: 'whole account', title: accountWideRefusal(label, row.adGroup) }
      : { value: id, label })
  }
  return out
}
