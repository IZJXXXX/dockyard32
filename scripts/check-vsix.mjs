import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const expectedTarget = 'darwin-arm64';
const packageVersion = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;
const archive = resolve(
  process.argv[2] ?? `stm32-workbench-${packageVersion}-${expectedTarget}.vsix`,
);
const entries = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' })
  .split(/\r?\n/u)
  .filter(Boolean);
const manifest = JSON.parse(execFileSync(
  'unzip',
  ['-p', archive, 'extension/package.json'],
  { encoding: 'utf8' },
));
const vsixManifest = execFileSync(
  'unzip',
  ['-p', archive, 'extension.vsixmanifest'],
  { encoding: 'utf8' },
);
if (!new RegExp(`TargetPlatform="${expectedTarget}"`, 'u').test(vsixManifest)) {
  throw new Error(`VSIX manifest must declare TargetPlatform=${expectedTarget}`);
}
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
  /extension\/node_modules\/@serialport\/bindings-cpp\/prebuilds\/(?:android|linux|win32)-/u,
  /extension\/node_modules\/@serialport\/bindings-cpp\/(?:build|src)\//u,
  /extension\/node_modules\/@serialport\/bindings-cpp\/binding\.gyp$/u,
];
for (const entry of entries) {
  if (forbidden.some((pattern) => pattern.test(entry))) {
    throw new Error(`VSIX contains forbidden development file: ${entry}`);
  }
}

const nativeEntries = entries.filter((entry) => entry.endsWith('.node'));
if (
  nativeEntries.length !== 1 ||
  nativeEntries[0] !==
    'extension/node_modules/@serialport/bindings-cpp/prebuilds/darwin-x64+arm64/@serialport+bindings-cpp.node'
) {
  throw new Error(`VSIX contains unexpected native modules: ${nativeEntries.join(', ')}`);
}

const textEntries = entries.filter(isScannableTextEntry);
const sensitivePatterns = [
  { name: 'macOS user path', pattern: /\/Users\/[^/\s"']+\//u, projectOnly: true },
  { name: 'Linux user path', pattern: /\/home\/[^/\s"']+\//u, projectOnly: true },
  { name: 'Windows user path', pattern: /[A-Za-z]:\\Users\\[^\\\s"']+\\/u, projectOnly: true },
  {
    name: 'private key',
    pattern: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\r\n]+[A-Za-z0-9+/=\r\n]{80,}-----END/u,
  },
  { name: 'GitHub token', pattern: /(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})/u },
  { name: 'OpenAI-style secret key', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/u },
  { name: 'Slack token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u },
  { name: 'AWS access key', pattern: /\bAKIA[0-9A-Z]{16}\b/u },
];
for (const entry of textEntries) {
  const contents = execFileSync('unzip', ['-p', archive, entry], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  for (const sensitive of sensitivePatterns) {
    if (sensitive.projectOnly && entry.startsWith('extension/node_modules/')) {
      continue;
    }
    if (sensitive.pattern.test(contents)) {
      throw new Error(`VSIX privacy scan found ${sensitive.name} in ${entry}`);
    }
  }
}

function isScannableTextEntry(entry) {
  return (
    entry !== '[Content_Types].xml' &&
    (entry === 'extension.vsixmanifest' ||
      /\.(?:cjs|css|d\.ts|html|inc|js|json|lock|md|mjs|svg|txt|xml|ya?ml)$/iu.test(entry))
  );
}
console.log(`VSIX verified: ${archive} (${entries.length} entries)`);
