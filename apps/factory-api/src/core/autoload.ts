import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Where routes live, found by folder (plan A1 §6.2), so no lane edits a central list:
 *
 *   src/platform/<name>/routes.ts   platform parts (auth, admin, outbox, numbering, links, files, …)
 *   src/modules/<name>/routes.ts    business modules (sales, product, production, inventory, shipping, …)
 *
 * A folder without a routes file of its own may group parts one level down, each with its own routes file
 * (src/platform/auth/office/routes.ts, src/platform/auth/users/routes.ts, …), so the steps of one area add folders
 * instead of editing a shared file. A folder that has a routes file is not looked into: nothing deeper is loaded.
 *
 * One function finds them for every consumer, so they cannot drift apart:
 *   - the app (`core/app.ts`) imports and registers each file, from `src/` under tsx and vitest, from `dist/` in a
 *     build (there the files are `routes.js`);
 *   - the production build (`build.mjs`) makes each file an esbuild entry point beside `src/index.ts`;
 *   - the guard (`scripts/factory/check-route-manifest.mjs`) refuses a route registered anywhere else.
 * Each routes file default-exports `defineRoutes(name, manifest, plugin)` with its entries in the `manifest.ts`
 * beside it (core/manifest.ts). Folder names add no URL prefix: paths are written in full.
 *
 * This file imports only `node:fs` and `node:path`, so the build and the guard can load it on their own.
 *
 * Why not @fastify/autoload (A1 §6.2 names it): it imports each file with Node's own loader, which under vitest
 * cannot read our TypeScript (extensionless imports, parameter properties), and it cannot see into a bundle.
 */

/** The route roots under `src/` (or `dist/`), in load order. */
export const ROUTE_ROOTS = ['platform', 'modules'] as const

const ROUTES_FILES = ['routes.ts', 'routes.js', 'routes.mjs']

/** The routes file of one folder, or null; more than one is an error. */
function routesFileIn(folder: string, shown: string): string | null {
  const found = ROUTES_FILES.map((file) => join(folder, file)).filter((path) => existsSync(path))
  if (found.length > 1) throw new Error(`${shown} has more than one routes file: ${found.join(', ')}`)
  return found[0] ?? null
}

const subfolders = (folder: string): string[] =>
  readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()

/**
 * Every routes file under `<root>/platform/*` and `<root>/modules/*` (or one level down in a group folder without its
 * own), platform first, each root and each group in name order.
 */
export function routesFiles(root: string): string[] {
  return ROUTE_ROOTS.flatMap((routeRoot) => {
    const folder = join(root, routeRoot)
    if (!existsSync(folder)) return []
    return subfolders(folder).flatMap((name) => {
      const own = routesFileIn(join(folder, name), `${routeRoot}/${name}`)
      if (own) return [own]
      return subfolders(join(folder, name)).flatMap((part) => {
        const file = routesFileIn(join(folder, name, part), `${routeRoot}/${name}/${part}`)
        return file ? [file] : []
      })
    })
  })
}
