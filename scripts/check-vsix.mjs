import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const archive = resolve(process.argv[2] ?? 'stm32-workbench-0.1.0.vsix');
const entries = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' })
  .split(/\r?\n/u)
  .filter(Boolean);
const required = [
  'extension/package.json',
  'extension/out/extension.js',
  'extension/node_modules/jsonc-parser/package.json',
  'extension/node_modules/serialport/package.json',
  'extension/node_modules/@modelcontextprotocol/sdk/package.json',
  'extension/node_modules/@serialport/bindings-cpp/prebuilds/darwin-x64+arm64/@serialport+bindings-cpp.node',
];
for (const expected of required) {
  if (!entries.includes(expected)) {
    throw new Error(`VSIX is missing required runtime file: ${expected}`);
  }
}
const forbidden = [
  /(?:^|\/)package-lock\.json$/u,
  /(?:^|\/)\.DS_Store$/u,
  /extension\/node_modules\/\.pnpm\//u,
  /extension\/src\//u,
  /extension\/test\//u,
];
for (const entry of entries) {
  if (forbidden.some((pattern) => pattern.test(entry))) {
    throw new Error(`VSIX contains forbidden development file: ${entry}`);
  }
}
console.log(`VSIX verified: ${archive} (${entries.length} entries)`);
