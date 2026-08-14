const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

async function run() {
  const extension = vscode.extensions.getExtension('izjxxxx.stm32-workbench');
  assert.ok(extension, 'STM32 Workbench extension should be discoverable');

  await extension.activate();
  assert.equal(extension.isActive, true, 'extension should activate successfully');

  const commands = await vscode.commands.getCommands(true);
  assert.ok(
    commands.includes('stm32Workbench.refresh'),
    'Phase 1 refresh command should remain registered',
  );
  assert.ok(
    commands.includes('stm32Workbench.build'),
    'Phase 2 build command should be registered',
  );
  assert.ok(
    commands.includes('stm32Workbench.run'),
    'Phase 5 Build & Run command should be registered',
  );
  assert.ok(
    commands.includes('stm32Workbench.flash'),
    'Phase 3 flash command should be registered',
  );
  assert.ok(
    commands.includes('stm32Workbench.reset'),
    'Phase 3 reset command should be registered',
  );
  assert.ok(
    commands.includes('stm32Workbench.openSerial'),
    'Phase 4 serial monitor command should be registered',
  );
  assert.ok(
    commands.includes('stm32Workbench.showMcpSetup'),
    'Phase 6 MCP setup command should be registered',
  );
  assert.ok(
    commands.includes('stm32Workbench.refreshProjectFiles'),
    'Project Files refresh command should be registered',
  );
  assert.ok(
    commands.includes('stm32Workbench.showProjectFiles'),
    'Status project row should navigate to Project Files',
  );
  assert.ok(
    commands.includes('stm32Workbench.openProjectFile'),
    'Project Files should open files in native editor tabs',
  );
  assert.ok(
    commands.includes('stm32Workbench.openProjectFileWithAi'),
    'Project Files should offer an AI-assisted open action',
  );
  assert.ok(
    commands.includes('stm32Workbench.openAiAssistant'),
    'Actions view should expose the native VS Code AI assistant',
  );

  const workbenchViews = extension.packageJSON.contributes.views['stm32-workbench'];
  assert.deepEqual(
    workbenchViews.map((view) => view.id),
    [
      'stm32Workbench.overview',
      'stm32Workbench.projectFiles',
      'stm32Workbench.actions',
    ],
    'Workbench should separate status, project files, and actions',
  );
  assert.ok(
    workbenchViews.every((view) => view.visibility === 'visible'),
    'All Workbench views should be visible by default',
  );
  const overviewTitleCommands = extension.packageJSON.contributes.menus['view/title']
    .filter((item) => item.when === 'view == stm32Workbench.overview')
    .map((item) => item.command);
  assert.deepEqual(
    overviewTitleCommands,
    [
      'stm32Workbench.refresh',
      'stm32Workbench.run',
      'stm32Workbench.build',
      'stm32Workbench.flash',
      'stm32Workbench.openSerial',
    ],
    'Overview title should expose the compact Workbench shortcuts',
  );

  await vscode.commands.executeCommand('stm32Workbench.showProjectFiles');

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
