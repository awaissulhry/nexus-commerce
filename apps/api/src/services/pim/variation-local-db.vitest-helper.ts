/**
 * 🔴 VT.F — the guard every DB-backed VT test arm runs BEFORE it queries.
 *
 * ## The hazard, measured 2026-09-13 (`scripts/_vtf-env-which-db.mjs`, env read only, no connection)
 *
 * `apps/api/src/env.ts` loads dotenv NON-OVERRIDING, twice: `config()` (the process CWD's `.env`) and then
 * the repo-root `.env`. First wins. So the answer to "which database does this process talk to" is decided
 * by the CWD:
 *
 *     cwd = apps/api    (how `:8091` is started)          → 127.0.0.1:55439   (local Docker)
 *     cwd = repo root   (how every lane runs vitest)      → ep-purple-river-altf6t3y-pooler…neon.tech
 *
 * The second line is **Neon production**. `npx vitest run --root apps/api <file>` from the repo root — the
 * command in every VT lane's gate table — resolves `DATABASE_URL` to prod, so any DB-backed arm measures
 * prod while its author believes it measures local Docker. On this machine the connection FAILED and the
 * arms went red with "no database", which is luck (the Neon credential in git history is pending rotation),
 * not design.
 *
 * That is `reference_which_database_is_this_api_on` from the other end: both databases have held the same
 * row counts, and only the server can say which one answered — so a suite must not be allowed to answer at
 * all unless the target is provably local.
 *
 * ## Why a URL check here, when the banked rule says DISCRIMINATE and never infer
 *
 * Because this check only ever REFUSES. A URL is a weak confirmation ("this says local, therefore it is")
 * and a strong refusal ("this does not say local, so I will not connect and find out"). Over-caution is the
 * only error it can make. Once past it, the arms take the server's own `current_database()` as the
 * discriminator, which is the rule unchanged.
 */

/** Hosts a VT test arm may query. Anything else is refused before a connection is opened. */
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

export interface LocalDatabaseVerdict {
  ok: boolean
  /** The sentence a refusing arm prints. Empty when `ok`. */
  reason: string
  host: string
  database: string
}

/**
 * Is this URL a local database? Opens nothing.
 *
 * 🔴 NO default value. A `= process.env.DATABASE_URL` default made `localDatabaseVerdict(undefined)` read the
 * live environment, so the arm meant to prove "an absent URL is not local" passed for the wrong reason on a
 * machine that HAS one — a test that could not fail. The caller states the URL.
 */
export function localDatabaseVerdict(url: string | undefined): LocalDatabaseVerdict {
  if (!url) return { ok: false, reason: 'DATABASE_URL is not set, so this arm has no database to measure.', host: '', database: '' }
  let parsed: URL
  try { parsed = new URL(url) } catch {
    return { ok: false, reason: 'DATABASE_URL does not parse as a URL, so which database it names cannot be established.', host: '', database: '' }
  }
  const host = parsed.hostname
  const database = parsed.pathname.replace(/^\//, '')
  if (!LOCAL_HOSTS.has(host)) {
    return {
      ok: false,
      host,
      database,
      reason:
        `REFUSED: DATABASE_URL points at "${host}" (database "${database}"), which is not a local host. ` +
        `This suite only ever measures the local Docker database. Run it with the API's own env — ` +
        `\`(cd apps/api && npx vitest run --root . <file>)\` — or pass DATABASE_URL explicitly. ` +
        `apps/api/src/env.ts loads dotenv non-overriding, so the repo-root .env (Neon prod) wins whenever the CWD is the repo root.`,
    }
  }
  return { ok: true, reason: '', host, database }
}
