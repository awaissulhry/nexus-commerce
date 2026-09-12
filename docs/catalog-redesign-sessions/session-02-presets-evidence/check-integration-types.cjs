const ts = require('/Users/awais/nexus-commerce/node_modules/typescript');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), cp = require('node:child_process');
const root = '/Users/awais/nexus-commerce';
const workspace = process.argv[2];
const relative = workspace === 'api' ? 'apps/api/src/services/listing-wizard/submission.service.ts' : 'apps/web/src/app/products/[id]/edit/_studio/sheet/channel/ChannelSheet.tsx';
const patch = workspace === 'api' ? 'submission-contract.patch' : 'information-mount.patch';
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-session-two-patch-types-'));
try {
  const copy = path.join(directory, relative); fs.mkdirSync(path.dirname(copy), {recursive:true}); fs.copyFileSync(path.join(root, relative), copy);
  cp.execFileSync('git', ['apply', path.join(root,'docs/catalog-redesign-sessions/session-02-presets-integration',patch)], {cwd:directory});
  const configPath = path.join(root,'apps',workspace,'tsconfig.json');
  const config = ts.readConfigFile(configPath,ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config,ts.sys,path.dirname(configPath));
  const options = {...parsed.options,noEmit:true,incremental:false}; delete options.tsBuildInfoFile;
  const host=ts.createCompilerHost(options); const read=host.readFile;
  host.readFile = file => path.resolve(file) === path.join(root,relative) ? fs.readFileSync(copy,'utf8') : read(file);
  const program=ts.createProgram(parsed.fileNames,options,host);
  const errors=ts.getPreEmitDiagnostics(program);
  if (errors.length) { console.log(ts.formatDiagnosticsWithColorAndContext(errors,{getCurrentDirectory:()=>root,getCanonicalFileName:p=>p,getNewLine:()=> '\n'})); process.exitCode=1; }
  else console.log('PASS: '+workspace+' types with exact '+patch+' in a virtual source override; shared working file untouched.');
} finally {fs.rmSync(directory,{recursive:true,force:true});}
