// The factory-api typecheck (B-W2b-F52): `npm run typecheck -w @nexus/factory-api`.
//
// RULE: the same check as `tsc --noEmit -p tsconfig.json` — the same program (tsconfig.json and every file it reaches),
// the same compiler options, tsc's own diagnostics, output and exit code — within a 7 GB heap. One checker over the
// whole program needed a 16 GB heap (13.4 GB used, 15 GB of memory on 11-15; it ran out at 12 GB on 11-14).
//
// How: scripts/factory/typecheck-in-batches.mjs (op-fx11: the same engine checks factory-web). The files are read, parsed
// and bound ONCE (about 4.8 GB: most of it the generated Prisma client, which tsc parses but never checks), then checked in
// batches of whole folders, each by a fresh type checker. A folder here is a module or platform area (src/modules/<x>,
// src/platform/<x>) or a package's area (packages/<p>/src/<x>); any other file goes with its first two path segments.
//
// Exit 0 only when no batch reports a diagnostic. `-- --listFiles` also prints every file of the program, all of them
// checked: the coverage proof against `tsc --noEmit -p tsconfig.json --listFilesOnly`.
import { fileURLToPath } from 'node:url'
import { typecheckInBatches } from '../../scripts/factory/typecheck-in-batches.mjs'

typecheckInBatches({
  workspace: fileURLToPath(new URL('.', import.meta.url)),
  folderOf: (path) => (path.match(/^src\/(modules|platform)\/[^/]+/) ?? path.match(/^\.\.\/\.\.\/packages\/[^/]+\/src\/[^/]+/))?.[0] ?? null,
  // Measured 11-15 (16 batches, the heap capped at 7 GB in package.json): about 110 s and 7.7 GB of memory, against 148 s
  // and 15 GB for one tsc program.
  batchCharacters: 4_000_000,
})
