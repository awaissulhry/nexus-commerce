import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { CORE_MANIFEST, defineManifest, entryProblems, ManifestRegistry, PUBLIC, SIGNED_IN, type RouteManifestEntry } from './manifest'

const GUARD = fileURLToPath(new URL('../../../../scripts/factory/check-route-manifest.mjs', import.meta.url))

describe('manifest entries', () => {
  it('accept the shapes the API serves', () => {
    const good: Record<string, RouteManifestEntry> = {
      'GET /health': { audiences: PUBLIC, permission: PUBLIC, scope: 'none' },
      'GET /quotes/:quoteId': { audiences: ['office', 'partner'], permission: 'quotes.view', scope: 'record' },
      'POST /quotes': { audiences: ['office'], permission: 'quotes.create', scope: 'company' },
      'POST /floor/scans': { audiences: ['floor'], permission: 'scans.record', scope: 'site' },
      'GET /portal/orders': { audiences: ['partner', 'link'], permission: 'orders.view', scope: 'party' },
      'GET /me': { audiences: ['office', 'floor'], permission: SIGNED_IN, scope: 'tenant' },
      'POST /platform/tenants': { audiences: ['platform'], permission: 'platform.tenants.create', scope: 'none' },
    }
    for (const [key, entry] of Object.entries(good)) expect(entryProblems(key, entry), key).toEqual([])
    expect(Object.keys(CORE_MANIFEST)).toEqual(['GET /health', 'GET /ready'])
  })

  it('refuse a malformed key, audience, permission or scope', () => {
    const problems = (key: string, entry: unknown) => entryProblems(key, entry as RouteManifestEntry).join(' | ')
    expect(problems('GET quotes', { audiences: PUBLIC, permission: PUBLIC, scope: 'none' })).toMatch(/is not/)
    expect(problems('HEAD /quotes', { audiences: PUBLIC, permission: PUBLIC, scope: 'none' })).toMatch(/is not/)
    expect(problems('GET /x', { audiences: PUBLIC, permission: 'quotes.view', scope: 'none' })).toMatch(/public route/)
    expect(problems('GET /x', { audiences: PUBLIC, permission: PUBLIC, scope: 'tenant' })).toMatch(/public route/)
    expect(problems('GET /x', { audiences: [], permission: 'quotes.view', scope: 'tenant' })).toMatch(/at least one/)
    expect(problems('GET /x', { audiences: ['system'], permission: 'quotes.view', scope: 'tenant' })).toMatch(/not a route audience/)
    expect(problems('GET /x', { audiences: ['office', 'office'], permission: 'quotes.view', scope: 'tenant' })).toMatch(/twice/)
    expect(problems('GET /x', { audiences: ['office'], permission: 'quotes', scope: 'tenant' })).toMatch(/<module>\.<action>/)
    expect(problems('GET /x', { audiences: ['office'], permission: 'quotes.view', scope: 'galaxy' })).toMatch(/unknown scope/)
    expect(problems('GET /x', undefined)).toMatch(/missing/)
  })

  it('refuse a scope that does not fit the audience', () => {
    const problems = (audiences: string[], scope: string) =>
      entryProblems('GET /x', { audiences, permission: 'quotes.view', scope } as unknown as RouteManifestEntry)
    expect(problems(['floor'], 'company').join()).toMatch(/scope "company" does not apply to the floor audience/)
    expect(problems(['office'], 'party').join()).toMatch(/does not apply to the office/)
    expect(problems(['partner'], 'site').join()).toMatch(/does not apply to the partner/)
    expect(problems(['office'], 'none').join()).toMatch(/does not apply to the office/)
    expect(problems(['platform'], 'tenant').join()).toMatch(/does not apply to the platform/)
  })

  it('defineManifest throws at once', () => {
    expect(() => defineManifest({ 'GET /x': { audiences: ['office'], permission: 'nope' as never, scope: 'tenant' } })).toThrow(
      /Route manifest is not valid/,
    )
  })

  it('the registry claims each route once and lists the entries left over', () => {
    const registry = new ManifestRegistry()
    registry.add('demo', {
      'GET /a': { audiences: ['office'], permission: 'demo.view', scope: 'tenant' },
      'GET /b': { audiences: ['office'], permission: 'demo.view', scope: 'tenant' },
    })
    expect(registry.claim('GET', '/a').permission).toBe('demo.view')
    expect(() => registry.claim('GET', '/a')).toThrow(/registered twice/)
    expect(() => registry.claim('POST', '/a')).toThrow(/POST \/a has no manifest entry/)
    expect(registry.unclaimed()).toEqual(['GET /b'])
  })
})

describe('scripts/factory/check-route-manifest.mjs', () => {
  const folders: string[] = []
  afterEach(() => {
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
  })

  function plant(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'factory-route-guard-'))
    folders.push(root)
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(root, path, '..'), { recursive: true })
      writeFileSync(join(root, path), content)
    }
    return root
  }
  const run = (dir?: string) => {
    const result = spawnSync(process.execPath, [GUARD, ...(dir ? [dir] : [])], { encoding: 'utf8' })
    return { status: result.status, output: `${result.stdout}${result.stderr}` }
  }

  it('passes on the API source', () => {
    const { status, output } = run()
    expect(output).toMatch(/check-route-manifest: ok/)
    expect(status).toBe(0)
  })

  it('passes on platform and module folders whose routes and manifests agree', () => {
    const dir = plant({
      'modules/quotes/manifest.ts': `export const manifest = defineManifest({
  'GET /quotes': { audiences: ['office'], permission: 'quotes.view', scope: 'record' },
  "POST /quotes/:quoteId/send": { audiences: ['office'], permission: 'quotes.send', scope: 'company' },
})`,
      'modules/quotes/routes.ts': `import { manifest } from './manifest'
// app.get('/commented-out') is not a route
export default defineRoutes('quotes', manifest, async (app) => {
  app.get('/quotes', handler)
  app.post("/quotes/:quoteId/send", { schema }, handler)
})`,
      'modules/quotes/routes.vitest.test.ts': `app.get('/only-in-a-test', handler)`,
      'platform/numbering/routes.ts': `export default defineRoutes('numbering', defineManifest({
  'POST /numbering/allocate': { audiences: ['office'], permission: 'numbering.allocate', scope: 'company' },
}), async (app) => {
  app.post('/numbering/allocate', handler)
})`,
    })
    const { status, output } = run(dir)
    expect(output).toMatch(/ok \(3 route\(s\)/)
    expect(status).toBe(0)
  })

  it('fails on planted violations, each named with its file and line', () => {
    const dir = plant({
      'modules/quotes/manifest.ts': `export const manifest = defineManifest({
  'GET /quotes': { audiences: ['office'], permission: 'quotes.view', scope: 'record' },
  'DELETE /quotes/:quoteId': { audiences: ['office'], permission: 'quotes.delete', scope: 'record' },
})`,
      'modules/quotes/routes.ts': `export default defineRoutes('quotes', manifest, async (app) => {
  app.get('/quotes', handler)
  app.post('/quotes', handler)
})`,
      'modules/loose/routes.ts': `export default async function (app) {
  app.get('/loose', handler)
}`,
      'platform/odd/routes.ts': `export default defineRoutes('odd', {}, async (app) => {
  app.get(PATH, handler)
  app.all('/everything', handler)
  app.get(\`/tpl/\${id}\`, handler)
  app.route({ method: ['GET', 'POST'], url: '/both', handler })
})`,
      'modules/quotes/extra.ts': `export const more = defineRoutes('extra', defineManifest({
  'GET /quotes/extra': { audiences: ['office'], permission: 'quotes.view', scope: 'record' },
}), async (app) => {
  app.get('/quotes/extra', handler)
})`,
      'modules/quotes/deep/routes.ts': `export default defineRoutes('deep', defineManifest({
  'GET /deep': { audiences: ['office'], permission: 'quotes.view', scope: 'record' },
}), async (app) => {
  app.get('/deep', handler)
})`,
      'services/stray/routes.ts': `export default defineRoutes('stray', defineManifest({
  'GET /stray': { audiences: ['office'], permission: 'quotes.view', scope: 'record' },
}), async (app) => {
  app.get('/stray', handler)
})`,
    })
    const { status, output } = run(dir)
    expect(status).toBe(1)
    expect(output).toContain('modules/quotes/routes.ts:3  rule 3: POST /quotes has no manifest entry')
    expect(output).toContain('modules/quotes/manifest.ts:3  rule 4: DELETE /quotes/:quoteId has a manifest entry but no route')
    expect(output).toContain('modules/loose/routes.ts:2  rule 3: a file that registers routes wraps them in defineRoutes')
    expect(output).toContain('modules/loose/routes.ts:2  rule 3: GET /loose has no manifest entry')
    expect(output).toContain('platform/odd/routes.ts:2  rule 1: app.get() needs its path as a string literal')
    expect(output).toContain("platform/odd/routes.ts:3  rule 2: app.all('/everything')")
    expect(output).toContain('platform/odd/routes.ts:4  rule 1: app.get() needs its path as a string literal')
    expect(output).toContain('platform/odd/routes.ts:5  rule 1: .route({ … }) needs method and url as string literals')
    expect(output).toContain('modules/quotes/extra.ts:4  rule 5: routes are registered only in platform/<name>/routes.ts, modules/<name>/routes.ts or core/app.ts')
    expect(output).toContain('modules/quotes/deep/routes.ts:4  rule 5')
    expect(output).toContain('services/stray/routes.ts:4  rule 5')
    expect(output).not.toContain('GET /quotes has no')
    expect(output).not.toContain('GET /quotes/extra has no')
    expect(output).toMatch(/11 violation\(s\)/)
  })
})
