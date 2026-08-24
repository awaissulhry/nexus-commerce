// Deterministic 3-step refresh of cfg.dtsPropsFor.
//
// gen-dts-props reads the EMITTED .d.ts bodies, so running it twice in a row
// reads its own output: components already fixed show nothing left to change and
// silently drop out of the map, which regresses them on the next clean build.
// The map must therefore always be derived from a build made WITHOUT it.
//
//   1. clear cfg.dtsPropsFor        → 2. build (clean ts-morph derivation)
//   3. gen-dts-props                → 4. build (apply)
//
// Run this instead of calling gen-dts-props by hand.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const configPath = join(repo, '.design-sync/config.json');
const run = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'ignore', 'inherit'], cwd: repo });

const build = () => run('node', ['.ds-sync/package-build.mjs',
  '--config', '.design-sync/config.json', '--node-modules', './node_modules',
  '--entry', '.design-sync/ds-pkg/index.ts', '--out', './ds-bundle']);

const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
delete cfg.dtsPropsFor;
const tmp = configPath + '.tmp';
writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n');
renameSync(tmp, configPath);
console.error('refresh-contracts: cleared dtsPropsFor — building clean derivation…');
build();
run('node', ['.design-sync/ds-pkg/gen-dts-props.mjs']);
console.error('refresh-contracts: applying…');
build();
console.error('refresh-contracts: done');
