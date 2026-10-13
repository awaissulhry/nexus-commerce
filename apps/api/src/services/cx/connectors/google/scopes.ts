/**
 * The Google permissions Nexus asks for at connect, in the exact long form Google echoes back in the
 * token answer's `scope` (a short form such as `email` would read as a missing permission forever).
 * Google Ads, Merchant Center and Analytics (read-only); `openid` + `userinfo.email` say who signed in.
 */
export const GOOGLE_SCOPE = {
  ads: 'https://www.googleapis.com/auth/adwords',
  merchant_center: 'https://www.googleapis.com/auth/content',
  analytics: 'https://www.googleapis.com/auth/analytics.readonly',
  openid: 'openid',
  email: 'https://www.googleapis.com/auth/userinfo.email',
} as const

export const GOOGLE_REQUIRED_SCOPES: string[] = [
  GOOGLE_SCOPE.ads,
  GOOGLE_SCOPE.merchant_center,
  GOOGLE_SCOPE.analytics,
  GOOGLE_SCOPE.openid,
  GOOGLE_SCOPE.email,
]

/** The three Google products a connection can read, each behind its own permission. */
export type GoogleProduct = 'ads' | 'merchant_center' | 'analytics'
export const GOOGLE_PRODUCTS: readonly GoogleProduct[] = ['ads', 'merchant_center', 'analytics']

/** The products whose permission the person did not tick on Google's consent screen. */
export function missingGoogleProducts(grantedScopes: readonly string[]): GoogleProduct[] {
  const granted = new Set(grantedScopes)
  return GOOGLE_PRODUCTS.filter((product) => !granted.has(GOOGLE_SCOPE[product]))
}
