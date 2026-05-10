/**
 * MC.13.2 — CDN format conversion + quality defaults.
 *
 * One canonical place for the q_/f_ pair that every Cloudinary-derived
 * URL builder injects (channel variants, brand watermarks, image
 * templates). Centralising the choice lets the operator dial bandwidth
 * up or down workspace-wide without hunting through builder code.
 *
 * Profiles map to Cloudinary's named quality tiers:
 *   eco       — q_auto:eco / f_auto      (smallest payload)
 *   balanced  — q_auto / f_auto          (default; matches pre-13.2)
 *   hd        — q_auto:good / f_auto     (premium store fronts)
 *   lossless  — q_100 / f_auto           (proof / archival rendering)
 *
 * f_auto is kept across the board — Cloudinary picks AVIF/WebP/JPEG
 * per request based on Accept headers, which always beats hand-pinning
 * a single output format.
 *
 * Default is env-driven (MC_CDN_DEFAULT_PROFILE). Per-asset overrides
 * arrive through the optional `profile` argument.
 */

export type DeliveryProfileId = 'eco' | 'balanced' | 'hd' | 'lossless'

const PROFILE_TOKENS: Record<DeliveryProfileId, string[]> = {
  eco: ['q_auto:eco', 'f_auto'],
  balanced: ['q_auto', 'f_auto'],
  hd: ['q_auto:good', 'f_auto'],
  lossless: ['q_100', 'f_auto'],
}

export const DELIVERY_PROFILES: Array<{
  id: DeliveryProfileId
  label: string
  description: string
}> = [
  {
    id: 'eco',
    label: 'Eco',
    description:
      'Smallest payload (q_auto:eco). Right for high-traffic listing thumbnails.',
  },
  {
    id: 'balanced',
    label: 'Balanced',
    description:
      'Default. Cloudinary auto-quality + auto-format — best size/quality tradeoff.',
  },
  {
    id: 'hd',
    label: 'HD',
    description:
      'Premium quality (q_auto:good). Right for store front + A+ Content hero modules.',
  },
  {
    id: 'lossless',
    label: 'Lossless',
    description:
      'q_100 — proof / archival usage. Avoid for public-facing channels (slow + huge).',
  },
]

export function defaultProfile(): DeliveryProfileId {
  const env = (process.env.MC_CDN_DEFAULT_PROFILE ?? '').trim() as DeliveryProfileId
  if (env === 'eco' || env === 'balanced' || env === 'hd' || env === 'lossless')
    return env
  return 'balanced'
}

export function profileTokens(profile?: DeliveryProfileId): string[] {
  const id = profile ?? defaultProfile()
  return PROFILE_TOKENS[id]
}
