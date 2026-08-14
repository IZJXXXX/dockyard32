import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const archive = resolve(process.argv[2] ?? 'stm32-workbench-0.1.0.vsix');
const entries = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' })
  .split(/\r?\n/u)
  .filter(Boolean);
const manifest = JSON.parse(execFileSync(
  'unzip',
  ['-p', archive, 'extension/package.json'],
  { encoding: 'utf8' },
));
if (typeof manifest.icon !== 'string' || !manifest.icon.toLowerCase().endsWith('.png')) {
  throw new Error('Marketplace icon must be a PNG declared by package.json');
}
const iconEntry = `extension/${manifest.icon}`;
const icon = execFileSync('unzip', ['-p', archive, iconEntry]);
if (
  icon.length < 24 ||
  icon.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
  icon.readUInt32BE(16) < 128 ||
  icon.readUInt32BE(20) < 128
) {
  throw new Error('Marketplace icon must be a valid PNG at least 128×128');
}
const required = [
  'extension/package.json',
  iconEntry,
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
  /(?:^|\/)\._[^/]*$/u,
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
