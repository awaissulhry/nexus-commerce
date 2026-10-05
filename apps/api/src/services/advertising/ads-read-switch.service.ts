/**
 * Ads wave 4a + 4d — the per-account "Read this market's data" switch, and the one answer to "what does Nexus do with
 * this Amazon Ads account?" that the screens show.
 *
 * ## What the three fields of an `AmazonAdsConnection` row really do (read in code, 2026-10-05)
 *
 *   isActive         Whether Nexus READS the account. Every read job selects rows `isActive: true`: the daily reports,
 *                    the v1 export sync, metrics, portfolios, budget usage, top-of-search share, keyword lists, the
 *                    rule evaluator's market list, and (with this change) the campaign-settings sweep. Those calls go to
 *                    Amazon's REAL host with the real profile id.
 *   mode             'sandbox' | 'production' — the operator's permission to SPEND (POST …/connection/set-mode). It does
 *                    NOT choose Amazon's sandbox host: the host is chosen once for the whole deploy by
 *                    `NEXUS_AMAZON_ADS_MODE` (ads-api-client.ts `adsMode()`; gateway channels.ts `publishModeOf`), never
 *                    per row. A 'sandbox' row makes the write gate refuse every write (ads-write-gate.ts, deniedAt
 *                    'connection'), and the few production-only reads (brand metrics, the AMS subscription check) skip it.
 *   writesEnabledAt  The second permission to spend (the two-step Enable writes). Null = the gate refuses.
 *
 * So reading an account's real data needs `isActive` and nothing else. This switch writes `isActive` ONLY: `mode`,
 * `writesEnabledAt` and the campaign allowlist stay exactly as they were, so a "reading only" account can never spend.
 *
 * Stopping is refused while writes are on: the engines would keep writing to an account whose numbers Nexus no longer
 * reads. Turn writes off first (Disable writes), then stop reading.
 */
import { workspaceKey } from '@nexus/database/workspace-context'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'

export type AdsAccountState = 'live_writes_on' | 'reading_only' | 'not_read'

/** The words every screen uses for the three states. */
export const ADS_ACCOUNT_STATE_LABEL: Readonly<Record<AdsAccountState, string>> = Object.freeze({
  live_writes_on: 'Live · writes on',
  reading_only: 'Reading only',
  not_read: 'Not read',
})

interface StateFields {
  isActive: boolean
  mode: string
  writesEnabledAt: Date | string | null
}

/**
 * The state of one account, from its row. No row means no job reads the profile: "Not read".
 * "Live · writes on" needs reading AND both permissions; anything else that is read is "Reading only".
 */
export function adsAccountStateOf(row: StateFields | null | undefined): AdsAccountState {
  if (!row || !row.isActive) return 'not_read'
  return row.mode === 'production' && row.writesEnabledAt != null ? 'live_writes_on' : 'reading_only'
}

/** Every account of this business, by Amazon profile id. Accounts without a row are absent (= "Not read"). */
export async function adsAccountStatesByProfile(): Promise<Map<string, AdsAccountState>> {
  const rows = await prisma.amazonAdsConnection.findMany({
    select: { profileId: true, isActive: true, mode: true, writesEnabledAt: true },
  })
  return new Map(rows.map((r) => [r.profileId, adsAccountStateOf(r)]))
}

export interface ReadSwitchConnection {
  profileId: string
  marketplace: string
  isActive: boolean
  mode: string
  writesEnabledAt: Date | null
  state: AdsAccountState
}

export type ReadSwitchResult =
  | { ok: true; changed: boolean; connection: ReadSwitchConnection }
  | { ok: false; status: 400 | 404 | 409; error: string; message: string }

/**
 * Switch reading on or off for one account. Writes `isActive` and nothing else.
 *
 * Idempotent: asking for the state the account is already in changes nothing and answers `changed: false`.
 */
export async function setAdsProfileReading(input: { profileId?: unknown; isActive?: unknown }, actor: string): Promise<ReadSwitchResult> {
  const profileId = typeof input.profileId === 'string' ? input.profileId.trim() : ''
  if (!profileId || typeof input.isActive !== 'boolean') {
    return { ok: false, status: 400, error: 'invalid_request', message: 'Send profileId (text) and isActive (true or false).' }
  }
  const want = input.isActive
  const where = { workspace_profileId: workspaceKey({ profileId }) }
  const select = { profileId: true, marketplace: true, isActive: true, mode: true, writesEnabledAt: true } as const

  const existing = await prisma.amazonAdsConnection.findUnique({ where, select })
  if (!existing) {
    return { ok: false, status: 404, error: 'connection_not_found', message: 'This Amazon Ads account is not known to Nexus.' }
  }
  if (!want && existing.writesEnabledAt != null) {
    return {
      ok: false,
      status: 409,
      error: 'writes_enabled',
      message: `Writes are on for ${existing.marketplace}. Turn writes off first (Disable writes), then stop reading.`,
    }
  }
  if (existing.isActive === want) {
    return { ok: true, changed: false, connection: { ...existing, state: adsAccountStateOf(existing) } }
  }

  // `isActive` only. mode, writesEnabledAt and the campaign allowlist are the operator's permission to spend and are
  // never touched here — reading cannot turn into spending through this switch.
  const conn = await prisma.amazonAdsConnection.update({ where, data: { isActive: want }, select })
  logger.warn('[ADS-CONNECTION-SET-ACTIVE]', {
    profileId: conn.profileId,
    marketplace: conn.marketplace,
    from: existing.isActive,
    to: conn.isActive,
    mode: conn.mode,
    writesOn: conn.writesEnabledAt != null,
    actor,
  })
  return { ok: true, changed: true, connection: { ...conn, state: adsAccountStateOf(conn) } }
}
