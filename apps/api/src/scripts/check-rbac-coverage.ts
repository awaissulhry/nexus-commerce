/**
 * Phase S2 (RBAC engine) — deny-by-default coverage gate.
 *
 * Boots the real Fastify app (registration only — no listen, no crons),
 * enumerates EVERY registered route, and asserts each resolves to a
 * permission (or PUBLIC) in the manifest. A single unmapped route fails
 * the build — that is what makes "deny by default" a proven invariant
 * rather than a hope: a new endpoint is invisible until it's mapped.
 *
 * Run:  npx tsx apps/api/src/scripts/check-rbac-coverage.ts
 */

process.env.RBAC_COVERAGE = '1' // ensure index.ts does not start() / listen

async function main(): Promise<void> {
  const { app, REGISTERED_ROUTES } = await import('../index.js')
  const { permissionForRoute } = await import('../lib/auth/permissions-manifest.js')

  await app.ready()

  // HEAD is auto-added alongside GET (same perm); OPTIONS is CORS preflight,
  // always allowed by the hook's early return — neither is gated.
  const seen = new Set<string>()
  const routes = REGISTERED_ROUTES.filter((r) => {
    if (r.method === 'HEAD' || r.method === 'OPTIONS') return false
    const k = `${r.method} ${r.url}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })

  const unmapped: { method: string; url: string }[] = []
  let publicCount = 0
  const byPerm = new Map<string, number>()

  for (const r of routes) {
    const perm = permissionForRoute(r.method, r.url)
    if (perm === null) unmapped.push(r)
    else if (perm === 'PUBLIC') publicCount++
    else byPerm.set(perm, (byPerm.get(perm) ?? 0) + 1)
  }

  await app.close()

  console.log(
    `\nRBAC coverage: ${routes.length} routes · ${byPerm.size} distinct permissions · ${publicCount} PUBLIC · ${unmapped.length} UNMAPPED`,
  )

  if (unmapped.length > 0) {
    console.error(`\n✗ ${unmapped.length} route(s) have NO permission mapping (deny-by-default violation).`)
    console.error('  Add a rule to apps/api/src/lib/auth/permissions-manifest.ts for each:\n')
    for (const r of unmapped.slice(0, 200)) console.error(`  ${r.method.padEnd(6)} ${r.url}`)
    if (unmapped.length > 200) console.error(`  … and ${unmapped.length - 200} more`)
    process.exit(1)
  }

  console.log('✓ Every registered route resolves to a permission. Deny-by-default holds.\n')
  process.exit(0)
}

main().catch((err) => {
  console.error('rbac-coverage check crashed:', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
