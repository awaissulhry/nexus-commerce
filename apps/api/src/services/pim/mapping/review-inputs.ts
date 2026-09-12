import { createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'
import prisma from '../../../db.js'

/** Any resolution-input change requires a fresh review, including legacy writes that do not
 * advance a version. PostgreSQL hashes complete rows; only keys and digests cross the network.
 * Bounded keyset pages keep both transfer and application memory independent of catalog size.
 * This runs only during an explicit review/activation, never on an editor keystroke.
 */
export async function mappingInputToken(channel: string, market: string, db: Prisma.TransactionClient = prisma, onModel?: (model: string, token: string) => void): Promise<string> {
  const all = Prisma.sql`TRUE`
  // Identifiers below are fixed application constants. Values stay bound SQL parameters.
  const sources: Array<[string, Prisma.Sql, string[], string[]?]> = [
    ['Product', all, ['id']],
    ['ChannelListing', Prisma.sql`channel = ${channel} AND marketplace = ${market}`, ['id']],
    ['ProductCategory', all, ['productId', 'categoryId']],
    ['Category', all, ['id']],
    ['CategoryClosure', all, ['ancestorId', 'descendantId']],
    ['CategoryChannelMapping', Prisma.sql`channel = ${channel} AND marketplace IN (${market}, '*')`, ['id']],
    ['ChannelSchema', Prisma.sql`channel = ${channel} AND (marketplace = ${market} OR marketplace IS NULL)`, ['id']],
    ['CategorySchema', Prisma.sql`channel = ${channel}`, ['id']],
    ['FieldLinkGroup', all, ['id']],
    ['FieldValueMap', Prisma.sql`channel = ${channel} AND marketplace IN (${market}, '*')`, ['id']],
    ['SizeScaleMap', all, ['id']],
    ['ChannelConnection', Prisma.sql`"channelType" = ${channel}`, ['id'], ['id', 'channelType', 'marketplace', 'isActive', 'isPrimary', 'externalAccountId']],
    ['CustomAttribute', all, ['id']],
    ['AttributeOption', all, ['id']],
    ['ProductFamily', all, ['id']],
    ['FamilyAttribute', all, ['id']],
    ['EbayDescriptionTheme', all, ['id']],
  ]
  const hash = createHash('sha256')
  for (const [table, where, keys, projection] of sources) {
    const model = table[0].toLowerCase() + table.slice(1)
    hash.update(model)
    const modelHash = createHash('sha256')
    const keySql = Prisma.join(keys.map(key => Prisma.raw(`"${key}"`)))
    let cursor: Record<string, string> | undefined
    while (true) {
      const after = cursor ? Prisma.sql`AND (${keySql}) > (${Prisma.join(keys.map(key => cursor![key]))})` : Prisma.empty
      const columns = projection ? Prisma.join(projection.map(key => Prisma.raw(`"${key}"`))) : Prisma.raw('*')
      const rows = await db.$queryRaw<Array<Record<string, string>>>(Prisma.sql`
        SELECT ${keySql}, encode(sha256(convert_to(to_jsonb(source)::text, 'UTF8')), 'hex') AS digest
        FROM (SELECT ${columns} FROM ${Prisma.raw(`"public"."${table}"`)} WHERE ${where} ${after}
          ORDER BY ${keySql} LIMIT 250) AS source ORDER BY ${keySql}`)
      for (const row of rows) { hash.update(row.digest).update('\n'); modelHash.update(row.digest).update('\n') }
      if (rows.length < 250) break
      cursor = Object.fromEntries(keys.map(key => [key, rows[rows.length - 1][key]]))
    }
    onModel?.(model, modelHash.digest('hex'))
  }
  // Older reviews use a different serialization and must be reviewed again.
  return `v2:${hash.digest('hex')}`
}
