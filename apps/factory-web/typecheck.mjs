// The factory-web typecheck (op-fx11): `npm run typecheck -w @nexus/factory-web` runs `next typegen` (the route types under
// .next/types) and then this.
//
// RULE: the same check as `tsc --noEmit -p tsconfig.json` — the same program (tsconfig.json and every file it reaches: src,
// the route types, factory-domain and the design system's sources), the same compiler options (strict, noUnused*, …), tsc's
// own diagnostics, output and exit code — within a heap capped in package.json. One checker over the whole program used
// 12.1 GB of heap on 11-19 (9,777 files, 1.4 million lines of TypeScript, 5.9 million types) and ran out at the end check's
// 12 GB on GitHub (run 44612700044, exit 134).
//
// How: scripts/factory/typecheck-in-batches.mjs, as factory-api (B-W2b-F52). The files are read, parsed and bound ONCE, then
// checked in batches of whole folders, each by a fresh type checker. A folder here is an area of the app (src/<part>/<area>:
// src/areas/sales, src/portal/customer, src/floor/tasks, src/lib/record-thread, …) or a package's area (packages/<p>/src/<x>);
// any other file goes with its first two path segments.
//
// Exit 0 only when no batch reports a diagnostic. `-- --listFiles` also prints every file of the program, all of them
// checked: the coverage proof against `tsc --noEmit -p tsconfig.json --listFilesOnly`.
import { fileURLToPath } from 'node:url'
import { typecheckInBatches } from '../../scripts/factory/typecheck-in-batches.mjs'

typecheckInBatches({
  workspace: fileURLToPath(new URL('.', import.meta.url)),
  folderOf: (path) => (path.match(/^src\/[^/]+\/[^/]+(?=\/)/) ?? path.match(/^\.\.\/\.\.\/packages\/[^/]+\/src\/[^/]+/))?.[0] ?? null,
  batchCharacters: 4_000_000,
})
