import prisma from '../../db.js'
import type { DictionaryAttribute } from './family-variations-core.js'

/**
 * The business's attribute dictionary, as the writers read it (the eBay import plans a new family's axes against it too).
 * Its own module (E1b, 2026-10-05): the eBay resolver and publisher read it to send each value in the market's word, and
 * the writer's module (`family-variations.service.ts`, which re-exports it) loads the queues and the read cache.
 */
export async function variationDictionary(): Promise<DictionaryAttribute[]> {
  return prisma.customAttribute.findMany({ where: { archivedAt: null }, orderBy: { code: 'asc' }, select: {
    id: true, code: true, label: true, semanticKey: true, archivedAt: true,
    options: { orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }], select: { id: true, code: true, label: true, metadata: true, synonyms: true, sortOrder: true, archivedAt: true } },
  } })
}
