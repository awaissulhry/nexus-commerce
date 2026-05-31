/**
 * Tolerant boolean env-flag parsing.
 *
 * Strict `process.env.X === '1'` checks silently fail when an operator sets the
 * flag to a reasonable-but-different truthy value (`true`, `TRUE`, `yes`, `on`,
 * or `1 ` with a stray space/newline from a dashboard paste). That exact trap
 * froze the NEXUS_ENABLE_AMAZON_ADS_CRON block — the flag was "on" but not the
 * literal string '1'. Use this everywhere a human sets a gate.
 */
const TRUE_SET = new Set(['1', 'true', 'yes', 'on', 'y', 't', 'enabled'])
const FALSE_SET = new Set(['0', 'false', 'no', 'off', 'n', 'f', 'disabled', ''])

/**
 * @param name env var name
 * @param defaultOn value when the var is unset/empty (default false = opt-in)
 */
export function envEnabled(name: string, defaultOn = false): boolean {
  const raw = process.env[name]
  if (raw == null) return defaultOn
  const v = raw.trim().toLowerCase()
  if (TRUE_SET.has(v)) return true
  if (FALSE_SET.has(v)) return false
  return defaultOn // unrecognised → fall back to the documented default
}
