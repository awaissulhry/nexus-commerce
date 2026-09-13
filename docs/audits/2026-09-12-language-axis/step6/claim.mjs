import fs from 'node:fs'
import crypto from 'node:crypto'
const root = new URL('../../../../', import.meta.url)
const here = new URL('.', import.meta.url)
const before = JSON.parse(fs.readFileSync(new URL('before.json', here)))
const scope = JSON.parse(fs.readFileSync(new URL('scope.json', here)))
const added = []
for (const path of process.argv.slice(2)) {
  if (scope.includes(path)) continue
  const url = new URL(path, root)
  if (fs.existsSync(url)) {
    const bytes = fs.readFileSync(url)
    before[path] = { content: bytes.toString(), sha256: crypto.createHash('sha256').update(bytes).digest('hex'), mtime: fs.statSync(url).mtime.toISOString() }
  }
  scope.push(path); added.push(path)
}
if (added.length) {
  fs.appendFileSync(new URL('docs/pes-claims.md', root), `\nLX Step 6 additional claims · ${new Date().toISOString()} · language-axis session owns these exact integration files; full pre-edit bytes and hashes in step6/before.json:\n${added.map(p => '- `'+p+'`').join('\n')}\n`)
  fs.writeFileSync(new URL('before.json', here), JSON.stringify(before, null, 2)+'\n')
  fs.writeFileSync(new URL('scope.json', here), JSON.stringify(scope, null, 2)+'\n')
}
console.log(JSON.stringify({ claimed: added }))
