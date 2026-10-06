/**
 * CM-31 — what the Create Ad Group modal says about targeting.
 *
 * The modal offered Auto / Keyword / Product targeting as a choice. The choice was sent and never read: on Sponsored
 * Products the targeting type belongs to the CAMPAIGN (set when it was created), and every ad group in it follows. So
 * the modal now shows the campaign's own targeting type as read-only text, and says where it comes from. Pure.
 */

export interface AdGroupTargetingWords {
  /** The read-only value shown in the box. */
  value: string
  /** One sentence under it: where it comes from and what to do next. */
  hint: string
}

const isSp = (adProduct?: string | null, type?: string | null): boolean => {
  const p = (adProduct ?? '').toUpperCase()
  if (p) return p === 'SPONSORED_PRODUCTS'
  const t = (type ?? '').toUpperCase()
  return t === '' || t === 'SP'
}

export function adGroupTargetingWords(c: { adProduct?: string | null; type?: string | null; targetingType?: string | null } | null | undefined): AdGroupTargetingWords {
  if (!isSp(c?.adProduct, c?.type)) {
    return { value: 'Set by the campaign', hint: 'This campaign decides how its ad groups target shoppers; an ad group has no targeting choice of its own.' }
  }
  const t = (c?.targetingType ?? '').toUpperCase()
  if (t === 'AUTO') {
    return { value: 'Automatic targeting (set by the campaign)', hint: 'Amazon picks the searches and products this ad group shows on. A Sponsored Products ad group always follows its campaign’s targeting.' }
  }
  if (t === 'MANUAL') {
    return { value: 'Manual targeting (set by the campaign)', hint: 'After creating the ad group, add keywords or product targets to it. A Sponsored Products ad group always follows its campaign’s targeting.' }
  }
  return { value: 'Set by the campaign', hint: 'Amazon has not told Nexus this campaign’s targeting type yet; the ad group follows the campaign either way.' }
}
