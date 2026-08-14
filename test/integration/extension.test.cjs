const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

async function run() {
  const manifest = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'),
  );
  const extensionId = `${manifest.publisher}.${manifest.name}`;
  const extension = vscode.extensions.getExtension(extensionId);
  assert.ok(extension, 'Dockyard32 extension should be discoverable');

  await extension.activate();
  assert.equal(extension.isActive, true, 'extension should activate successfully');

  const commands = await vscode.commands.getCommands(true);
  assert.ok(
    commands.includes('dockyard32.refresh'),
    'Phase 1 refresh command should remain registered',
  );
  assert.ok(
    commands.includes('dockyard32.build'),
    'Phase 2 build command should be registered',
  );
  assert.ok(
    commands.includes('dockyard32.run'),
    'Phase 5 Build & Run command should be registered',
  );
  assert.ok(
    commands.includes('dockyard32.flash'),
    'Phase 3 flash command should be registered',
  );
  assert.ok(
    commands.includes('dockyard32.reset'),
    'Phase 3 reset command should be registered',
  );
  assert.ok(
    commands.includes('dockyard32.openSerial'),
    'Phase 4 serial monitor command should be registered',
  );
  assert.ok(
    commands.includes('dockyard32.showMcpSetup'),
    'Phase 6 MCP setup command should be registered',
  );
  assert.ok(
    commands.includes('dockyard32.refreshProjectFiles'),
    'Project Files refresh command should be registered',
  );
  assert.ok(
    commands.includes('dockyard32.showProjectFiles'),
    'Status project row should navigate to Project Files',
  );
  assert.ok(
    commands.includes('dockyard32.openProjectFile'),
    'Project Files should open files in native editor tabs',
  );
  assert.ok(
    commands.includes('dockyard32.openProjectFileWithAi'),
    'Project Files should offer an AI-assisted open action',
  );
  assert.ok(
    commands.includes('dockyard32.openAiAssistant'),
    'Actions view should expose the native VS Code AI assistant',
  );

  const dockyardViews = extension.packageJSON.contributes.views['dockyard32'];
  assert.deepEqual(
    dockyardViews.map((view) => view.id),
    [
      'dockyard32.overview',
      'dockyard32.projectFiles',
      'dockyard32.actions',
    ],
    'Dockyard32 should separate status, project files, and actions',
  );
  assert.ok(
    dockyardViews.every((view) => view.visibility === 'visible'),
    'All Dockyard32 views should be visible by default',
  );
  const overviewTitleCommands = extension.packageJSON.contributes.menus['view/title']
    .filter((item) => item.when === 'view == dockyard32.overview')
    .map((item) => item.command);
  assert.deepEqual(
    overviewTitleCommands,
    [
      'dockyard32.refresh',
      'dockyard32.run',
      'dockyard32.build',
      'dockyard32.flash',
      'dockyard32.openSerial',
    ],
    'Overview title should expose the compact Dockyard32 shortcuts',
  );

  await vscode.commands.executeCommand('dockyard32.showProjectFiles');

  const { SerialService } = require(path.join(
    extension.extensionPath,
    'out/core/serial.js',
  ));
  const serialService = new SerialService();
  const ports = await serialService.listSerialPorts();
  assert.ok(Array.isArray(ports), 'isolated serial backend should enumerate');
  assert.equal(
    serialService.getSerialStatus().lastError,
    undefined,
    'isolated serial backend should remain healthy',
  );
  serialService.dispose();

  const holdMs = Number(process.env.STM32_EXTENSION_TEST_HOLD_MS ?? 0);
  if (Number.isFinite(holdMs) && holdMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, holdMs));
  }

  if (process.env.STM32_EXTENSION_TEST_MARKER) {
    fs.writeFileSync(process.env.STM32_EXTENSION_TEST_MARKER, 'passed\n');
  }
}

module.exports = { run };
