import type { Prisma } from '@prisma/client'
import prisma from '../../db.js'
import { categoryTreeService, CategoryTreeError } from '../category-tree.service.js'
import { categoryName, listCategoryMappings } from '../pim/mapping/category-mapping.service.js'
import { mappingToken } from '../pim/mapping/revision-token.js'
import { getMappingForMarketplace } from '../pim/schema-mapping.service.js'
import { taxonomyWhere, schemaMarkets } from './repository.js'
import { TaxonomyError } from './model.js'

export async function categoryDirectory(db: Prisma.TransactionClient = prisma) {
  const categories = await db.category.findMany({ orderBy: [{ depth: 'asc' }, { sortOrder: 'asc' }, { slug: 'asc' }, { id: 'asc' }],
    select: { id: true, parentId: true, name: true, slug: true, code: true, isActive: true, updatedAt: true, depth: true, _count: { select: { products: true, children: true, channelMappings: true } } } })
  const names = new Map<string, string>()
  const rows = categories.map(c => {
    const name = categoryName(c.name) ?? c.slug
    const path = c.parentId && names.has(c.parentId) ? `${names.get(c.parentId)} › ${name}` : name
    names.set(c.id, path)
    return { id: c.id, parentId: c.parentId, name, path, slug: c.slug, code: c.code, active: c.isActive, products: c._count.products, children: c._count.children, mappings: c._count.channelMappings }
  })
  return { rows, token: mappingToken(categories) }
}

export interface CategoryCommand { action: 'create' | 'rename' | 'move' | 'delete'; id?: string; name?: string; slug?: string; code?: string; parentId?: string | null; expectedToken: string }

function validateCommand(command: CategoryCommand) {
  if (!['create', 'rename', 'move', 'delete'].includes(command.action) || !/^[a-f0-9]{64}$/.test(command.expectedToken ?? '')) throw new TaxonomyError('Reload the category list before making changes.', 409)
  if (command.action !== 'create' && (!command.id || typeof command.id !== 'string')) throw new TaxonomyError('Choose a category.')
  if (command.parentId !== undefined && command.parentId !== null && typeof command.parentId !== 'string') throw new TaxonomyError('Choose a valid parent category.')
  if (command.action === 'create' || command.action === 'rename') {
    if (typeof command.name !== 'string' || !command.name.trim() || command.name.trim().length > 160) throw new TaxonomyError('Enter a category name of up to 160 characters.')
    if (typeof command.slug !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,99}$/.test(command.slug)) throw new TaxonomyError('Use a URL key containing lowercase letters, numbers, hyphens, or underscores.')
    if (command.code !== undefined && (typeof command.code !== 'string' || command.code.length > 100)) throw new TaxonomyError('Use a reference code of up to 100 characters.')
  }
}

/** A move that changes inherited channel assignments must be resolved through mapping reviews first. */
export async function categoryChangeImpact(command: CategoryCommand, db: Prisma.TransactionClient = prisma) {
  validateCommand(command)
  const directory = await categoryDirectory(db)
  if (directory.token !== command.expectedToken) throw new TaxonomyError('Categories or memberships changed. Reload and review the change again.', 409)
  const row = directory.rows.find(c => c.id === command.id)
  if (command.action !== 'create' && !row) throw new TaxonomyError('Category no longer exists.', 404)
  const affected = new Set<string>(command.id ? [command.id] : [])
  for (const c of directory.rows) if (c.parentId && affected.has(c.parentId)) affected.add(c.id)
  if (['create', 'move'].includes(command.action) && command.parentId && !directory.rows.some(c => c.id === command.parentId && c.active)) throw new TaxonomyError('Choose an active parent category.')
  if (command.action === 'move' && command.parentId && affected.has(command.parentId)) throw new TaxonomyError('A category cannot move into itself or its descendants.')
  const productCount = affected.size ? await db.product.count({ where: { categories: { some: { categoryId: { in: [...affected] } } } } }) : 0
  const mappings = affected.size ? await db.categoryChannelMapping.findMany({ select: { categoryId: true, channel: true, marketplace: true, channelCategoryId: true, browseNodeId: true } }) : []
  const inheritedChanges: string[] = []
  if (command.action === 'move') {
    const parents = new Map(directory.rows.map(c => [c.id, c.parentId]))
    const scopes = [...new Set(mappings.map(m => `${m.channel}/${m.marketplace}`))]
    const index = new Map(mappings.map(m => [`${m.categoryId}/${m.channel}/${m.marketplace}`, `${m.channelCategoryId}/${m.browseNodeId ?? ''}`]))
    const resolve = (id: string, scope: string, moved: boolean): string | null => {
      const [channel, market] = scope.split('/')
      let at: string | null = id
      const seen = new Set<string>()
      while (at && !seen.has(at)) {
        seen.add(at)
        const hit = index.get(`${at}/${channel}/${market}`) ?? index.get(`${at}/${channel}/*`)
        if (hit) return hit
        at = moved && at === command.id ? command.parentId ?? null : parents.get(at) ?? null
      }
      return null
    }
    for (const scope of scopes) if ([...affected].some(id => resolve(id, scope, false) !== resolve(id, scope, true))) inheritedChanges.push(scope)
  }
  const blocked = command.action === 'move' && inheritedChanges.length ? 'This move changes inherited channel assignments. Review explicit assignments for this category in Channel assignments before moving it.'
    : command.action === 'delete' && row && (row.products || row.children || row.mappings) ? 'Only an empty category without child categories or channel assignments can be deleted.' : null
  return { row, productCount, descendantCount: Math.max(0, affected.size - 1), inheritedChanges, blocked, token: directory.token }
}

export async function applyCategoryCommand(command: CategoryCommand, actor: string | null) {
  return categoryTreeService.withLock(async (service, tx) => {
    const impact = await categoryChangeImpact(command, tx)
    if (impact.blocked) throw new TaxonomyError(impact.blocked, 409)
    let id = command.id
    if (command.action === 'create') {
      id = (await service.create({ parentId: command.parentId, slug: command.slug!, code: command.code || null, name: { en: { name: command.name!.trim() } } })).id
    } else if (command.action === 'rename') {
      const category = await tx.category.findUniqueOrThrow({ where: { id } })
      const localized = (category.name ?? {}) as Record<string, any>
      await service.update(id!, { name: { ...localized, en: { ...(typeof localized.en === 'object' ? localized.en : {}), name: command.name!.trim() } }, slug: command.slug, code: command.code || null })
    } else if (command.action === 'move') await service.move(id!, command.parentId ?? null)
    else await service.remove(id!)
    await tx.bulkOperation.create({ data: { userId: actor, productCount: impact.productCount, changeCount: 1, status: 'SUCCESS',
      changes: { kind: 'category-management', action: command.action, categoryId: id, before: impact.row ?? null, after: { name: command.name ?? null, parentId: command.parentId ?? null, slug: command.slug ?? null, code: command.code ?? null } }, completedAt: new Date() } })
    return { id, directory: await categoryDirectory(tx) }
  })
}

export async function categoryAssignments(channel: string, market: string) {
  const [result, mapping] = await Promise.all([listCategoryMappings({ channel, marketplace: market }), getMappingForMarketplace(channel, market)])
  const source = await prisma.marketplaceTaxonomy.findFirst({ where: taxonomyWhere(channel, market) })
  const ids = [...new Set(result.rows.flatMap(row => row.mapping?.channelCategoryId ?? row.inheritedFrom?.channelCategoryId ?? []))]
  const [nodes, schemas] = await Promise.all([
    source?.activeSnapshotId ? prisma.marketplaceTaxonomyNode.findMany({ where: { snapshotId: source.activeSnapshotId, externalId: { in: ids } }, select: { externalId: true, path: true, assignable: true } }) : [],
    channel === 'SHOPIFY' ? [] : prisma.categorySchema.findMany({ where: { channel, marketplace: { in: schemaMarkets(channel, market) }, productType: { in: ids }, isActive: true }, orderBy: { fetchedAt: 'desc' }, select: { productType: true, expiresAt: true } }),
  ])
  const nodeById = new Map<string, { path: string; assignable: boolean }>(nodes.map(n => [n.externalId, n] as const))
  const schemaById = new Map<string, typeof schemas[number]>()
  for (const schema of schemas) if (!schemaById.has(schema.productType)) schemaById.set(schema.productType, schema)
  const rows = result.rows.map(row => {
    const target = row.mapping?.channelCategoryId ?? row.inheritedFrom?.channelCategoryId
    const node = target ? nodeById.get(target) : null, schema = target ? schemaById.get(target) : null
    const health = !target ? 'unmapped' : !source?.activeSnapshotId ? 'unknown' : !node ? 'retired' : !node.assignable ? 'notAssignable' : channel === 'SHOPIFY' ? 'store' : !schema ? 'missing' : schema.expiresAt < new Date() ? 'stale' : 'ready'
    return { ...row, health, currentPath: node?.path ?? null }
  })
  return { ...result, rows, snapshotId: source?.activeSnapshotId ?? null, token: mappingToken(mapping) }
}

export { CategoryTreeError }
