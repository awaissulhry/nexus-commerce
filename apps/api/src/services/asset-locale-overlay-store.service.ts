import prisma from '../db.js'
import { languageEntry } from './pim/content-language.js'

/** Preserve regional stored keys; canonical wins, ambiguous regional keys refuse. */
export async function findAssetOverlayForLanguage(assetId: string, language: string) {
  const rows = await prisma.assetLocaleOverlay.findMany({ where: { assetId } })
  return languageEntry(rows.map(row => [row.locale, row] as const), language)
}
