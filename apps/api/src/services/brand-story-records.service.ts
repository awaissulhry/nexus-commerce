import prisma from '../db.js'
import { languageEntry } from './pim/content-language.js'

/** Language aliases share one story within a brand and marketplace. */
export async function findBrandStoryForLanguage(brand: string, marketplace: string, language: string) {
  const rows = await prisma.brandStory.findMany({ where: { brand, marketplace } })
  return languageEntry(rows.map(row => [row.locale, row] as const), language)
}
