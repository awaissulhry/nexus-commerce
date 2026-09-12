import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const output = mkdtempSync(path.join(tmpdir(), 'nexus-database-build-'))
try {
  execFileSync(path.resolve(root, '../../node_modules/.bin/tsc'), ['-p', path.join(root, 'tsconfig.json'), '--noEmit', 'false', '--sourceMap', 'false', '--declarationMap', 'false', '--outDir', output], { stdio: 'inherit' })
  for (const name of readdirSync(output)) {
    if (name.endsWith('.js') || name.endsWith('.d.ts')) copyFileSync(path.join(output, name), path.join(root, name))
  }
} finally { rmSync(output, { recursive: true, force: true }) }
