/**
 * ads-campaign-name.ts — THE ONE CHECK OF A NEW AMAZON ADS CAMPAIGN NAME, used by every campaign builder (CC-13).
 *
 * Before this only Replicate and Claude's create-ad-campaign tool checked a name; the SP Super Wizard, Quick, Guided,
 * Single and AI Goal sent whatever they built, so an empty group name became "Campaign" twice and Amazon refused the
 * second launch. A name is refused here only for what Amazon itself refuses:
 *   - an empty name;
 *   - more than 128 characters (the limit create-ad-campaign already holds every name to);
 *   - a character this codebase has recorded Amazon refusing in names: the middle dot "·" (U+00B7), which Amazon drops
 *     into the error array for portfolio and ad-group names (`pushCampaignStructure`, ads-create.service.ts).
 * "Already used in this market" needs the database and lives with the launch checks (ads-launch-checks.service.ts);
 * `campaignNameKey` is the one comparison both use (case and outer spaces ignored, as Replicate's collision gate does).
 */

/** Amazon's longest campaign name. */
export const CAMPAIGN_NAME_MAX = 128

/** Characters this codebase has recorded Amazon refusing in an ads name, with the one to use instead. */
export const REFUSED_NAME_CHARACTERS: ReadonlyArray<{ char: string; replaceWith: string }> = [
  { char: '·', replaceWith: '-' },
]

/** The form two names are compared in: "Gale Exact" and " gale exact " are the same campaign name. */
export function campaignNameKey(name: string): string {
  return name.trim().toLowerCase()
}

/** Why Amazon would refuse this campaign name, in one sentence; null when it takes it. */
export function campaignNameProblem(name: string | null | undefined): string | null {
  const n = (name ?? '').trim()
  if (!n) return 'Every campaign needs a name.'
  if (n.length > CAMPAIGN_NAME_MAX) {
    return `"${n.slice(0, 40)}…" is ${n.length} characters long; Amazon takes at most ${CAMPAIGN_NAME_MAX}.`
  }
  for (const { char, replaceWith } of REFUSED_NAME_CHARACTERS) {
    if (n.includes(char)) return `"${n}" contains "${char}", which Amazon refuses in names; use "${replaceWith}" instead.`
  }
  return null
}

/**
 * A name Amazon takes, built from one Nexus composes: each refused character becomes its replacement (" · " → " - "),
 * and the result is cut to 128 characters. For names Nexus writes itself (AI Goal's "[AI] Goal · Auto"), never for a
 * name a person typed — that one is checked and refused with `campaignNameProblem`, so he sees what he typed.
 */
export function safeCampaignName(name: string): string {
  let out = name
  for (const { char, replaceWith } of REFUSED_NAME_CHARACTERS) {
    const escaped = char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    out = out.split(new RegExp(`\\s*${escaped}\\s*`)).join(` ${replaceWith} `)
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, CAMPAIGN_NAME_MAX).trim()
}
