import { readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

/**
 * A small reader for the factory's Prisma schema folder: models, their columns, relations and unique keys. The policy
 * generator, the ownership check and the generated isolation tests need the columns of every table, and the guards
 * must run without a generated client, so this reads the `.prisma` files directly. A test compares it with the client
 * Prisma generates.
 *
 * Fail closed: what it does not understand (composite `type` blocks, views, `@@schema`, `@ignore`) is an error, not
 * something it skips.
 */

export interface SchemaField {
  readonly name: string
  /** The column name (`@map`, else the field name). Empty for a relation field, which has no column. */
  readonly column: string
  /** The type without `?` or `[]`, e.g. `String`, `Decimal`, `TenantStatus`, `Company`. */
  readonly type: string
  readonly optional: boolean
  readonly list: boolean
  /** A relation field: its type is a model. */
  readonly relation: boolean
  /** The native type from `@db.X`, e.g. `Uuid`, `Timestamptz`; empty without one. */
  readonly nativeType: string
  /** The raw argument of `@default(…)`, e.g. `now()`, `dbgenerated("…")`; undefined without a default. */
  readonly defaultValue: string | undefined
}

export interface SchemaModel {
  readonly name: string
  /** The `.prisma` file it is in, without the folder: `_core.prisma`. */
  readonly file: string
  /** The table name (`@@map`, else the model name). */
  readonly table: string
  readonly fields: readonly SchemaField[]
  /** Every column, in field order. */
  readonly columns: readonly string[]
  /** Every unique key (the primary key first), as column lists. */
  readonly uniques: readonly (readonly string[])[]
}

export class SchemaReadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SchemaReadError'
  }
}

/** Removes `//` comments (doc comments too) outside string literals; keeps the line breaks. */
function stripComments(text: string): string {
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string
    if (inString) {
      out += c
      if (c === '\\') {
        out += text[i + 1] ?? ''
        i++
      } else if (c === '"') inString = false
    } else if (c === '"') {
      inString = true
      out += c
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
    } else out += c
  }
  return out
}

/** The index just past the bracket that closes the one at `start` (strings respected). */
function closing(text: string, start: number, open: string, close: string): number {
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (c === '\\') i++
      else if (c === '"') inString = false
    } else if (c === '"') inString = true
    else if (c === open) depth++
    else if (c === close && --depth === 0) return i + 1
  }
  throw new SchemaReadError(`Unbalanced ${open}${close} in the schema.`)
}

interface Attribute {
  readonly name: string
  readonly args: string | undefined
}

/** Reads `@a @b(…) @db.Uuid …` (or `@@…`) from the start of `text`. */
function attributes(text: string, where: string): Attribute[] {
  const out: Attribute[] = []
  let i = 0
  while (i < text.length) {
    if (/\s/.test(text[i] as string)) {
      i++
      continue
    }
    const name = /^@@?[A-Za-z_][\w.]*/.exec(text.slice(i))
    if (!name) throw new SchemaReadError(`${where}: cannot read "${text.slice(i).trim()}".`)
    i += name[0].length
    let args: string | undefined
    if (text[i] === '(') {
      const end = closing(text, i, '(', ')')
      args = text.slice(i + 1, end - 1).trim()
      i = end
    }
    out.push({ name: name[0], args })
  }
  return out
}

const stringArgument = (args: string | undefined, where: string): string => {
  const match = /^"((?:[^"\\]|\\.)*)"/.exec(args ?? '')
  if (!match) throw new SchemaReadError(`${where}: expected a string argument.`)
  return match[1] as string
}

/** `[a, b(sort: Desc), c]` (the first, unnamed argument of @@unique, @@id) → ['a', 'b', 'c']. */
const fieldList = (args: string | undefined, where: string): string[] => {
  const match = /^(?:fields\s*:\s*)?\[([^\]]*)\]/.exec(args ?? '')
  if (!match) throw new SchemaReadError(`${where}: expected a field list.`)
  return (match[1] as string)
    .split(',')
    .map((part) => part.trim().replace(/\(.*$/, '').trim())
    .filter((part) => part !== '')
}

interface RawBlock {
  readonly kind: string
  readonly name: string
  readonly body: string
  readonly file: string
}

function blocks(file: string, text: string): RawBlock[] {
  const source = stripComments(text)
  const out: RawBlock[] = []
  const head = /\b(model|enum|type|view|generator|datasource)\s+([A-Za-z_]\w*)\s*\{/g
  let match: RegExpExecArray | null
  while ((match = head.exec(source)) !== null) {
    const open = match.index + match[0].length - 1
    const end = closing(source, open, '{', '}')
    out.push({ kind: match[1] as string, name: match[2] as string, body: source.slice(open + 1, end - 1), file })
    head.lastIndex = end
  }
  return out
}

/** Reads every `.prisma` file of the folder. */
export function readSchemaFolder(dir: string): SchemaModel[] {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.prisma'))
    .sort()
    .map((name) => ({ file: name, text: readFileSync(join(dir, name), 'utf8') }))
  return parseSchema(files)
}

/** Parses schema files given as text (the tests use this). */
export function parseSchema(files: readonly { file: string; text: string }[]): SchemaModel[] {
  const all = files.flatMap(({ file, text }) => blocks(basename(file), text))
  for (const block of all) {
    if (block.kind === 'type' || block.kind === 'view') {
      throw new SchemaReadError(`${block.file}: ${block.kind} ${block.name} is not supported by the factory schema reader.`)
    }
  }
  const modelNames = new Set(all.filter((block) => block.kind === 'model').map((block) => block.name))
  const seen = new Set<string>()
  return all
    .filter((block) => block.kind === 'model')
    .map((block) => {
      if (seen.has(block.name)) throw new SchemaReadError(`Model ${block.name} is defined twice.`)
      seen.add(block.name)
      return model(block, modelNames)
    })
}

function model(block: RawBlock, modelNames: ReadonlySet<string>): SchemaModel {
  const where = `${block.file}: model ${block.name}`
  const fields: SchemaField[] = []
  const blockAttributes: Attribute[] = []
  for (const raw of block.body.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    if (line.startsWith('@@')) {
      blockAttributes.push(...attributes(line, where))
      continue
    }
    const head = /^([A-Za-z_]\w*)\s+([A-Za-z_]\w*)(\([^)]*\))?(\[\]|\?)?/.exec(line)
    if (!head) throw new SchemaReadError(`${where}: cannot read the field line "${line}".`)
    const [, name, type, , modifier] = head as unknown as [string, string, string, string | undefined, string | undefined]
    const fieldWhere = `${where}.${name}`
    const attrs = attributes(line.slice(head[0].length), fieldWhere)
    if (attrs.some((attr) => attr.name === '@ignore')) throw new SchemaReadError(`${fieldWhere}: @ignore is not supported.`)
    const relation = modelNames.has(type)
    const map = attrs.find((attr) => attr.name === '@map')
    const native = attrs.find((attr) => attr.name.startsWith('@db.'))
    const fallback = attrs.find((attr) => attr.name === '@default')
    fields.push({
      name,
      column: relation ? '' : map ? stringArgument(map.args, fieldWhere) : name,
      type,
      optional: modifier === '?',
      list: modifier === '[]',
      relation,
      nativeType: native ? native.name.slice('@db.'.length) : '',
      defaultValue: fallback?.args,
    })
    for (const attr of attrs) {
      if (attr.name === '@id' || attr.name === '@unique') blockAttributes.push({ name: attr.name === '@id' ? '@@id' : '@@unique', args: `[${name}]` })
    }
  }
  for (const attr of blockAttributes) {
    if (attr.name === '@@schema' || attr.name === '@@ignore') throw new SchemaReadError(`${where}: ${attr.name} is not supported.`)
  }
  const columnOf = new Map(fields.filter((field) => !field.relation).map((field) => [field.name, field.column]))
  const keyColumns = (attr: Attribute): string[] =>
    fieldList(attr.args, where).map((name) => {
      const column = columnOf.get(name)
      if (column === undefined) throw new SchemaReadError(`${where}: ${attr.name} names ${name}, which is not a column.`)
      return column
    })
  const tableMap = blockAttributes.find((attr) => attr.name === '@@map')
  const ids = blockAttributes.filter((attr) => attr.name === '@@id').map(keyColumns)
  const uniques = blockAttributes.filter((attr) => attr.name === '@@unique').map(keyColumns)
  return {
    name: block.name,
    file: block.file,
    table: tableMap ? stringArgument(tableMap.args, where) : block.name,
    fields,
    columns: fields.filter((field) => !field.relation).map((field) => field.column),
    uniques: [...ids, ...uniques],
  }
}
