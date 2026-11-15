// The factory-api typecheck (B-W2b-F52): `npm run typecheck -w @nexus/factory-api`.
//
// RULE: the same check as `tsc --noEmit -p tsconfig.json` — the same program (tsconfig.json and every file it reaches),
// the same compiler options, tsc's own diagnostics, output and exit code — within a 7 GB heap. One checker over the
// whole program needed a 16 GB heap (13.4 GB used, 15 GB of memory on 11-15; it ran out at 12 GB on 11-14).
//
// How: the files are read, parsed and bound ONCE (about 4.8 GB: most of it the generated Prisma client, which tsc
// parses but never checks). They are then checked in batches, each batch by a fresh type checker over those same files:
// a new program built from the last one reuses every parsed file, as the editor's language service does after each
// edit. A checker keeps every type it ever made, so dropping it after its batch keeps the peak at the parsed program
// plus one batch. A batch is whole folders (a module or platform area, a factory-domain area, …) in tsc's own file
// order, so files that share types share a checker. Every file of the program is handed to a checker exactly once (the
// run fails otherwise); TypeScript's own rules still skip what tsc skips (declaration files under skipLibCheck, files
// marked @ts-nocheck such as the generated client).
//
// Exit 0 only when no batch reports a diagnostic. `-- --listFiles` also prints every file of the program, all of them
// checked: the coverage proof against `tsc --noEmit -p tsconfig.json --listFilesOnly`.
import ts from 'typescript'
import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'

// One batch per this many characters of checked source (declaration and @ts-nocheck files weigh nothing): the batches
// grow in number, not in size, as the code grows. Measured 11-15 (16 batches, the heap capped at 7 GB in package.json):
// about 110 s and 7.7 GB of memory, against 148 s and 15 GB for one tsc program.
const BATCH_CHARACTERS = 4_000_000

const started = Date.now()
const workspace = fileURLToPath(new URL('.', import.meta.url))

function typecheck() {
  let unrecoverable
  const parsed = ts.getParsedCommandLineOfConfigFile(fileURLToPath(new URL('./tsconfig.json', import.meta.url)), {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      unrecoverable = diagnostic
    },
  })
  // tsc stops on a tsconfig.json it cannot read with exit 1 (DiagnosticsPresent_OutputsSkipped); any other diagnostic is 2.
  if (parsed === undefined) return { diagnostics: [unrecoverable], files: [], failure: 1 }

  // Every file is parsed once: later programs get the same SourceFile objects and reuse the parse and the binding.
  const host = ts.createCompilerHost(parsed.options)
  host.jsDocParsingMode = ts.JSDocParsingMode.ParseForTypeErrors // what tsc sets (executeCommandLine performCompilation)
  const parsedFiles = new Map()
  const readSourceFile = host.getSourceFile.bind(host)
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    let file = parsedFiles.get(fileName)
    if (file === undefined) {
      file = readSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile)
      if (file !== undefined) parsedFiles.set(fileName, file)
    }
    return file
  }
  const programFrom = (oldProgram) =>
    ts.createProgram({
      rootNames: parsed.fileNames,
      options: parsed.options,
      projectReferences: parsed.projectReferences,
      host,
      oldProgram,
      configFileParsingDiagnostics: ts.getConfigFileParsingDiagnostics(parsed),
    })

  let program = programFrom(undefined)
  const files = program.getSourceFiles()

  // tsc's order (emitFilesAndReportErrors): syntax errors stop the run before the options, global and semantic checks;
  // option or global errors stop it before the semantic check.
  const diagnostics = [...program.getConfigFileParsingDiagnostics()]
  const before = diagnostics.length
  diagnostics.push(...program.getSyntacticDiagnostics())
  if (diagnostics.length === before) diagnostics.push(...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics())
  if (diagnostics.length !== before) return { diagnostics, files, failure: 2 }

  const batches = batchesOf(files)
  for (const [index, batch] of batches.entries()) {
    const batchStarted = Date.now()
    if (index > 0) program = programFrom(program)
    // The last batch's checker (or the parser's leftovers) is unreachable now: free it before this batch fills the heap.
    globalThis.gc?.()
    const heapBefore = process.memoryUsage().heapUsed
    for (const file of batch) {
      if (program.getSourceFile(file.fileName) !== file) throw new Error(`typecheck: ${file.fileName} was parsed again`)
      diagnostics.push(...program.getSemanticDiagnostics(file))
    }
    const seconds = Math.round((Date.now() - batchStarted) / 1000)
    const heap = (bytes) => `${(bytes / 1073741824).toFixed(1)} GB`
    console.error(
      `[typecheck] batch ${index + 1}/${batches.length}: ${batch.length} files, ${seconds} s, ` +
        `heap ${heap(heapBefore)} → ${heap(process.memoryUsage().heapUsed)}`,
    )
  }
  return { diagnostics, files, failure: 2 }
}

// Whole folders in tsc's file order, cut at about BATCH_CHARACTERS of checked source each; every file exactly once.
function batchesOf(files) {
  const weight = (file) => (file.isDeclarationFile || file.checkJsDirective?.enabled === false ? 0 : file.text.length)
  const folders = new Map()
  for (const file of files) {
    const path = relative(workspace, file.fileName).split('\\').join('/')
    const area = path.match(/^src\/(modules|platform)\/[^/]+/) ?? path.match(/^\.\.\/\.\.\/packages\/[^/]+\/src\/[^/]+/)
    const folder = area ? area[0] : path.split('/').slice(0, 2).join('/')
    if (!folders.has(folder)) folders.set(folder, [])
    folders.get(folder).push(file)
  }
  const total = files.reduce((sum, file) => sum + weight(file), 0)
  const count = Math.max(1, Math.ceil(total / BATCH_CHARACTERS))
  const batches = [[]]
  let filled = 0
  let done = 0
  for (const group of folders.values()) {
    const size = group.reduce((sum, file) => sum + weight(file), 0)
    // Close the batch when this folder would pass the even share of what is left (half of it may spill over).
    const share = (total - done) / (count - batches.length + 1)
    if (batches.at(-1).length > 0 && batches.length < count && filled + size / 2 > share) {
      batches.push([])
      done += filled
      filled = 0
    }
    batches.at(-1).push(...group)
    filled += size
  }
  const handed = batches.flat()
  if (handed.length !== files.length || new Set(handed).size !== files.length) {
    throw new Error(`typecheck: the batches hold ${handed.length} files, the program ${files.length}`)
  }
  return batches
}

const { diagnostics, files, failure } = typecheck()
if (process.argv.includes('--listFiles')) for (const file of files) ts.sys.write(file.fileName + ts.sys.newLine)
const unique = ts.sortAndDeduplicateDiagnostics(diagnostics)
if (unique.length > 0) {
  const host = {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => ts.sys.getCurrentDirectory(),
    getNewLine: () => ts.sys.newLine,
  }
  // tsc's shouldBePretty: colours and context on a terminal unless NO_COLOR; one line per diagnostic in a log.
  const pretty = !!ts.sys.writeOutputIsTTY?.() && !ts.sys.getEnvironmentVariable('NO_COLOR')
  ts.sys.write(pretty ? ts.formatDiagnosticsWithColorAndContext(unique, host) + ts.sys.newLine : ts.formatDiagnostics(unique, host))
}
const seconds = Math.round((Date.now() - started) / 1000)
console.error(`[typecheck] ${unique.length === 0 ? 'passed' : `${unique.length} error(s)`}: ${files.length} files in ${seconds} s`)
process.exitCode = unique.length === 0 ? 0 : failure
