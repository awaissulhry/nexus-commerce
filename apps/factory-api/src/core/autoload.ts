import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { isRoutesPlugin, RouteManifestError } from './manifest'

/**
 * Module routes, loaded by folder (plan A1 §6.2): every `<modulesDir>/<module>/routes.ts` (`routes.js` in a build) is
 * imported and registered, so no lane edits a central list. Each one default-exports `defineRoutes(name, manifest,
 * plugin)` (core/manifest.ts); anything else stops the boot.
 *
 *   - One level of folders, in name order. Paths are written in full: a folder name adds no prefix, so a manifest
 *     key is exactly the registered route and `scripts/factory/check-route-manifest.mjs` compares them statically.
 *   - Only `routes.*` is loaded; services, repositories, manifests and tests are imported by it, never on their own.
 *   - A missing folder means no module yet.
 *
 * Why not @fastify/autoload (A1 §6.2 names it): it imports each file with Node's own loader. Under vitest that loader
 * cannot read our TypeScript (extensionless imports, parameter properties), so a module's routes could not be tested
 * through the real loading path. This loader's `import()` runs in our own code, so vitest, tsx and the esbuild
 * bundle all load the same way.
 */

const ROUTES_FILES = ['routes.ts', 'routes.js', 'routes.mjs']

/** The routes file of each module folder, in name order. */
export function moduleRoutesFiles(modulesDir: string): string[] {
  if (!existsSync(modulesDir)) return []
  return readdirSync(modulesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .flatMap((name) => {
      const found = ROUTES_FILES.map((file) => join(modulesDir, name, file)).filter((path) => existsSync(path))
      if (found.length > 1) throw new RouteManifestError(`Module ${name} has more than one routes file: ${found.join(', ')}`)
      return found
    })
}

export async function registerModuleRoutes(app: FastifyInstance, modulesDir: string): Promise<string[]> {
  const files = moduleRoutesFiles(modulesDir)
  for (const file of files) {
    const loaded = (await import(pathToFileURL(file).href)) as { default?: unknown }
    if (!isRoutesPlugin(loaded.default)) {
      throw new RouteManifestError(`${file} must default-export defineRoutes(name, manifest, plugin)`)
    }
    await app.register(loaded.default)
  }
  return files
}
