import { contentAddress, type ContentAddress } from '@nexus/shared/content-language'
import prisma from '../../db.js'
import { inDatabaseTransaction } from '../../lib/database-context.js'
import { CONTENT_COLUMNS, PRIMARY_CONTENT_LOCALE } from './content-locale.js'
import { normalizeLanguage } from './content-language.js'
import { contentField, contentSourceHash } from './content-resolver.js'
import { workspaceKey } from '@nexus/database/workspace-context'

export interface TranslationWrite {
  productId: string; locale: string; address: ContentAddress; values: Record<string, unknown>
  state: 'draft' | 'reviewed'; remove?: boolean; reset?: string[]
  expectedVersion?: number; expectedTranslationVersion?: number
  userId?: string | null; ip?: string; label?: string
}
const conflict = (label: string) => Object.assign(new Error(`${label} changed. Reload before saving it.`), { statusCode: 409 })

/** The only authoring boundary for non-primary shared text. No legacy JSON write. */
export async function writeTranslation(input: TranslationWrite) {
  const label = input.label ?? 'Translation'
  const address = contentAddress(input.address, label), language = normalizeLanguage(input.locale)
  if (address.tier !== 'language' || address.language !== language || language === PRIMARY_CONTENT_LOCALE) {
    throw Object.assign(new Error(`${label} needs the shared ${language} language address.`), { statusCode: 400 })
  }
  return inDatabaseTransaction(prisma, async () => {
    const product = await prisma.product.findUnique({ where: { id: input.productId }, include: { parent: true } })
    if (!product) throw Object.assign(new Error('Product not found'), { statusCode: 404 })
    const where = { productId_language: workspaceKey({ productId: product.id, language }) }
    const prior = await prisma.productTranslation.findUnique({ where })
    if (input.expectedVersion !== undefined && input.expectedVersion !== product.version || input.expectedTranslationVersion !== undefined && input.expectedTranslationVersion !== (prior?.version ?? 0)) throw conflict(label)
    if (!prior && !Object.keys(input.values).length) throw Object.assign(new Error(`${label} has no ${language} translation to ${input.remove ? 'remove' : 'review'}.`), { statusCode: 404 })
    const attributes = { ...(prior?.attributes as Record<string, unknown> ?? {}) }
    const data: Record<string, any> = {}
    const changed: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(input.values)) {
      if (['source', 'sourceModel', 'reviewedAt'].includes(key)) continue
      const field = contentField(key), column = CONTENT_COLUMNS[field as keyof typeof CONTENT_COLUMNS]
      changed[field] = value
      if (column) { data[column] = value ?? (['bulletPoints','keywords'].includes(column) ? [] : null); delete attributes[field]; if (value === null || Array.isArray(value) && !value.length || value === '') attributes[field] = value }
      else attributes[field] = value
    }
    for (const key of input.reset ?? []) {
      const field = contentField(key), column = CONTENT_COLUMNS[field as keyof typeof CONTENT_COLUMNS]
      if (column) data[column] = ['bulletPoints','keywords'].includes(column) ? [] : null
      delete attributes[field]; changed[field] = null
    }
    /**
     * LX.F F8 — a BYTE-IDENTICAL write is a no-op: no version bump, no audit row, no
     * cascade. LX.7V measured a re-import of an unchanged file moving the translation
     * 1 → 2 and `Product.version` 7 → 8, which can then defeat the revert's own CAS
     * (`catalog-translate.ts:134` compares `Product.version` with the version recorded
     * at apply time) and makes a re-import look like an edit in the audit trail.
     *
     * The predicate is deliberately strict: the stored VALUES must match, and so must
     * every stamp this write would set (`source`, the reviewed STATE, `sourceHash`).
     * A same-text write that changes the review state, the source or the fingerprint is
     * NOT a no-op and still writes.
     */
    if (prior && !input.remove && Object.keys(changed).length) {
      const nextSource = !Object.keys(changed).length && prior ? prior.source : input.state === 'draft' ? 'ai' : 'manual'
      const nextHash = contentSourceHash(product as any, product.parent as any, Object.keys(attributes))
      const columnsMatch = Object.entries(data).every(([column, value]) => JSON.stringify(value ?? null) === JSON.stringify((prior as Record<string, any>)[column] ?? null))
      const attributesMatch = JSON.stringify(attributes) === JSON.stringify(prior.attributes ?? {})
      const stampsMatch = nextSource === prior.source && nextHash === prior.sourceHash
        && (input.state === 'reviewed') === !!prior.reviewedAt
        && (input.values.sourceModel ?? prior.sourceModel ?? null) === (prior.sourceModel ?? null)
      if (columnsMatch && attributesMatch && stampsMatch) return prior
    }
    const bumped = await prisma.product.updateMany({ where: { id: product.id, version: product.version }, data: { version: { increment: 1 } } })
    if (bumped.count !== 1) throw conflict(label)
    if (input.remove) {
      if (prior) await prisma.productTranslation.deleteMany({ where: { id: prior.id, version: prior.version } })
      for (const key of [...Object.keys(CONTENT_COLUMNS), ...Object.keys(attributes)]) changed[key] = null
    } else {
      Object.assign(data, { attributes, source: !Object.keys(changed).length && prior ? prior.source : input.state === 'draft' ? 'ai' : 'manual',
        sourceModel: input.values.sourceModel ?? prior?.sourceModel ?? null,
        sourceHash: contentSourceHash(product as any, product.parent as any, Object.keys(attributes)), authoredAt: new Date(),
        reviewedAt: input.state === 'reviewed' ? new Date() : null })
      if (prior) {
        const saved = await prisma.productTranslation.updateMany({ where: { id: prior.id, version: prior.version }, data: { ...data, version: { increment: 1 } } })
        if (saved.count !== 1) throw conflict(label)
      } else await prisma.productTranslation.create({ data: { productId: product.id, language, ...data, version: 1 } as any })
    }
    if (!Object.keys(changed).length && prior) for (const [key,column] of Object.entries(CONTENT_COLUMNS)) changed[key] = prior[column]
    const { masterContentService } = await import('../master-content.service.js')
    await masterContentService.update(product.id, changed, { locale: language, address, actor: input.userId, reason: 'language-content-write', reviewed: input.state === 'reviewed', masterAlreadyWritten: true, tx: prisma as any })
    await prisma.auditLog.create({ data: { entityType: 'Product', entityId: product.id, action: 'update', userId: input.userId ?? null, ip: input.ip,
      before: prior as any ?? {}, after: input.remove ? { removed: true } : changed as any,
      metadata: { source: input.state === 'draft' ? 'ai' : 'manual', layer: 'language', language, intent: input.remove ? 'remove' : 'set' } } })
    return input.remove ? { count: prior ? 1 : 0 } : await prisma.productTranslation.findUniqueOrThrow({ where })
  })
}
