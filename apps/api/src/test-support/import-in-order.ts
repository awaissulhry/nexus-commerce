/**
 * Test support (runtime/module-load-order.vitest.test.ts) — import modules in the given order in a fresh Node ESM process
 * and say which one failed. Real Node ESM, on purpose: a constant read while a cycle of modules loads throws there
 * ("Cannot access … before initialization"), which vitest's module runner does not reproduce.
 *
 *   tsx src/test-support/import-in-order.ts <file> [<file> …]   → prints IMPORT-OK, or IMPORT-FAILED <file>: <error>
 */
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

async function main(): Promise<void> {
  for (const file of process.argv.slice(2)) {
    try {
      await import(pathToFileURL(resolve(file)).href)
    } catch (error) {
      console.log(`IMPORT-FAILED ${file}: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`)
      process.exit(1)
    }
  }
  console.log('IMPORT-OK')
  // Some modules keep handles open (a database pool, timers): this process only proves the imports.
  process.exit(0)
}

void main()
