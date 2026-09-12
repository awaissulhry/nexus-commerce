/** Read only Nexus product facts/definitions; never query Etsy listings. */
import '../../../apps/api/src/env.js'
import prisma from '../../../apps/api/src/db.js'
import { withWorkspace, LEGACY_WORKSPACE_ID } from '../../../apps/api/src/lib/workspace-context.js'
import { writeFile } from 'node:fs/promises'

try {
  await withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, async () => {
    const products = await prisma.product.findMany({ select: { id: true, parentId: true, name: true, description: true, keywords: true,
      weightValue: true, weightUnit: true, dimLength: true, dimWidth: true, dimHeight: true, dimUnit: true,
      categoryAttributes: true, variantAttributes: true, localizedContent: true } })
    const definitions = await prisma.customAttribute.findMany({ select: { code: true, label: true, type: true } })
    const facts: Record<string, { populated: number; shapes: Record<string, number>; examples: unknown[] }> = {}
    const add = (key: string, value: unknown) => {
      if (value == null || value === '' || Array.isArray(value) && !value.length) return
      const fact = facts[key] ??= { populated: 0, shapes: {}, examples: [] }
      const shape = Array.isArray(value) ? 'list' : typeof value
      fact.populated++; fact.shapes[shape] = (fact.shapes[shape] ?? 0) + 1
      if (fact.examples.length < 3 && !fact.examples.some(v => JSON.stringify(v) === JSON.stringify(value))) fact.examples.push(value)
    }
    for (const product of products) {
      for (const [key, value] of Object.entries(product)) {
        if (['id', 'parentId', 'name', 'description'].includes(key)) continue
        if (['categoryAttributes', 'variantAttributes'].includes(key)) {
          for (const [attribute, item] of Object.entries(value as object ?? {})) add(`${key}.${attribute}`, item)
        } else if (key === 'localizedContent') {
          for (const [locale, content] of Object.entries(value as object ?? {})) {
            for (const [attribute, item] of Object.entries(content as object ?? {})) {
              if (['keywords', 'material', 'materials', 'color', 'size'].includes(attribute)) add(`${locale}.${attribute}`, item)
            }
          }
        } else add(key, value)
      }
    }
    const result = { observedAt: new Date().toISOString(), products: products.length, children: products.filter(p => p.parentId).length,
      descriptions: { populated: products.filter(p => p.description).length, html: products.filter(p => /<\/?[a-z][^>]*>/i.test(p.description ?? '')).length },
      definitions, facts: Object.fromEntries(Object.entries(facts).sort(([a], [b]) => a.localeCompare(b))) }
    await writeFile(new URL('./master-data-audit.json', import.meta.url), JSON.stringify(result, null, 2) + '\n')
    console.log(JSON.stringify({ products: result.products, children: result.children, descriptions: result.descriptions,
      definitions: definitions.filter(d => /material|color|size|weight|dimension|tag|style/i.test(d.code)),
      facts: Object.fromEntries(Object.entries(facts).filter(([key]) => /material|color|size|weight|dim|keywords/i.test(key))) }, null, 2))
  })
} finally { await prisma.$disconnect() }
