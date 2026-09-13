import { build } from 'esbuild'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
const root = process.cwd(), outfile = 'docs/audits/2026-09-12-language-axis/step7/runtime.mjs'
const result = await build({ stdin: { contents: `
export { default as prisma } from './apps/api/src/db.ts';
export { default as products } from './apps/api/src/routes/products.routes.ts';
export { default as marketplaces } from './apps/api/src/routes/marketplaces.routes.ts';
export { default as connections } from './apps/api/src/routes/connections.routes.ts';
export { default as savedViews } from './apps/api/src/routes/saved-view-persistence.routes.ts';
export { default as productsCatalog } from './apps/api/src/routes/products-catalog.routes.ts';
export { default as pim } from './apps/api/src/routes/pim.routes.ts';
export { default as categories } from './apps/api/src/routes/categories.routes.ts';
export { default as studio } from './apps/api/src/routes/product-studio.routes.ts';
export { default as formulas } from './apps/api/src/routes/cell-formula.routes.ts';
export { default as global } from './apps/api/src/routes/pim-global.routes.ts';
export { productAiDraftRoutes as productsAi } from './apps/api/src/routes/product-enrichment.routes.ts';
export { default as catalogue } from './apps/api/src/routes/catalog-transfer.routes.ts';
export { getStudioSheet } from './apps/api/src/services/pim/studio-sheet.service.ts';
export { clearStudioColumnCache } from './apps/api/src/services/pim/studio-columns.ts';
export { previewCatalogTranslation, applyCatalogTranslationDrafts, revertCatalogTranslation } from './apps/api/src/services/pim/catalog-translate.ts';
export { catalogLanguageValues, restrictCatalogLanguage, orderCatalogLanguage } from './apps/api/src/services/pim/catalog-language.ts';
export { listingReadiness } from './apps/api/src/services/pim/listing-readiness.service.ts';
export { loadTransferContext, applyTransferTarget } from './apps/api/src/services/pim/catalog-transfer.service.ts';
export { buildTransferPlan, transferContracts } from './apps/api/src/services/pim/catalog-transfer-plan.ts';
export { writeCatalogWorkbook, readCatalogWorkbook } from './apps/api/src/services/pim/catalog-workbook.ts';
export { exportCatalogTransfer } from './apps/api/src/services/pim/catalog-transfer-export.ts';
export { resolvePublishContent, publishReviewIssues, buildAmazonContentAttributes } from './apps/api/src/services/pim/amazon-content-payload.ts';
export { writeContent } from './apps/api/src/services/pim/content-write.ts';
export { inDatabaseTransaction, captureDatabaseContext } from './apps/api/src/lib/database-context.ts';
export { withCachedSchemas } from './apps/api/src/services/pim/cached-schema-context.ts';
`, resolveDir: root, loader: 'ts' }, outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external', metafile: true,
 banner: { js: "import { createRequire as lxCreateRequire } from 'node:module'; const require = lxCreateRequire(import.meta.url);" },
 plugins: [{ name: 'lx7-provider-boundaries', setup(b) {
  for (const [pattern, method] of [[/\/shopify\/admin-client\.ts$/, 'shopifyAdmin'], [/\/etsy\/read-client\.ts$/, 'etsyReader'], [/\/categories\/seller-schema\.service\.ts$/, 'amazonSellerSpec']]) b.onLoad({ filter: pattern }, async args => ({ contents: (await readFile(args.path, 'utf8')).replace(`export async function ${method}`, `async function unusedOriginal_${method}`) + `\nexport async function ${method}(){globalThis.__lxGateways.push('${method}');throw new Error('Provider gateway blocked by LX7 harness');}`, loader: 'ts' }))
  b.onLoad({ filter: /\/lib\/queue\.ts$/ }, () => ({ contents: 'export const redis={connection:{get:async()=>null,set:async()=>null,scan:async()=>["0",[]],del:async()=>0}},outboundSyncQueue=null,readCacheQueue=null,searchIndexQueue=null;export const addJobSafely=async()=>({enqueued:false});export const resolveRedisTarget=()=>null;', loader: 'js' }))
  b.onLoad({ filter: /\/product-read-cache\.service\.ts$/ }, async args => ({ contents: (await readFile(args.path, 'utf8')) + '\nObject.assign(productReadCacheService,{refresh:async()=>{},refreshMany:async()=>{},refreshInTransaction:async()=>{}});', loader: 'ts' }))
 } }] })
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const files = []; for (const file of Object.keys(result.metafile.inputs).filter(f => f !== '<stdin>')) files.push({ file, sha256: sha(await readFile(file)) })
await writeFile('docs/audits/2026-09-12-language-axis/step7/runtime-build.json', JSON.stringify({ at: new Date().toISOString(), files, runtimeSha256: sha(await readFile(outfile)), substitutions: ['Counted provider gateways throw before credentials and transport', 'Queues have no workers or Redis', 'ProductReadCache refresh methods suppressed; all readers unchanged'] }, null, 2))
console.log(JSON.stringify({ inputs: files.length, outfile }))
