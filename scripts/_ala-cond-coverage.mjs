import { PrismaClient } from '@prisma/client'
import { config } from 'dotenv'; import { fileURLToPath } from 'node:url'; import { dirname, join } from 'node:path'
config({ path: join(dirname(fileURLToPath(import.meta.url)), '..', '.env') })
const p = new PrismaClient()
// Keywords the evaluator understands inside an `if` (everything else under a
// constraint position → rule skipped, safely).
const RECOGNIZED = new Set(['if','then','else','required','properties','items','contains','enum','const','not','anyOf','allOf','value','type','title','description','examples','$comment'])
function unknownKeys(node, acc=new Set()) {
  if (!node || typeof node !== 'object') return acc
  if (Array.isArray(node)) { node.forEach(n => unknownKeys(n, acc)); return acc }
  for (const k of Object.keys(node)) {
    // property NAMES live under `properties`/`required`; skip those keys' children names
    if (!RECOGNIZED.has(k) && !/^[a-z][a-z0-9_]*$/.test(k)) acc.add(k)
    unknownKeys(node[k], acc)
  }
  return acc
}
const types = ['HELMET','OUTERWEAR','PANTS','GLOVES','SHIRT','COAT']
for (const pt of types) {
  const row = await p.categorySchema.findFirst({ where: { channel:'AMAZON', productType: pt }, orderBy:{ fetchedAt:'desc' }, select:{ schemaDefinition:true, marketplace:true } })
  if (!row) { console.log(`${pt}: no schema`); continue }
  const allOf = Array.isArray(row.schemaDefinition.allOf) ? row.schemaDefinition.allOf : []
  let evaluable = 0
  const unknownsAll = new Set()
  for (const rule of allOf) {
    if (!rule?.if) continue
    const u = unknownKeys(rule.if)
    if (u.size === 0) evaluable++
    u.forEach(x => unknownsAll.add(x))
  }
  console.log(`${pt}/${row.marketplace}: ${allOf.length} rules, ${evaluable} fully-evaluable if-conditions (${Math.round(evaluable/Math.max(1,allOf.length)*100)}%)  unknownKeywords={${[...unknownsAll].join(',')}}`)
}
await p.$disconnect()
