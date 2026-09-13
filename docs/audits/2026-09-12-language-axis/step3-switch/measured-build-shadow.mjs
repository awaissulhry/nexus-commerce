import assert from 'node:assert/strict'
import { build } from 'esbuild'
import ts from 'typescript'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const here = new URL('.', import.meta.url)
const accepted = await readFile(new URL('accepted-shadow-runtime.mjs', here))
assert.equal(sha(accepted), 'd99c16617866b755ce384d06b4ba2eb7e7b9bb3a604f2efc6a88687d34bd0e02')
// Export the frozen, already-reviewed implementation; never rebuild it from current source.
await writeFile(new URL('accepted-reference.mjs', here), Buffer.concat([accepted, Buffer.from('\nexport { resolveContentBatch as acceptedResolveContentBatch, resolveContentPath as acceptedResolveContentPath };\n')]))
const files = new Map()
async function extract(path, names) {
  const source = await readFile(path, 'utf8')
  files.set(path, sha(source))
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  return names.map(name => {
    const fn = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)
    if (!fn) throw new Error(`Missing actual reader ${name} in ${path}`)
    return fn.getText(ast)
  }).join('\n')
}
const funcs = await extract('apps/api/src/routes/listings-syndication.routes.ts', ['extractLocaleTitle']) + '\n'
  + await extract('apps/api/src/services/products/translation-resolver.service.ts', ['resolvedContent']) + '\n'
  + await extract('apps/api/src/services/pim/studio-sheet.service.ts', ['sheetValueForColumn', 'normalise']) + '\n'
  + await extract('apps/api/src/services/pim/sheet-rows.service.ts', ['decimalToNumber'])
const result = await build({ stdin: { contents: `
export * from './docs/audits/2026-09-12-language-axis/step3-switch/compare.ts';
import { resolveContent, contentField } from './apps/api/src/services/pim/content-resolver.ts';
import { contentListing, resolveContentAttributes, contentWireValue } from './apps/api/src/services/pim/content-read.ts';
import { normalizeLanguage } from './apps/api/src/services/pim/content-language.ts';
import { CONTENT_COLUMNS } from './apps/api/src/services/pim/content-locale.ts';
import { projectCellValue, isBlankValue } from './apps/api/src/services/pim/sheet-values.ts';
${funcs}
export { resolvedContent as productResolvedContent };
`, resolveDir: process.cwd(), loader: 'ts' }, outfile: new URL('shadow-runtime.mjs', here).pathname,
 bundle: true, platform: 'node', format: 'esm', packages: 'external', metafile: true,
 plugins: [{ name: 'readonly-boundaries', setup(b) {
   b.onResolve({ filter: /(?:^|\/)db\.js$/ }, () => ({ path: 'refuse-db', namespace: 'readonly' }))
   b.onLoad({ filter: /.*/, namespace: 'readonly' }, () => ({ contents: 'export default new Proxy({}, { get() { throw new Error("Application DB access forbidden in shadow"); } })', loader: 'js' }))
   b.onResolve({ filter: /information-gateway\.js$/ }, () => ({ path: 'refuse-provider', namespace: 'provider' }))
   b.onLoad({ filter: /.*/, namespace: 'provider' }, () => ({ contents: 'export function readInformation() { throw new Error("Provider access forbidden in shadow"); }', loader: 'js' }))
 } }],
})
for (const path of Object.keys(result.metafile.inputs).filter(p => !p.includes(':') && p !== '<stdin>')) files.set(path, sha(await readFile(path)))
for (const path of ['packages/shared/dist/content-language.js', 'packages/shared/dist/product-media.js']) files.set(path, sha(await readFile(path)))
await writeFile(new URL('shadow-build.json', here), JSON.stringify({ builtAt: new Date().toISOString(), files: [...files].map(([file, sha256]) => ({ file, sha256 })), acceptedBundleSha256: sha(accepted), bundleSha256: sha(await readFile(new URL('shadow-runtime.mjs', here))), runtimeDatabase: 'throwing stub', providers: 'throwing stub; no app bootstrap' }, null, 2)+'\n')
console.log(JSON.stringify({ inputs: files.size, acceptedBundleSha256: sha(accepted) }))
