const path = require('node:path');
const fs = require('node:fs');
const { runTests } = require('@vscode/test-electron');

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, '..', '..');
  const extensionTestsPath = path.resolve(__dirname, 'extension.test.cjs');
  const workspace = path.resolve(__dirname, '..', 'fixtures', 'extension-workspace');
  const localMacExecutable = '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
  const vscodeExecutablePath = process.env.VSCODE_EXECUTABLE_PATH ??
    (process.platform === 'darwin' && process.env.CI !== 'true' && fs.existsSync(localMacExecutable)
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
  });
}

main().catch((error) => {
  console.error('VS Code Extension Host integration test failed');
  console.error(error);
  process.exitCode = 1;
});
