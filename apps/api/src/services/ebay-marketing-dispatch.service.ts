/**
 * VP.0 — eBay Sell Marketing API dispatcher (the WRITE side).
 *
 * The read/sync side (Promoted Listings) lives in
 * services/marketing/ebay-marketing-api.service.ts. This is the POST side:
 * create item-price-markdown + item (volume) promotions.
 *
 * eBay grants are multi-marketplace under ONE token (ChannelConnection.marketplace
 * is null for eBay — see schema.prisma:5076), so we resolve the single active eBay
 * connection and target the market via the payload's `marketplaceId`. This is the
 * connection-aware client the E.3 markdown service + the VP.2 volume-pricing
 * publisher both route through.
 */
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { EbayAuthService } from './ebay-auth.service.js'

const API_BASE = process.env.EBAY_API_BASE ?? 'https://api.ebay.com'

export interface EbayMarketingPostResult {
  ok: boolean
  status: number
  /** eBay promotion id (read from the 201 Location header). */
  promotionId?: string
  /** eBay errorId (e.g. 429 rate-limit, 90244 not-enabled) when ok=false. */
  errorId?: number
  errorMessage?: string
  raw?: unknown
}

/**
 * POST a payload to an eBay Sell Marketing API resource — e.g.
 * '/sell/marketing/v1/item_price_markdown_promotion' (markdown) or
 * '/sell/marketing/v1/item_promotion' (volume pricing) — using the active eBay
 * ChannelConnection's OAuth token. On 201 the new promotion id is read from the
 * Location header. eBay error bodies ({ errors: [{ errorId, message }] }) are
 * surfaced instead of a bare HTTP code, so callers can branch on 90244 / 429.
 */
export async function postEbayMarketing(
  path: string,
  payload: unknown,
): Promise<EbayMarketingPostResult> {
  const conn = await prisma.channelConnection.findFirst({
    where: { channelType: 'EBAY', isActive: true },
  })
  if (!conn) {
    return { ok: false, status: 0, errorMessage: 'no active eBay connection' }
  }

  let token: string
  try {
    token = await new EbayAuthService().getValidToken(conn.id)
  } catch (e) {
    return { ok: false, status: 0, errorMessage: `token: ${(e as Error).message}` }
  }

  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
    })
  } catch (e) {
    return { ok: false, status: 0, errorMessage: `fetch: ${(e as Error).message}` }
  }

  if (res.status === 201 || res.ok) {
    const location = res.headers.get('location')
    const fromLocation = location ? location.split('/').filter(Boolean).pop() : undefined
    let body: { promotionId?: string } | null = null
    try {
      body = (await res.json()) as { promotionId?: string }
    } catch {
      /* 201 Created commonly has no body — the id is in Location */
    }
    return { ok: true, status: res.status, promotionId: fromLocation ?? body?.promotionId, raw: body }
  }

  let errBody: { errors?: Array<{ errorId?: number; message?: string }> } | null = null
  try {
    errBody = (await res.json()) as typeof errBody
  } catch {
    /* non-JSON error response */
  }
  const first = errBody?.errors?.[0]
  logger.warn('[VP.0][ebay-marketing] POST failed', {
    path,
    status: res.status,
    errorId: first?.errorId,
    message: first?.message,
  })
  return {
    ok: false,
    status: res.status,
    errorId: first?.errorId,
    errorMessage: first?.message ?? `HTTP ${res.status}`,
    raw: errBody,
  }
}
