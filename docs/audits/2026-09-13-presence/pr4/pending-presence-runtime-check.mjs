import fs from 'node:fs'
import path from 'node:path'
import ts from '/Users/awais/nexus-commerce/node_modules/typescript/lib/typescript.js'
const root = '/Users/awais/nexus-commerce'
const staging = '/private/tmp/nexus-pr4-presence/presence-runtime'
const virtualPath = path.join(root, 'packages/shared/presence.ts')
const source = fs.readFileSync(path.join(staging, 'presence.ts'), 'utf8')
const configPath = path.join(root, 'packages/shared/tsconfig.json')
const config = ts.readConfigFile(configPath, ts.sys.readFile)
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath))
const options = { ...parsed.options }
const host = ts.createCompilerHost(options)
// Calculate maps for the eventual package path, but capture every emit in scratch.
host.writeFile = (file, content) => fs.writeFileSync(path.join(staging, 'dist', path.basename(file)), content)
const getSourceFile = host.getSourceFile.bind(host), readFile = host.readFile.bind(host), fileExists = host.fileExists.bind(host)
host.fileExists = file => path.resolve(file) === virtualPath || fileExists(file)
host.readFile = file => path.resolve(file) === virtualPath ? source : readFile(file)
host.getSourceFile = (file, languageVersion, onError, shouldCreateNewSourceFile) => path.resolve(file) === virtualPath
  ? ts.createSourceFile(file, source, languageVersion, true)
  : getSourceFile(file, languageVersion, onError, shouldCreateNewSourceFile)
const program = ts.createProgram([virtualPath], options, host)
const diagnostics = ts.getPreEmitDiagnostics(program)
for (const diagnostic of diagnostics) console.log(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
if (diagnostics.length) process.exitCode = 1
else {
  const emitted = program.emit()
  console.log(`Shared compiler options: ${diagnostics.length} diagnostics; emitSkipped=${emitted.emitSkipped}`)
  process.exitCode = emitted.emitSkipped ? 1 : 0
}
