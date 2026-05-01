import prisma from '../../db.js'

export interface DetectedGroup {
  id: string
  baseName: string
  suggestedMasterSku: string
  confidence: number
  detectionMethod: 'TITLE' | 'SKU_PATTERN' | 'AMAZON_RELATIONSHIP'
  variationAxes: string[]
  members: Array<{
    productId: string
    sku: string
    name: string
    asin: string | null
    detectedAttributes: Record<string, string>
  }>
}

const ATTRIBUTE_DICTIONARY = {
  colors: [
    'black', 'nero', 'bianco', 'white', 'red', 'rosso', 'blue', 'blu',
    'green', 'verde', 'yellow', 'giallo', 'orange', 'arancione',
    'purple', 'viola', 'pink', 'rosa', 'gray', 'grey', 'grigio',
    'brown', 'marrone', 'crema', 'vino', 'beige', 'gold', 'oro',
    'silver', 'argento', 'multicolor', 'multicolore',
  ],
  sizes: ['xs', 's', 'm', 'l', 'xl', 'xxl', 'xxxl', '2xl', '3xl', '4xl', '5xl'],
  numericSizes: /^\d+(\.\d+)?$/,
  euSizes: /^(eu)?\s*\d{2,3}$/i,
  bodyTypes: ['uomo', 'donna', 'unisex', 'men', 'women', 'kids', 'bambino', 'bambina', 'adulto'],
  materials: [
    'leather', 'pelle', 'cotton', 'cotone', 'polyester', 'poliestere',
    'mesh', 'rete', 'nylon', 'spandex', 'wool', 'lana', 'silk', 'seta',
  ],
  sports: [
    'motorcycle', 'moto', 'cycling', 'ciclismo', 'running', 'corsa',
    'football', 'calcio', 'basketball', 'tennis',
  ],
  styles: ['sport', 'casual', 'classic', 'modern', 'vintage', 'sportivo'],
}

function classifyAttributeValue(value: string): string {
  const lower = value.toLowerCase().trim()

  if (ATTRIBUTE_DICTIONARY.sizes.includes(lower)) return 'Size'
  if (ATTRIBUTE_DICTIONARY.numericSizes.test(lower)) return 'Size'
  if (ATTRIBUTE_DICTIONARY.euSizes.test(lower)) return 'Size'

  for (const color of ATTRIBUTE_DICTIONARY.colors) {
    if (lower === color || lower.includes(color)) return 'Color'
  }
  if (ATTRIBUTE_DICTIONARY.bodyTypes.includes(lower)) return 'Body Type'
  for (const mat of ATTRIBUTE_DICTIONARY.materials) {
    if (lower.includes(mat)) return 'Material'
  }
  for (const sport of ATTRIBUTE_DICTIONARY.sports) {
    if (lower.includes(sport)) return 'Sport'
  }
  for (const style of ATTRIBUTE_DICTIONARY.styles) {
    if (lower.includes(style)) return 'Style'
  }
  if (/\d/.test(lower)) return 'Size'
  return 'Attribute'
}

function parseTitle(title: string): { baseName: string; attributes: string[] } {
  // Pattern 1: "Name (attr1, attr2, attr3)"
  const parenMatch = title.match(/^(.+?)\s*\(([^)]+)\)\s*$/)
  if (parenMatch) {
    return {
      baseName: parenMatch[1].trim(),
      attributes: parenMatch[2].split(',').map((s) => s.trim()).filter(Boolean),
    }
  }
  // Pattern 2: "Name – attr1, attr2, attr3" (em-dash / en-dash)
  const dashMatch = title.match(/^(.+?)\s*[–—]\s*(.+)$/)
  if (dashMatch) {
    const lastSegment = dashMatch[2].trim()
    if (lastSegment.includes(',')) {
      return {
        baseName: dashMatch[1].trim(),
        attributes: lastSegment.split(',').map((s) => s.trim()).filter(Boolean),
      }
    }
  }
  return { baseName: title, attributes: [] }
}

function generateMasterSku(baseName: string): string {
  return baseName
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, '')
    .trim()
    .split(/\s+/)
    .slice(0, 4)
    .join('-')
    .slice(0, 50)
}

export async function detectVariationGroups() {
  // Pull only top-level / parent rows so we don't double-count children
  // already linked to a master.
  const products = await prisma.product.findMany({
    where: {
      OR: [{ parentId: null }, { isParent: true }],
    },
  })

  const baseNameGroups = new Map<string, any[]>()
  const noVariationProducts: any[] = []

  for (const product of products) {
    const parsed = parseTitle(product.name)
    if (parsed.attributes.length === 0) {
      noVariationProducts.push(product)
      continue
    }
    const key = parsed.baseName.toLowerCase()
    if (!baseNameGroups.has(key)) baseNameGroups.set(key, [])
    baseNameGroups.get(key)!.push({ ...product, _parsedAttributes: parsed.attributes, _baseName: parsed.baseName })
  }

  const detectedGroups: DetectedGroup[] = []
  const trulyStandalone: any[] = [...noVariationProducts]

  for (const [, members] of baseNameGroups.entries()) {
    if (members.length < 2) {
      trulyStandalone.push(members[0])
      continue
    }

    const maxAttributeCount = Math.max(...members.map((m: any) => m._parsedAttributes.length))
    const axes: string[] = []

    for (let i = 0; i < maxAttributeCount; i++) {
      const valuesAtPosition = new Set<string>()
      members.forEach((m: any) => {
        const val = m._parsedAttributes[i]
        if (val) valuesAtPosition.add(val)
      })
      const classifications: Record<string, number> = {}
      for (const val of valuesAtPosition) {
        const type = classifyAttributeValue(val)
        classifications[type] = (classifications[type] || 0) + 1
      }
      const topType =
        Object.entries(classifications).sort((a, b) => b[1] - a[1])[0]?.[0] ?? `Attribute ${i + 1}`
      axes.push(topType)
    }

    const groupMembers = members.map((m: any) => {
      const attrs: Record<string, string> = {}
      m._parsedAttributes.forEach((value: string, i: number) => {
        attrs[axes[i]] = value
      })
      return {
        productId: m.id,
        sku: m.sku,
        name: m.name,
        asin: m.amazonAsin,
        detectedAttributes: attrs,
      }
    })

    const consistencyScore = members.every(
      (m: any) => m._parsedAttributes.length === maxAttributeCount
    )
      ? 1
      : 0.7
    const wellClassifiedScore =
      axes.filter((a) => !a.startsWith('Attribute')).length / Math.max(axes.length, 1)
    const sizeScore = Math.min(members.length / 5, 1)
    const confidence = Math.round(
      consistencyScore * 40 + wellClassifiedScore * 40 + sizeScore * 20
    )

    detectedGroups.push({
      id: `group_${detectedGroups.length}`,
      baseName: members[0]._baseName,
      suggestedMasterSku: generateMasterSku(members[0]._baseName),
      confidence,
      detectionMethod: 'TITLE',
      variationAxes: axes,
      members: groupMembers,
    })
  }

  detectedGroups.sort((a, b) => b.confidence - a.confidence)

  return {
    groups: detectedGroups,
    standalone: trulyStandalone,
    stats: {
      totalProducts: products.length,
      productsInGroups: detectedGroups.reduce((sum, g) => sum + g.members.length, 0),
      productsStandalone: trulyStandalone.length,
      groupCount: detectedGroups.length,
    },
  }
}

export interface ApprovedGroup {
  masterSku: string
  masterName: string
  variationAxes: string[]
  children: Array<{ productId: string; attributes: Record<string, string> }>
}

export async function applyGroupings(approvedGroups: ApprovedGroup[]) {
  const errors: string[] = []
  let mastersCreated = 0
  let childrenLinked = 0

  for (const group of approvedGroups) {
    try {
      const firstChild = await prisma.product.findUnique({
        where: { id: group.children[0].productId },
      })
      if (!firstChild) {
        errors.push(`First child not found for group ${group.masterSku}`)
        continue
      }

      // Create master product (or reuse if SKU collision)
      let master = await prisma.product.findUnique({ where: { sku: group.masterSku } })
      if (!master) {
        master = await prisma.product.create({
          data: {
            sku: group.masterSku,
            name: group.masterName,
            masterSku: group.masterSku,
            isParent: true,
            isMaster: true,
            variationAxes: group.variationAxes,
            variationTheme: group.variationAxes.join(' / '),
            basePrice: firstChild.basePrice,
            totalStock: 0,
            status: 'ACTIVE',
            syncChannels: [],
            importSource: 'MANUAL',
            reviewStatus: 'APPROVED',
            brand: firstChild.brand,
            manufacturer: firstChild.manufacturer,
            minMargin: 0,
          },
        })
      } else {
        await prisma.product.update({
          where: { id: master.id },
          data: {
            isParent: true,
            isMaster: true,
            variationAxes: group.variationAxes,
            variationTheme: group.variationAxes.join(' / '),
            reviewStatus: 'APPROVED',
          },
        })
      }
      mastersCreated++

      for (const child of group.children) {
        await prisma.product.update({
          where: { id: child.productId },
          data: {
            parentId: master.id,
            variantAttributes: child.attributes,
            variationTheme: group.variationAxes.join(' / '),
            isParent: false,
            isMaster: false,
          },
        })
        childrenLinked++
      }

      const totalStock = await prisma.product.aggregate({
        where: { parentId: master.id },
        _sum: { totalStock: true },
      })
      await prisma.product.update({
        where: { id: master.id },
        data: { totalStock: totalStock._sum.totalStock ?? 0 },
      })
    } catch (error: any) {
      errors.push(`Group ${group.masterSku}: ${error?.message ?? String(error)}`)
    }
  }

  return { mastersCreated, childrenLinked, errors }
}
