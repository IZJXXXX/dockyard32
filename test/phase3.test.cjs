const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { getDeviceStatus, parseStLinkList } = require('../out/core/device.js');
const {
  findFirmwareArtifact,
  flashFirmware,
  parseConnectedChip,
  resetTarget,
} = require('../out/core/flash.js');
const { discoverDevelopmentTools } = require('../out/core/tools.js');

async function makeExecutable(filePath, content = '#!/bin/sh\nexit 0\n') {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, { mode: 0o755 });
}

async function createProgrammer(root) {
  const executable = path.join(root, 'STM32_Programmer_CLI');
  const script =
    `#!${process.execPath}\n` +
    `'use strict';\n` +
    `const fs = require('node:fs');\n` +
    `const args = process.argv.slice(2);\n` +
    `if (process.env.STM32_ARGS_FILE) { fs.writeFileSync(process.env.STM32_ARGS_FILE, JSON.stringify(args)); }\n` +
    `if (args[0] === '-l') {\n` +
    `  process.stdout.write('===== STLink Interface =====\\nDevice Index : 0\\nSerial number : 003200343334510B39343638\\nFirmware version : V2J45S7\\nBoard : STLINK-V3SET\\n');\n` +
    `  process.exit(0);\n` +
    `}\n` +
    `if (args.includes('-w')) {\n` +
    `  process.stdout.write('Device name : STM32G474VE\\nDownload verified successfully\\n');\n` +
    `  process.exit(process.env.STM32_PROGRAMMER_FAIL === '1' ? 2 : 0);\n` +
    `}\n` +
    `if (args.includes('-rst')) {\n` +
    `  process.stdout.write('Device name : STM32F407VG\\nReset mode : Software reset\\n');\n` +
    `  process.exit(0);\n` +
    `}\n` +
    `process.exit(3);\n`;
  await makeExecutable(executable, script);
  return executable;
}

function projectInfo(root) {
  return {
    detected: true,
    workspacePath: root,
    projectRoot: root,
    projectName: 'Controller',
    mcuDetection: 'exact',
    buildSystem: 'cmake',
    buildDir: path.join(root, 'build'),
    evidence: ['.ioc', 'CMakeLists.txt'],
  };
}

test('tool discovery honors configured paths and finds STM32 tools in known roots', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stm32-tools-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const configuredCmake = path.join(root, 'configured', 'cmake');
  const programmer = path.join(
    root,
    'STM32CubeProgrammer.app',
    'Contents',
    'Resources',
    'bin',
    'STM32_Programmer_CLI',
  );
  const gcc = path.join(root, 'STM32CubeCLT', 'GNU-tools-for-STM32', 'bin', 'arm-none-eabi-gcc');
  await Promise.all([
    makeExecutable(configuredCmake),
    makeExecutable(programmer),
    makeExecutable(gcc),
  ]);

  const tools = await discoverDevelopmentTools({
    configured: { cmake: configuredCmake },
    env: { PATH: '' },
    searchRoots: [root],
  });
  assert.equal(tools.cmake.executable, configuredCmake);
  assert.equal(tools.cmake.source, 'configured');
  assert.equal(tools.programmer.executable, programmer);
  assert.equal(tools.programmer.source, 'application');
  assert.equal(tools.armGcc.executable, gcc);
  assert.equal(tools.ninja.available, false);
});

test('tool discovery supports versioned STM32Cube VS Code bundles and prefers newer versions', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stm32-bundles-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const olderCmake = path.join(root, 'cmake', '3.31.0', 'CMake.app', 'Contents', 'bin', 'cmake');
  const newerCmake = path.join(root, 'cmake', '4.3.1+st.1', 'CMake.app', 'Contents', 'bin', 'cmake');
  const ninja = path.join(root, 'ninja', '1.13.2+st.1', 'bin', 'ninja');
  const gcc = path.join(root, 'gnu-tools-for-stm32', '14.3.1+st.2', 'bin', 'arm-none-eabi-gcc');
  const programmer = path.join(root, 'programmer', '2.23.0', 'bin', 'STM32_Programmer_CLI');
  await Promise.all([
    makeExecutable(olderCmake),
    makeExecutable(newerCmake),
    makeExecutable(ninja),
    makeExecutable(gcc),
    makeExecutable(programmer),
  ]);

  const tools = await discoverDevelopmentTools({
    env: { PATH: '' },
    searchRoots: [root],
  });
  assert.equal(tools.cmake.executable, newerCmake);
  assert.equal(tools.ninja.executable, ninja);
  assert.equal(tools.armGcc.executable, gcc);
  assert.equal(tools.programmer.executable, programmer);
  assert.equal(tools.programmer.source, 'stm32cube');
});

test('ST-LINK list parsing and device status return structured probes', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stm32-probe-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const programmer = await createProgrammer(root);
  const status = await getDeviceStatus(programmer);

  assert.equal(status.programmerAvailable, true);
  assert.equal(status.probeConnected, true);
  assert.deepEqual(status.probes, [
    {
      index: 0,
      serialNumber: '003200343334510B39343638',
      firmwareVersion: 'V2J45S7',
      board: 'STLINK-V3SET',
    },
  ]);
  assert.equal(parseStLinkList('Total number of available STM32 device in STLink mode: 0').length, 0);
});

test('flash selects the named ELF and invokes SWD write with verify', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stm32-flash-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const buildDir = path.join(root, 'build', 'Debug');
  await fs.mkdir(buildDir, { recursive: true });
  const elf = path.join(buildDir, 'Controller.elf');
  await fs.writeFile(elf, 'ELF');
  await fs.writeFile(path.join(buildDir, 'Other.hex'), 'HEX');
  const programmer = await createProgrammer(root);
  const argsFile = path.join(root, 'args.json');
  process.env.STM32_ARGS_FILE = argsFile;
  t.after(() => delete process.env.STM32_ARGS_FILE);

  const project = projectInfo(root);
  assert.equal(await findFirmwareArtifact(project), elf);
  const result = await flashFirmware(project, {
    programmerExecutable: programmer,
    verify: true,
  });
  assert.equal(result.success, true);
  assert.equal(result.firmwarePath, elf);
  assert.equal(result.chip, 'STM32G474VE');
  assert.deepEqual(JSON.parse(await fs.readFile(argsFile, 'utf8')), [
    '-c',
    'port=SWD',
    '-w',
    elf,
    '-v',
  ]);
});

test('reset invokes an independent SWD reset operation', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stm32-reset-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const programmer = await createProgrammer(root);
  const argsFile = path.join(root, 'args.json');
  process.env.STM32_ARGS_FILE = argsFile;
  t.after(() => delete process.env.STM32_ARGS_FILE);

  const result = await resetTarget({ programmerExecutable: programmer });
  assert.equal(result.success, true);
  assert.equal(result.chip, 'STM32F407VG');
  assert.deepEqual(JSON.parse(await fs.readFile(argsFile, 'utf8')), [
    '-c',
    'port=SWD',
    '-rst',
  ]);
});

test('programmer operations fail clearly when tools or firmware are missing', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stm32-missing-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const noTool = await getDeviceStatus();
  assert.equal(noTool.programmerAvailable, false);
  assert.equal(noTool.error, 'STM32CubeProgrammer CLI not found');

  const noFirmware = await flashFirmware(projectInfo(root), {
    programmerExecutable: '/does/not/matter',
  });
  assert.equal(noFirmware.success, false);
  assert.equal(noFirmware.error, 'No ELF or HEX firmware found in the build directory');
  assert.equal(
    parseConnectedChip(
      '\u001b[36mSTM32CubeProgrammer v2.23.0\u001b[0m\n' +
        '\u001b[39mDevice name : STM32F405xx/F407xx/F415xx/F417xx\u001b[0m',
    ),
    'STM32F405XX/F407XX/F415XX/F417XX',
  );
  assert.equal(parseConnectedChip('random output'), undefined);
});
