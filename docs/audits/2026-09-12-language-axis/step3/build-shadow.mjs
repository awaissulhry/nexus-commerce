import { build } from 'esbuild'
import ts from 'typescript'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

// Extract the actual pure route helper without importing its route/provider graph.
const path = 'apps/api/src/routes/listings-syndication.routes.ts'
const source = await readFile(path, 'utf8')
const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const fn = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'extractLocaleTitle')
if (!fn) throw new Error('Actual syndication helper was not found.')
const extracted = fn.getText(ast)
const productPath = 'apps/api/src/services/products/translation-resolver.service.ts'
const productSource = await readFile(productPath, 'utf8')
const productAst = ts.createSourceFile(productPath, productSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const productFn = productAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'resolvedContent')
if (!productFn) throw new Error('Actual product content helper was not found.')
const productExtracted = productFn.getText(productAst)
const output = new URL('./shadow-runtime.mjs', import.meta.url)
const result = await build({
  stdin: { contents: `export * from './apps/api/src/services/pim/content-resolver-shadow.ts';\nimport { languageTag } from './apps/api/src/services/pim/market-languages.ts';\nimport { resolveAttributes } from './apps/api/src/services/pim/attribute-resolver.ts';\nimport { CONTENT_COLUMNS } from './apps/api/src/services/pim/content-locale.ts';\n${extracted}\n${productExtracted}\nexport { resolvedContent as productResolvedContent };\n`, resolveDir: process.cwd(), loader: 'ts' },
  outfile: output.pathname, bundle: true, platform: 'node', format: 'esm', packages: 'external', metafile: true,
  plugins: [{ name: 'refuse-runtime-database', setup(builder) {
    builder.onResolve({ filter: /(?:^|\/)db\.js$/ }, () => ({ path: 'no-runtime-database', namespace: 'readonly-shadow' }))
    builder.onLoad({ filter: /.*/, namespace: 'readonly-shadow' }, () => ({ contents: 'export default new Proxy({}, { get() { throw new Error("Shadow comparison attempted an application database access"); } });', loader: 'js' }))
  } }],
})
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const files = []
for (const name of Object.keys(result.metafile.inputs).filter(name => !name.includes(':') && name !== '<stdin>')) files.push({ file: name, sha256: sha(await readFile(resolve(name))) })
files.push({ file: path, sha256: sha(source) })
files.push({ file: productPath, sha256: sha(productSource) })
await writeFile(new URL('./shadow-build.json', import.meta.url), JSON.stringify({ builtAt: new Date().toISOString(), files, extractedHelperSha256: sha(extracted), bundleSha256: sha(await readFile(output)), runtimeDatabase: 'throwing stub; loaded-row marketLanguages overload only' }, null, 2) + '\n')
console.log(JSON.stringify({ inputs: files.length, output: output.pathname }))
