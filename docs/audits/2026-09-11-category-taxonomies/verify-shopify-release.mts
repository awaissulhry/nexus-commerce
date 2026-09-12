import { readFile, writeFile } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { flattenShopifyTree } from '../../../apps/api/src/services/taxonomy/model.ts'
const path = process.argv[2]
if (!path) throw new Error('Pass a downloaded Shopify categories.en.json.gz release asset.')
const bytes = await readFile(path), download = flattenShopifyTree(JSON.parse(gunzipSync(bytes).toString('utf8')))
const evidence = { source: 'https://github.com/Shopify/product-taxonomy/releases/latest/download/categories.en.json.gz', providerVersion: download.providerVersion, nodes: download.nodes.length, compressedBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), roots: download.nodes.filter(n => n.parentId === null).length, withAttributes: download.nodes.filter(n => Array.isArray(n.metadata?.attributes) && n.metadata.attributes.length > 0).length }
await writeFile('docs/audits/2026-09-11-category-taxonomies/shopify-release-evidence.json', JSON.stringify(evidence, null, 2) + '\n')
console.log(JSON.stringify(evidence, null, 2))
