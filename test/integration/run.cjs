const path = require('node:path');
const fs = require('node:fs');
const { runTests } = require('@vscode/test-electron');

async function main() {
  const extensionDevelopmentPath = process.env.EXTENSION_DEVELOPMENT_PATH === undefined
    ? path.resolve(__dirname, '..', '..')
    : path.resolve(process.env.EXTENSION_DEVELOPMENT_PATH);
  const extensionTestsPath = path.resolve(__dirname, 'extension.test.cjs');
  const workspace = path.resolve(__dirname, '..', 'fixtures', 'extension-workspace');
  const localMacExecutable = '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
  const requestedVersion = process.env.VSCODE_TEST_VERSION;
  const downloadTimeout = Number(process.env.VSCODE_DOWNLOAD_TIMEOUT_MS ?? '120000');
  if (!Number.isFinite(downloadTimeout) || downloadTimeout <= 0) {
    throw new Error('VSCODE_DOWNLOAD_TIMEOUT_MS must be a positive number');
  }
  const vscodeExecutablePath = process.env.VSCODE_EXECUTABLE_PATH ??
    (requestedVersion === undefined && process.platform === 'darwin' &&
      process.env.CI !== 'true' && fs.existsSync(localMacExecutable)
      ? localMacExecutable
      : undefined);
  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [
      workspace,
      '--disable-extensions',
      '--disable-gpu',
      '--skip-release-notes',
      '--skip-welcome',
    ],
    ...(vscodeExecutablePath
      ? { vscodeExecutablePath }
      : {}),
    ...(requestedVersion
      ? { version: requestedVersion, timeout: downloadTimeout }
      : {}),
  });
}

main().catch((error) => {
  console.error('VS Code Extension Host integration test failed');
  console.error(error);
  process.exitCode = 1;
});
