const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildProject,
  getBuildDiagnostics,
  parseGccDiagnostics,
} = require('../out/core/build.js');
const { detectProject, parseIocFile } = require('../out/core/project.js');

async function createFixture(options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stm32-workbench-'));
  await fs.mkdir(path.join(root, 'Core', 'Src'), { recursive: true });
  await fs.mkdir(path.join(root, 'Drivers'), { recursive: true });
  await fs.writeFile(path.join(root, 'Core', 'Src', 'main.c'), 'int main(void) { return 0; }\n');
  await fs.writeFile(path.join(root, 'Drivers', 'driver.h'), '#pragma once\n');

  if (options.cmake !== false) {
    await fs.writeFile(
      path.join(root, 'CMakeLists.txt'),
      'cmake_minimum_required(VERSION 3.20)\nproject(Fixture C)\n',
    );
  }
  if (options.ioc !== false) {
    await fs.writeFile(
      path.join(root, 'G474_Controller.ioc'),
      'Mcu.CPN=STM32G474VET6\nMcu.Name=STM32G474VETx\nMcu.Family=STM32G4\n',
    );
  }
  return root;
}

async function createFakeCmake(root) {
  const executable = path.join(root, 'fake-cmake');
  const script = `#!${process.execPath}\n` +
    `'use strict';\n` +
    `const fs = require('node:fs');\n` +
    `const path = require('node:path');\n` +
    `const args = process.argv.slice(2);\n` +
    `if (args[0] === '-S' && args[2] === '-B') {\n` +
    `  fs.mkdirSync(args[3], { recursive: true });\n` +
    `  fs.writeFileSync(path.join(args[3], 'CMakeCache.txt'), '# cache\\n');\n` +
    `  process.stdout.write('-- Configuring done\\n');\n` +
    `  process.exit(0);\n` +
    `}\n` +
    `if (args[0] === '--build' && process.env.STM32_TEST_FAIL === '1') {\n` +
    `  process.stderr.write("Core/Src/main.c:42:10: error: 'PWM_FREQ' undeclared\\n");\n` +
    `  process.stderr.write("Core/Src/main.c:43:3: warning: unused variable 'foo'\\n");\n` +
    `  process.exit(2);\n` +
    `}\n` +
    `if (args[0] === '--build') {\n` +
    `  process.stdout.write('[100%] Built target firmware\\n');\n` +
    `  process.exit(0);\n` +
    `}\n` +
    `process.exit(3);\n`;
  await fs.writeFile(executable, script, { mode: 0o755 });
  return executable;
}

test('detectProject reads exact MCU and family from .ioc', async (t) => {
  const root = await createFixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const info = await detectProject(root);
  assert.equal(info.detected, true);
  assert.equal(info.projectName, 'G474_Controller');
  assert.equal(info.mcu, 'STM32G474VET6');
  assert.equal(info.family, 'STM32G4');
  assert.equal(info.mcuDetection, 'exact');
  assert.equal(info.buildSystem, 'cmake');
  assert.deepEqual(await parseIocFile(info.iocPath), {
    mcu: 'STM32G474VET6',
    family: 'STM32G4',
  });
});

test('detectProject falls back to linker and startup names', async (t) => {
  const root = await createFixture({ ioc: false });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'STM32F407VGTX_FLASH.ld'), 'SECTIONS {}\n');
  await fs.writeFile(path.join(root, 'startup_stm32f407xx.s'), '/* startup */\n');

  const info = await detectProject(root);
  assert.equal(info.detected, true);
  assert.equal(info.mcu, 'STM32F407');
  assert.equal(info.family, 'STM32F4');
  assert.equal(info.mcuDetection, 'inferred');
  assert.equal(info.mcuSource, 'linker-script');
});

test('detectProject honors an inherited Debug CMake preset build directory', async (t) => {
  const root = await createFixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(root, 'CMakePresets.json'),
    JSON.stringify({
      version: 3,
      configurePresets: [
        {
          name: 'default',
          hidden: true,
          binaryDir: '${sourceDir}/build/${presetName}',
        },
        { name: 'Debug', inherits: 'default' },
      ],
      buildPresets: [{ name: 'Debug', configurePreset: 'Debug' }],
    }),
  );

  const info = await detectProject(root);
  assert.equal(info.buildDir, path.join(root, 'build', 'Debug'));
  assert.equal(info.configurePreset, 'Debug');
  assert.equal(info.buildPreset, 'Debug');
});

test('buildProject configures, builds, and returns structured diagnostics', async (t) => {
  const root = await createFixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const executable = await createFakeCmake(root);
  const info = await detectProject(root);

  const success = await buildProject(info, {
    cmakeExecutable: executable,
    forceConfigure: true,
  });
  assert.equal(success.success, true);
  assert.equal(success.stage, 'build');
  assert.equal(success.exitCode, 0);

  process.env.STM32_TEST_FAIL = '1';
  t.after(() => delete process.env.STM32_TEST_FAIL);
  const failure = await buildProject(info, { cmakeExecutable: executable });
  assert.equal(failure.success, false);
  assert.equal(failure.stage, 'build');
  assert.deepEqual(failure.errors[0], {
    severity: 'error',
    file: 'Core/Src/main.c',
    line: 42,
    column: 10,
    message: "'PWM_FREQ' undeclared",
  });
  assert.equal(failure.warnings.length, 1);
  assert.deepEqual(getBuildDiagnostics(), [
    ...failure.errors,
    ...failure.warnings,
  ]);
});

test('buildProject handles a missing CMake executable', async (t) => {
  const root = await createFixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const info = await detectProject(root);
  const result = await buildProject(info, {
    cmakeExecutable: 'stm32-workbench-cmake-does-not-exist',
    forceConfigure: true,
  });

  assert.equal(result.success, false);
  assert.equal(result.stage, 'configure');
  assert.equal(result.stderr, 'CMake executable not found');
});

test('parseGccDiagnostics supports absolute paths containing spaces', () => {
  assert.deepEqual(
    parseGccDiagnostics('/tmp/path with spaces/main.c:7:2: fatal error: boom'),
    [
      {
        severity: 'error',
        file: '/tmp/path with spaces/main.c',
        line: 7,
        column: 2,
        message: 'boom',
      },
    ],
  );
});
