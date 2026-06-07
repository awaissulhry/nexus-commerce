/**
 * Shared Amazon SP-API client factory (FFS.2).
 *
 * The flat-file route + buy-shipping each define their own local getSpClient;
 * the new feed-reconcile service + poll cron use this shared copy instead of
 * adding a third. Same env-based config (region/refresh-token/LWA creds) and the
 * amazon-sp-api auto-throttle options.
 */

export function getAmazonSellerId(): string {
  return process.env.AMAZON_SELLER_ID ?? process.env.AMAZON_MERCHANT_ID ?? ''
}

export function amazonCredsConfigured(): boolean {
  return Boolean(
    process.env.AMAZON_REFRESH_TOKEN &&
      process.env.AMAZON_LWA_CLIENT_ID &&
      process.env.AMAZON_LWA_CLIENT_SECRET,
  )
}

export async function getAmazonSpClient(): Promise<any> {
  const refreshToken = process.env.AMAZON_REFRESH_TOKEN
  const lwaClientId = process.env.AMAZON_LWA_CLIENT_ID
  const lwaClientSecret = process.env.AMAZON_LWA_CLIENT_SECRET
  if (!refreshToken || !lwaClientId || !lwaClientSecret) {
    throw new Error('Amazon SP-API credentials not configured')
  }
  const { SellingPartner } = await import('amazon-sp-api')
  return new (SellingPartner as any)({
    region: (process.env.AMAZON_REGION ?? 'eu') as any,
    refresh_token: refreshToken,
    credentials: {
      SELLING_PARTNER_APP_CLIENT_ID: lwaClientId,
      SELLING_PARTNER_APP_CLIENT_SECRET: lwaClientSecret,
    },
    options: { auto_request_tokens: true, auto_request_throttled: true },
  })
}
