/** Read-only capture from the disposable API; never accepts a production URL. */
import { writeFile, mkdir } from 'node:fs/promises'
const destination = new URL('./evidence/', import.meta.url)
await mkdir(destination, { recursive: true })
const scopes = [
  { channel: 'master', locale: 'it' }, { channel: 'master', locale: 'de' },
  ...['AMAZON', 'EBAY', 'ETSY', 'SHOPIFY'].flatMap(channel => ['a', 'b'].map(account => ({ channel, accountId: `${channel.toLowerCase()}-${account}`, locale: channel === 'ETSY' ? 'de' : channel === 'SHOPIFY' ? 'en' : 'it' }))),
]
const captured = []
for (const scope of scopes) {
  const params = new URLSearchParams({ scope: scope.channel === 'master' ? 'master' : 'channel', market: ['ETSY', 'SHOPIFY'].includes(scope.channel) ? 'GLOBAL' : 'IT', locale: scope.locale })
  if (scope.accountId) { params.set('accountId', scope.accountId); params.set('channel', scope.channel) }
  const response = await fetch(`http://127.0.0.1:4116/api/products/store-demo/studio/sheet?${params}`)
  if (!response.ok) throw new Error(`${scope.channel}: ${response.status}`)
  const sheet = await response.json()
  captured.push({ request: scope, scope: sheet.scope, aliases: sheet.aliases, rows: sheet.rows.map(row => ({ id: row.id, aliasId: row.aliasId ?? '', parentId: row.parentId, isParent: row.isParent })),
    fields: sheet.columns.map(column => ({ key: column.key, label: column.label, kind: column.kind, storage: column.storage, scope: column.scope, requiredBy: column.requiredBy, validation: column.validation, options: column.options, optionLabels: column.optionLabels,
      cells: sheet.rows.map(row => { const cell = row.values[column.key]; return { rowId: row.id, aliasKey: row.aliasId ?? '', writable: cell?.writable, writeTarget: cell?.writeTarget, writeField: cell?.writeField, reason: cell?.writeBlockedReason, owner: cell?.shopifyWrite?.ownerId, requestedLocale: cell?.requestedLocale, effectiveLocale: cell?.effectiveLocale, translationState: cell?.translationState } }) })),
  })
}
await writeFile(new URL('field-capabilities.json', destination), JSON.stringify({ fixture: true, providerWrites: 0, capturedAt: new Date().toISOString(), scopes: captured }, null, 2) + '\n')
const response = await fetch('http://127.0.0.1:3151/api/fixture/evidence')
const { writes } = await response.json()
await writeFile(new URL('browser-writes.json', destination), JSON.stringify({ fixture: true, writes: writes.filter(write => !write.url.includes('/formulas/batch')) }, null, 2) + '\n')
console.log(captured.map(scope => `${scope.request.channel} ${scope.request.accountId ?? scope.request.locale}: ${scope.fields.length} fields, ${scope.rows.length} rows`).join('\n'))
