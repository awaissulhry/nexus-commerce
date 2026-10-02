/**
 * MCP full control P5 — the shape of the catalog, read: the attribute dictionary and its groups, product families,
 * categories, product types, workflows, tags, listing presets and markets (`catalog-structure`); and how Nexus
 * fills each channel's fields — the mapping rules per market, the value maps, the coverage and the mapping reviews
 * (`channel-mappings`). Plan section 09 §4.
 *
 * Read only and low risk: they read this business's own rows (row-level security and the workspace client) and call
 * no marketplace. Changing any of it (09 P8: attributes, families, categories, mappings, presets) is a separate,
 * approved change — never these reads. Lists are small (a business has hundreds of attributes, not millions), so each
 * kind is read whole and paged in memory (list-page.ts); archived attributes and options, inactive categories and
 * deleted products are left out.
 */

import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import { CHANNEL_LABELS } from '@nexus/shared/channel-label'
import prisma from '../../../db.js'
import { likeEscaped } from '../../../lib/like-pattern.js'
import { workspaceIdForQuery } from '../../../lib/workspace-context.js'
import { MAX_CURSOR_LENGTH, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE } from '../../../lib/pagination/cursor.js'
import { listTags } from '../../products/tags.service.js'
import { parseMappingWithWarnings, type FieldMappingRule } from '../../pim/schema-mapping.service.js'
import { listValueMaps } from '../../pim/value-map.service.js'
import { computeMarketplaceCoverage } from '../../pim/mapping-coverage.service.js'
import type { AgentTool } from '../tool-types.js'
import { capped, safeTextOrNull, safeValue } from './claude-safe.js'
import { listScope, listTool, pageInMemory } from './list-page.js'

const upper = (value: unknown) => (typeof value === 'string' ? value.trim().toUpperCase() : value)
const lower = (value: unknown) => (typeof value === 'string' ? value.trim().toLowerCase() : value)
const CHANNELS = Object.keys(CHANNEL_LABELS) as [string, ...string[]]
/** A sort key part: clipped so a key always fits a cursor, and a separator below every printable character. */
const part = (value: string | number | null | undefined) => String(value ?? '').toLowerCase().slice(0, 120)
const key = (...parts: Array<string | number | null | undefined>) => parts.map(part).join('\u0001')
const iso = (at: Date | null | undefined) => (at ? at.toISOString() : null)

const paging = {
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional()
    .describe(`rows per page (default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE})`),
  cursor: z.string().min(1).max(MAX_CURSOR_LENGTH).optional()
    .describe('nextCursor from the previous page, with the same arguments; omit it for the first page'),
}

/** Does a text contain the search (as typed, any case)? */
const matches = (search: string | undefined, ...texts: Array<string | null | undefined>) =>
  !search || texts.some((text) => !!text && text.toLowerCase().includes(search.toLowerCase()))

// ── catalog-structure ─────────────────────────────────────────────────────────────────────────────────

const KINDS = ['attributes', 'groups', 'families', 'categories', 'product-types', 'workflows', 'tags', 'templates', 'markets'] as const
type Kind = (typeof KINDS)[number]

/** A category's name: stored per language ({ en: …, it: … }); the English one, else the first one given. */
function categoryName(name: unknown, slug: string): string {
  const pick = (value: unknown): string | null => {
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (value && typeof value === 'object') {
      for (const field of ['label', 'name', 'value', 'text']) {
        const inner = (value as Record<string, unknown>)[field]
        if (typeof inner === 'string' && inner.trim()) return inner.trim()
      }
    }
    return null
  }
  if (typeof name === 'string') return pick(name) ?? slug
  if (name && typeof name === 'object') {
    const byLanguage = name as Record<string, unknown>
    for (const language of ['en', 'it', ...Object.keys(byLanguage)]) {
      const found = pick(byLanguage[language])
      if (found) return found
    }
  }
  return slug
}

type Row = Record<string, unknown> & { sortKey: string }

async function readKind(kind: Kind, search: string | undefined): Promise<Row[]> {
  switch (kind) {
    case 'attributes': {
      const rows = await prisma.customAttribute.findMany({
        where: {
          archivedAt: null,
          ...(search ? { OR: [{ label: { contains: likeEscaped(search), mode: 'insensitive' as const } }, { code: { contains: likeEscaped(search), mode: 'insensitive' as const } }] } : {}),
        },
        take: 2000,
        select: {
          id: true, code: true, label: true, description: true, type: true, localizable: true, scope: true, placement: true,
          placementChannels: true, semanticKey: true,
          group: { select: { label: true } },
          options: { where: { archivedAt: null }, orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }], take: 11, select: { label: true } },
          _count: { select: { options: { where: { archivedAt: null } }, familyAttributes: true } },
        },
      })
      return rows.map((row) => ({
        sortKey: key(row.code, row.id),
        id: row.id,
        code: row.code,
        label: row.label,
        description: safeTextOrNull(row.description),
        type: row.type,
        group: row.group.label,
        localizable: row.localizable,
        scope: row.scope,
        placement: row.placement,
        ...(row.placementChannels.length ? { placementChannels: row.placementChannels } : {}),
        concept: row.semanticKey,
        options: row._count.options,
        ...(row.options.length ? { firstOptions: row.options.slice(0, 10).map((option) => option.label) } : {}),
        inFamilies: row._count.familyAttributes,
      }))
    }
    case 'groups': {
      const rows = await prisma.attributeGroup.findMany({
        take: 2000,
        select: { id: true, code: true, label: true, description: true, _count: { select: { attributes: { where: { archivedAt: null } } } } },
      })
      return rows
        .filter((row) => matches(search, row.code, row.label))
        .map((row) => ({ sortKey: key(row.code, row.id), id: row.id, code: row.code, label: row.label, description: safeTextOrNull(row.description), attributes: row._count.attributes }))
    }
    case 'families': {
      const rows = await prisma.productFamily.findMany({
        take: 2000,
        select: {
          id: true, code: true, label: true, description: true,
          parentFamily: { select: { label: true } },
          workflow: { select: { label: true } },
          familyAttributes: { select: { required: true } },
          _count: { select: { products: { where: { deletedAt: null } }, childFamilies: true } },
        },
      })
      return rows
        .filter((row) => matches(search, row.code, row.label))
        .map((row) => ({
          sortKey: key(row.label, row.id),
          id: row.id,
          code: row.code,
          label: row.label,
          description: safeTextOrNull(row.description),
          parent: row.parentFamily?.label ?? null,
          workflow: row.workflow?.label ?? null,
          attributes: row.familyAttributes.length,
          requiredAttributes: row.familyAttributes.filter((attribute) => attribute.required).length,
          products: row._count.products,
          childFamilies: row._count.childFamilies,
        }))
    }
    case 'categories': {
      const rows = await prisma.category.findMany({
        where: { isActive: true },
        take: 5000,
        select: { id: true, parentId: true, slug: true, code: true, depth: true, name: true, _count: { select: { products: true, children: true } } },
      })
      const names = new Map(rows.map((row) => [row.id, categoryName(row.name, row.slug)]))
      const byId = new Map(rows.map((row) => [row.id, row]))
      const pathOf = (id: string): string => {
        const trail: string[] = []
        let at = byId.get(id)
        for (let hops = 0; at && hops < 12; hops++) {
          trail.unshift(names.get(at.id) ?? at.slug)
          at = at.parentId ? byId.get(at.parentId) : undefined
        }
        return trail.join(' › ')
      }
      return rows
        .map((row) => ({ row, path: pathOf(row.id) }))
        .filter(({ row, path }) => matches(search, path, row.slug, row.code))
        .map(({ row, path }) => ({
          sortKey: key(path, row.id),
          id: row.id,
          name: names.get(row.id),
          path,
          slug: row.slug,
          code: row.code,
          depth: row.depth,
          parentId: row.parentId,
          products: row._count.products,
          subcategories: row._count.children,
        }))
    }
    case 'product-types': {
      const rows = await prisma.product.groupBy({ by: ['productType'], where: { deletedAt: null, productType: { not: null } }, _count: { _all: true } })
      return rows
        .filter((row) => row.productType && matches(search, row.productType))
        .map((row) => ({ sortKey: key(row.productType), productType: row.productType, products: row._count._all }))
    }
    case 'workflows': {
      const rows = await prisma.productWorkflow.findMany({
        take: 500,
        select: {
          id: true, code: true, label: true, description: true,
          stages: {
            orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
            take: 21,
            select: {
              code: true, label: true, slaHours: true, isPublishable: true, isInitial: true, isTerminal: true,
              _count: { select: { productsHere: { where: { deletedAt: null } } } },
            },
          },
          _count: { select: { stages: true, families: true } },
        },
      })
      return rows
        .filter((row) => matches(search, row.code, row.label))
        .map((row) => ({
          sortKey: key(row.label, row.id),
          id: row.id,
          code: row.code,
          label: row.label,
          description: safeTextOrNull(row.description),
          families: row._count.families,
          stages: row.stages.slice(0, 20).map((stage) => ({
            code: stage.code,
            label: stage.label,
            first: stage.isInitial,
            last: stage.isTerminal,
            publishable: stage.isPublishable,
            slaHours: stage.slaHours,
            products: stage._count.productsHere,
          })),
          ...(row._count.stages > 20 ? { moreStages: row._count.stages - 20 } : {}),
        }))
    }
    case 'tags': {
      const [{ items }, live] = await Promise.all([
        listTags(),
        // Products that are not deleted, per tag: a deleted product does not count. ProductTag has no relation to
        // Product, so the join is written out, in this business.
        prisma.$queryRaw<Array<{ tagId: string; n: number }>>`
          SELECT pt."tagId", count(*)::int AS n
            FROM "ProductTag" pt JOIN "Product" p ON p.id = pt."productId"
           WHERE pt."workspaceId" = ${workspaceIdForQuery()} AND p."deletedAt" IS NULL
           GROUP BY pt."tagId"`,
      ])
      const counts = new Map(live.map((row) => [row.tagId, row.n]))
      return items
        .filter((tag) => matches(search, tag.name))
        .map((tag) => ({ sortKey: key(tag.name, tag.id), id: tag.id, name: tag.name, color: tag.color, products: counts.get(tag.id) ?? 0 }))
    }
    case 'templates': {
      const rows = await prisma.wizardTemplate.findMany({
        take: 1000,
        select: { id: true, name: true, description: true, channels: true, builtIn: true, categoryHint: true, usageCount: true, lastUsedAt: true },
      })
      return rows
        .filter((row) => matches(search, row.name, row.categoryHint))
        .map((row) => {
          const channels = Array.isArray(row.channels) ? (row.channels as Array<Record<string, unknown>>) : []
          return {
            sortKey: key(row.name, row.id),
            id: row.id,
            name: row.name,
            description: safeTextOrNull(row.description),
            builtIn: row.builtIn,
            destinations: channels.slice(0, 20).map((c) => `${String(c?.platform ?? '?')} ${String(c?.marketplace ?? '')}`.trim()),
            categoryHint: row.categoryHint,
            timesUsed: row.usageCount,
            lastUsedAt: iso(row.lastUsedAt),
          }
        })
    }
    case 'markets': {
      const rows = await prisma.marketplace.findMany({
        take: 1000,
        select: { channel: true, code: true, name: true, region: true, currency: true, language: true, languages: true, isActive: true, taxInclusive: true },
      })
      return rows
        .filter((row) => matches(search, row.code, row.name, row.channel))
        .map((row) => ({
          sortKey: key(row.channel, row.code),
          channel: row.channel,
          code: row.code,
          name: row.name,
          region: row.region,
          currency: row.currency,
          languages: row.languages.length ? row.languages : [row.language],
          active: row.isActive,
          pricesIncludeTax: row.taxInclusive,
        }))
    }
  }
}

const catalogStructure: AgentTool = {
  name: 'catalog-structure',
  title: 'Catalog structure',
  category: 'catalog',
  description:
    'The shape of this business\'s catalog, one kind at a time: attributes (the dictionary: code, label, type, group, '
    + 'options, families using it), groups (attribute groups), families (required attributes, parent, workflow, '
    + 'products), categories (the tree as paths, products), product-types (with product counts), workflows (stages, '
    + 'products in each), tags, templates (listing presets) and markets (currency, languages, active). Archived '
    + 'attributes, inactive categories and deleted products are left out. Read only: changing the structure is a '
    + 'separate, approved change in Nexus. Pages with a cursor.',
  input: z.object({
    kind: z.preprocess(lower, z.enum(KINDS)).describe(`which part of the structure: ${KINDS.join(', ')}`),
    search: z.string().trim().min(1).max(100).optional().describe('only rows whose code, label or name contains this text (any case)'),
    ...paging,
  }),
  requires: [F.productsView],
  riskTier: 'low',
  readOnly: true,
  async handler(args) {
    return listTool('catalog-structure', async () => {
      const kind = args.kind as Kind
      const rows = await readKind(kind, args.search as string | undefined)
      const page = pageInMemory(rows, (row) => row.sortKey, args, listScope('catalog-structure', args))
      return {
        ok: true,
        data: { kind, ...page, items: page.items.map(({ sortKey: _sortKey, ...row }) => row) },
      }
    })
  },
}

// ── channel-mappings ──────────────────────────────────────────────────────────────────────────────────

const MAPPING_KINDS = ['rules', 'value-maps', 'coverage', 'impacts'] as const
type MappingKind = (typeof MAPPING_KINDS)[number]

/** The markets a mapping read covers: the channel and market filters, every market of this business otherwise. */
async function mappingMarkets(channel: string | undefined, market: string | undefined) {
  return prisma.marketplace.findMany({
    where: { ...(channel ? { channel } : {}), ...(market ? { code: market } : {}) },
    orderBy: [{ channel: 'asc' }, { code: 'asc' }],
    take: 500,
    select: { channel: true, code: true, schemaMapping: true },
  })
}

/** A transform as a short phrase: what it does, never a long template body. */
function transformText(transform: unknown): string {
  if (!transform || typeof transform !== 'object') return String(transform)
  const t = transform as Record<string, unknown>
  switch (t.type) {
    case 'truncate': return `cut to ${t.max} characters`
    case 'prepend': return `put "${safeTextOrNull(String(t.value ?? ''), 60)}" before`
    case 'append': return `put "${safeTextOrNull(String(t.value ?? ''), 60)}" after`
    case 'default': return `default ${safeTextOrNull(JSON.stringify(t.value ?? null), 60)}`
    case 'valueMap': return `value map of ${t.attribute}`
    case 'sizeScale': return `size scale ${t.scale} ${t.from}→${t.to}`
    case 'unit': return `unit ${t.from}→${t.to}`
    case 'template': return `template ${safeTextOrNull(String(t.expr ?? ''), 120)}`
    case 'expr': return t.ref ? `business rule "${t.ref}"` : `formula ${safeTextOrNull(String(t.expr ?? ''), 120)}`
    default: return String(t.type ?? 'transform')
  }
}

function ruleView(channel: string, market: string, productType: string | null, field: string, rule: FieldMappingRule) {
  return {
    sortKey: key(channel, market, productType ?? '', field),
    channel,
    market,
    productType,
    field,
    source: safeTextOrNull(rule.source, 200),
    ...(rule.fallback ? { fallback: safeTextOrNull(rule.fallback, 200) } : {}),
    ...(rule.transforms?.length ? { transforms: rule.transforms.slice(0, 10).map(transformText) } : {}),
    required: !!rule.required,
    ...(rule.notes ? { notes: safeTextOrNull(rule.notes, 200) } : {}),
  }
}

async function readMappingKind(kind: MappingKind, channel: string | undefined, market: string | undefined, userId: string | null | undefined): Promise<Row[]> {
  switch (kind) {
    case 'rules': {
      const markets = await mappingMarkets(channel, market)
      const rows: Array<Record<string, unknown> & { sortKey: string }> = []
      for (const row of markets) {
        const { mapping } = parseMappingWithWarnings(row.schemaMapping)
        for (const [field, rule] of Object.entries(mapping.fields ?? {})) rows.push(ruleView(row.channel, row.code, null, field, rule))
        for (const [productType, rules] of Object.entries(mapping.byProductType ?? {})) {
          for (const [field, rule] of Object.entries(rules ?? {})) {
            if (field === 'variations' || !rule || typeof rule !== 'object' || typeof (rule as FieldMappingRule).source !== 'string') continue
            rows.push(ruleView(row.channel, row.code, productType, field, rule as FieldMappingRule))
          }
        }
        for (const [name, body] of Object.entries(mapping.expressions ?? {})) {
          rows.push({ sortKey: key(row.channel, row.code, '\uffff', name), channel: row.channel, market: row.code, businessRule: name, formula: safeTextOrNull(body, 200) })
        }
      }
      return rows
    }
    case 'value-maps': {
      const channels = channel ? [channel] : CHANNELS
      // A value map for every market ('*') applies to the named market too.
      const markets = market ? [market, '*'] : [null]
      const rows = (await Promise.all(channels.flatMap((c) => markets.map((m) => listValueMaps({ channel: c, marketplace: m }))))).flat()
      return rows.slice(0, 5000).map((row) => ({
        sortKey: key(row.channel, row.marketplace, row.attribute, row.fromValue, row.id),
        channel: row.channel,
        market: row.marketplace === '*' ? 'all markets' : row.marketplace,
        attribute: row.attribute,
        from: safeTextOrNull(row.fromValue, 120),
        to: safeTextOrNull(row.toValue, 120),
        confidence: row.confidence,
        reviewed: !!row.reviewedAt,
      }))
    }
    case 'coverage': {
      // One market's coverage reads that channel's whole schema: at most 20 markets per call.
      const markets = (await mappingMarkets(channel, market)).slice(0, 20)
      const out: Array<Record<string, unknown> & { sortKey: string }> = []
      for (const row of markets) {
        const coverage = await computeMarketplaceCoverage(row.channel, row.code)
        const types = capped(coverage.byProductType, 10)
        out.push({
          sortKey: key(row.channel, row.code),
          channel: row.channel,
          market: row.code,
          fields: coverage.totalFields,
          mapped: coverage.mappedFields,
          required: coverage.requiredFields,
          requiredUnmapped: coverage.requiredUnmapped,
          coveragePct: coverage.coveragePct,
          byProductType: types.items,
          ...(types.more ? { moreProductTypes: types.more } : {}),
        })
      }
      return out
    }
    case 'impacts': {
      // Mapping reviews are a person's own (GET /pim/channel-mapping/impact/:jobId reads them by owner).
      const rows = await prisma.bulkOperation.findMany({
        where: {
          status: { in: ['MAPPING_SCANNING', 'MAPPING_REVIEW', 'MAPPING_APPLIED', 'MAPPING_STALE', 'MAPPING_FAILED'] },
          ...(userId !== undefined ? { userId } : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 200,
        select: { id: true, status: true, changes: true, total: true, processed: true, createdAt: true, expiresAt: true },
      })
      return rows
        .map((row) => {
          const payload = (row.changes ?? {}) as Record<string, unknown>
          return {
            sortKey: key(String(9e15 - row.createdAt.getTime()).padStart(16, '0'), row.id),
            reviewId: row.id,
            state: row.status.replace('MAPPING_', '').toLowerCase(),
            channel: typeof payload.channel === 'string' ? payload.channel : null,
            market: typeof payload.market === 'string' ? payload.market : null,
            category: typeof payload.category === 'string' ? payload.category : null,
            counts: safeValue(payload.counts ?? null),
            scanned: row.processed,
            total: row.total,
            createdAt: iso(row.createdAt),
            expiresAt: iso(row.expiresAt),
          }
        })
        .filter((row) => (!channel || row.channel === channel) && (!market || row.market === market))
    }
  }
}

const channelMappings: AgentTool = {
  name: 'channel-mappings',
  title: 'Channel mappings',
  category: 'catalog',
  description:
    'How Nexus fills each channel\'s fields, per market: rules (each channel field, where its value comes from, the '
    + 'transforms on the way, required or not, per product type, plus the named business rules), value-maps (a Nexus '
    + 'value → the channel\'s value), coverage (how many of the channel\'s fields are mapped, required ones missing) '
    + 'and impacts (your mapping reviews: what a change would touch, and their state). Read only: a mapping change '
    + 'is reviewed and approved in Nexus. Pages with a cursor.',
  input: z.object({
    channel: z.preprocess(upper, z.enum(CHANNELS)).optional().describe('only this channel'),
    market: z.string().trim().toUpperCase().min(2).max(20).optional()
      .describe('only this marketplace code, e.g. IT or DE; GLOBAL for single-store channels such as Shopify and Etsy'),
    kind: z.preprocess(lower, z.enum(MAPPING_KINDS)).optional().describe(`what to read: ${MAPPING_KINDS.join(', ')} (default rules)`),
    ...paging,
  }),
  requires: [F.productsView],
  riskTier: 'low',
  readOnly: true,
  async handler(args, ctx) {
    return listTool('channel-mappings', async () => {
      const kind = (args.kind as MappingKind | undefined) ?? 'rules'
      const rows = await readMappingKind(kind, args.channel as string | undefined, args.market as string | undefined, ctx.userId ?? undefined)
      const page = pageInMemory(rows, (row) => row.sortKey, args, listScope('channel-mappings', args))
      return { ok: true, data: { kind, ...page, items: page.items.map(({ sortKey: _sortKey, ...row }) => row) } }
    })
  },
}

export const CATALOG_STRUCTURE_TOOLS: AgentTool[] = [catalogStructure, channelMappings]
