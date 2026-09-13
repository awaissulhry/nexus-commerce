/** Read-only attribution run: load the recorded pre-(d) bytes through Vite without changing workspace source. */
import fs from 'node:fs'
import path from 'node:path'
import { defineConfig } from 'vitest/config'
const root = path.resolve(import.meta.dirname, '../../../..')
const before = JSON.parse(fs.readFileSync(new URL('before.json', import.meta.url), 'utf8'))
const restored = new Set(['content-read.ts', 'attribute-resolver.ts', 'resolve-channel-field.ts', 'mapping/resolve-batch.service.ts'].map(file => `apps/api/src/services/pim/${file}`))
export default defineConfig({
  root: path.join(root, 'apps/api'),
  plugins: [{ name: 'lx6-before-d-source', enforce: 'pre', transform(code, id) {
    const file = path.relative(root, id.split('?')[0])
    return restored.has(file) ? { code: before[file].content, map: null } : undefined
  } }],
  test: { include: ['src/services/pim/content-read.vitest.test.ts', 'src/services/pim/mapping/resolve-batch.vitest.test.ts'], environment: 'node', testTimeout: 10000 },
})
