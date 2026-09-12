// Read-only audit probe. Executes the current service implementation with an
// in-memory Prisma substitute; no database, provider or application writes.
// Assertions describe defects observed on the audit date, not desired behavior.
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const require = createRequire(path.join(root, 'package.json'))
const ts = require('typescript')
function readModule(relative, imports = {}) {
  const file = path.join(root, relative)
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const module = { exports: {} }
  vm.runInNewContext(code, {
    module, exports: module.exports,
    require: name => {
      if (!(name in imports)) throw new Error(`Unexpected dependency: ${name}`)
      return imports[name]
    },
  }, { filename: file })
  return module.exports
}
const constants = readModule('apps/api/src/services/listing-wizard/product-types.constants.ts')
const { VariationsService } = readModule('apps/api/src/services/listing-wizard/variations.service.ts', {
  './product-types.constants.js': constants,
  '../ebay-category.service.js': { EbayCategoryService: class {} },
})
const plain = value => JSON.parse(JSON.stringify(value))
const makeService = (attributes, variationThemes) => new VariationsService({
  product: { findUnique: async () => ({
    id: 'audit-parent', sku: 'AUDIT', name: 'Audit fixture', isParent: true,
    children: [{ id: 'audit-child', sku: 'AUDIT-BLACK-M', variantAttributes: attributes, basePrice: 10, totalStock: 1 }],
  }) },
  categorySchema: { findFirst: async () => ({ variationThemes }) },
})

const wrapped = { themes: ['COLOR/SIZE'] }
const service = makeService({ color: 'Black', size: 'M' }, wrapped)
const single = await service.getVariationsPayload({ productId: 'audit-parent', selectedTheme: 'COLOR/SIZE', cachedThemes: wrapped })
assert.deepEqual(plain(single.themes), [])
const multi = await service.getMultiChannelVariationsPayload({
  productId: 'audit-parent', channels: [{ platform: 'AMAZON', marketplace: 'DE' }],
  productTypeByChannel: { 'AMAZON:DE': 'OUTERWEAR' }, selectedThemeByChannel: { 'AMAZON:DE': 'COLOR/SIZE' },
})
assert.ok(multi.themesByChannel['AMAZON:DE'].some(t => t.id === 'SIZE_COLOR'))
assert.ok(!multi.themesByChannel['AMAZON:DE'].some(t => t.id === 'COLOR/SIZE'))
const slash = await service.getVariationsPayload({ productId: 'audit-parent', selectedTheme: 'COLOR/SIZE', cachedThemes: ['COLOR/SIZE'] })
assert.deepEqual(plain(slash.children[0].missingAttributes), ['color/size'])
const local = await makeService({ Colore: 'Nero', Taglia: 'M' }, []).getVariationsPayload({ productId: 'audit-parent', selectedTheme: 'SIZE_COLOR', cachedThemes: ['SIZE_COLOR'] })
assert.deepEqual(plain(local.children[0].missingAttributes), ['size', 'color'])
console.log(JSON.stringify({
  auditDate: '2026-09-11', scope: 'Synthetic in-memory fixtures executing current VariationsService; no provider calls',
  cacheObjectIgnored: { input: wrapped, returnedThemes: single.themes },
  bundledFallbackReplacesCache: { returnedThemes: multi.themesByChannel['AMAZON:DE'].map(t => t.id), selectedTheme: multi.selectedThemeByChannel['AMAZON:DE'], missing: multi.children[0].missingByChannel },
  slashThemeIncorrectlyParsed: { input: { color: 'Black', size: 'M' }, missing: slash.children[0].missingAttributes },
  localizedAxesNotCanonicalized: { input: { Colore: 'Nero', Taglia: 'M' }, missing: local.children[0].missingAttributes },
}, null, 2))
