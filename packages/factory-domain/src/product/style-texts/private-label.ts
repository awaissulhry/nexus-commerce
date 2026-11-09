/**
 * A private-label style (B-W2b-227; PRD-010), pure. W1's Style.brandPartyId IS the brand a style is made for (B-W2b-206
 * decision 1): set, the style is that brand's own; only that brand's partner people may see it in the portal (its
 * catalogue, sample rounds, documents, threads); the office sees every style, with the mark. Style.soldUnderOurName (Owner
 * 11-09, W2b-4 question 3) says under whose name it is sold: false (the default) the brand's own name and barcodes, true
 * ours — never true without a brand (the database refuses it too).
 *
 * Who sends the declaration of conformity follows it (question 3): a private-label style sold under the brand's name → the
 * brand; one sold under our name, or a style of our own collection → the company.
 */

export interface PrivateLabelFacts {
  readonly brandPartyId: string | null
  readonly soldUnderOurName: boolean
}

export const PRIVATE_LABEL_SHOWN_TO = ['BRAND_ONLY', 'EVERY_CUSTOMER'] as const
export type PrivateLabelShownTo = (typeof PRIVATE_LABEL_SHOWN_TO)[number]
export const DECLARATION_SENDERS = ['BRAND', 'COMPANY'] as const
export type DeclarationSender = (typeof DECLARATION_SENDERS)[number]

export const isPrivateLabel = (style: Pick<PrivateLabelFacts, 'brandPartyId'>): boolean => style.brandPartyId !== null

/** Who may see the style in the portal: its brand only, or every customer the catalogue offers it to. */
export const shownTo = (style: Pick<PrivateLabelFacts, 'brandPartyId'>): PrivateLabelShownTo => (isPrivateLabel(style) ? 'BRAND_ONLY' : 'EVERY_CUSTOMER')

/** Who sends the style's declaration of conformity (Owner 11-09 question 3). */
export const declarationSender = (style: PrivateLabelFacts): DeclarationSender => (isPrivateLabel(style) && !style.soldUnderOurName ? 'BRAND' : 'COMPANY')

/**
 * Whether a partner (a customer, a brand) may see the style: an open-range style any customer the catalogue offers it to,
 * a private-label style its brand only. The portal's catalogue applies it through sales/portal-ordering mayOffer.
 */
export const partyMaySee = (style: Pick<PrivateLabelFacts, 'brandPartyId'>, partyId: string): boolean => style.brandPartyId === null || style.brandPartyId === partyId

/** What stops a private-label setting, in words (null: none). */
export function privateLabelRefusal(code: string, next: PrivateLabelFacts): string | null {
  if (next.soldUnderOurName && next.brandPartyId === null) {
    return `Style ${code} is sold under our name only as a brand's private-label style: name the brand it is made for, or leave "sold under our name" off.`
  }
  return null
}
