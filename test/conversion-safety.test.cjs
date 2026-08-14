const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { exportCmakeProjectToMdk } = require('../out/core/mdkExport.js');
const { importMdkProjectToCmake } = require('../out/core/mdkImport.js');

test('MDK import rejects a home-directory source root', async (t) => {
  const fixture = await createMdkFixture();
  const destination = await fs.mkdtemp(path.join(os.tmpdir(), 'stm32-dangerous-import-'));
  t.after(() => Promise.all([
    fs.rm(fixture.root, { recursive: true, force: true }),
    fs.rm(fixture.external, { recursive: true, force: true }),
    fs.rm(destination, { recursive: true, force: true }),
  ]));
  const result = await importMdkProjectToCmake(fixture.projectFile, {
    destinationDirectory: destination,
    sourceRoot: os.homedir(),
    targetName: 'SafeTarget',
  });
  assert.equal(result.success, false);
  assert.match(result.error, /broad system or home-directory root/);
  assert.deepEqual(await fs.readdir(destination), []);
});

test('MDK import rejects a broad home include directory', async (t) => {
  const fixture = await createMdkFixture();
  const destination = await fs.mkdtemp(path.join(os.tmpdir(), 'stm32-dangerous-include-'));
  t.after(() => Promise.all([
    fs.rm(fixture.root, { recursive: true, force: true }),
    fs.rm(fixture.external, { recursive: true, force: true }),
    fs.rm(destination, { recursive: true, force: true }),
  ]));
  const xml = await fs.readFile(fixture.projectFile, 'utf8');
  await fs.writeFile(
    fixture.projectFile,
    xml.replace(path.join(fixture.external, 'Inc'), os.homedir()),
  );
  const result = await importMdkProjectToCmake(fixture.projectFile, {
    destinationDirectory: destination,
    sourceRoot: fixture.root,
    targetName: 'SafeTarget',
  });
  assert.equal(result.success, false);
  assert.match(result.error, /broad input directory/);
});

test('MDK import copies selected inputs and external headers without broad tree copies', async (t) => {
  const fixture = await createMdkFixture();
  const destination = await fs.mkdtemp(path.join(os.tmpdir(), 'stm32-selected-import-'));
  t.after(() => Promise.all([
    fs.rm(fixture.root, { recursive: true, force: true }),
    fs.rm(fixture.external, { recursive: true, force: true }),
    fs.rm(destination, { recursive: true, force: true }),
  ]));
  const result = await importMdkProjectToCmake(fixture.projectFile, {
    destinationDirectory: destination,
    sourceRoot: fixture.root,
    targetName: 'SafeTarget',
  });
  assert.equal(result.success, true, result.error);
  assert.equal(await exists(path.join(destination, 'secret-do-not-copy.txt')), false);
  assert.equal((await findFiles(destination, 'embedded.c')).length, 1);
  assert.equal((await findFiles(destination, 'unused.c')).length, 0);
  assert.equal((await findFiles(destination, 'ext.h')).length, 1);
  assert.equal((await findFiles(destination, 'unused.bin')).length, 0);
  assert.match(result.warnings.join('\n'), /scatter file.*retained/i);
  assert.match(result.warnings.join('\n'), /\.lib files were copied/i);
  const reportText = await fs.readFile(
    path.join(destination, '.stm32-workbench', 'mdk-import.json'),
    'utf8',
  );
  assert.doesNotMatch(reportText, new RegExp(escapeRegExp(os.homedir())));
  const report = JSON.parse(reportText);
  assert.equal(report.sourceProjectFile, 'project.uvprojx');
  assert.equal(report.projectDirectory, '.');
});

test('MDK import requires an explicit target when a project has multiple targets', async (t) => {
  const fixture = await createMdkFixture(true);
  const destination = await fs.mkdtemp(path.join(os.tmpdir(), 'stm32-multi-target-'));
  t.after(() => Promise.all([
    fs.rm(fixture.root, { recursive: true, force: true }),
    fs.rm(fixture.external, { recursive: true, force: true }),
    fs.rm(destination, { recursive: true, force: true }),
  ]));
  const result = await importMdkProjectToCmake(fixture.projectFile, {
    destinationDirectory: destination,
    sourceRoot: fixture.root,
  });
  assert.equal(result.success, false);
  assert.match(result.error, /Multiple MDK targets/);
});

test('CMake export resolves relative commands and preserves per-file options', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stm32-relative-export-'));
  const destination = await fs.mkdtemp(path.join(os.tmpdir(), 'stm32-relative-destination-'));
  t.after(() => Promise.all([
    fs.rm(root, { recursive: true, force: true }),
    fs.rm(destination, { recursive: true, force: true }),
  ]));
  await fs.mkdir(path.join(root, 'Src'), { recursive: true });
  await fs.mkdir(path.join(root, 'Inc'), { recursive: true });
  await fs.mkdir(path.join(root, 'build'), { recursive: true });
  await fs.writeFile(path.join(root, 'Src', 'main.c'), '#include "used.h"\nint main(void){return USED;}\n');
  await fs.writeFile(path.join(root, 'Src', 'worker.c'), '#include "used.h"\nint worker(void){return USED;}\n');
  await fs.writeFile(path.join(root, 'Inc', 'used.h'), '#define USED 1\n');
  await fs.writeFile(path.join(root, 'Inc', 'unused.h'), '#define UNUSED 1\n');
  await fs.writeFile(path.join(root, 'STM32F103C8TX_FLASH.ld'), 'MEMORY { FLASH (rx) : ORIGIN = 0x08000000, LENGTH = 64K RAM (xrw) : ORIGIN = 0x20000000, LENGTH = 20K }\n');
  await fs.writeFile(path.join(root, 'build', 'compile_commands.json'), JSON.stringify([
    {
      directory: '..',
      arguments: ['arm-none-eabi-gcc', '-I', 'Inc', '-D', 'STM32F103xB', '-DLOCAL_MAIN=1', '-O1', '-c', 'Src/main.c'],
      file: 'Src/main.c',
    },
    {
      directory: '..',
      command: 'arm-none-eabi-gcc -I Inc -D STM32F103xB -DLOCAL_WORKER=1 -O2 -c Src/worker.c',
      file: 'Src/worker.c',
    },
  ], undefined, 2));
  const result = await exportCmakeProjectToMdk({
    detected: true,
    workspacePath: root,
    projectRoot: root,
    projectName: 'RelativeOptions',
    mcu: 'STM32F103C8T6',
    family: 'STM32F1',
    mcuDetection: 'exact',
    buildSystem: 'cmake',
    buildDir: path.join(root, 'build'),
    evidence: [],
  }, { destinationDirectory: destination });
  assert.equal(result.success, true, result.error);
  const project = await fs.readFile(result.projectFile, 'utf8');
  assert.match(project, /<Define>STM32F103xB<\/Define>/);
  assert.match(project, /LOCAL_MAIN=1/);
  assert.match(project, /LOCAL_WORKER=1/);
  assert.match(project, /-O1/);
  assert.match(project, /-O2/);
  assert.equal((await findFiles(destination, 'used.h')).length, 1);
  assert.equal((await findFiles(destination, 'unused.h')).length, 0);
  const reportText = await fs.readFile(path.join(destination, 'stm32-workbench-export.json'), 'utf8');
  assert.doesNotMatch(reportText, new RegExp(escapeRegExp(os.homedir())));
});

test('CMake export refuses non-empty destinations and unknown MCUs by default', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stm32-refuse-export-'));
  const destination = await fs.mkdtemp(path.join(os.tmpdir(), 'stm32-nonempty-export-'));
  t.after(() => Promise.all([
    fs.rm(root, { recursive: true, force: true }),
    fs.rm(destination, { recursive: true, force: true }),
  ]));
  await fs.mkdir(path.join(root, 'build'), { recursive: true });
  await fs.writeFile(path.join(root, 'main.c'), 'int main(void){return 0;}\n');
  await fs.writeFile(path.join(root, 'build', 'compile_commands.json'), JSON.stringify([{
    directory: root,
    arguments: ['arm-none-eabi-gcc', '-c', 'main.c'],
    file: 'main.c',
  }]));
  await fs.writeFile(path.join(destination, 'keep.txt'), 'keep');
  const project = {
    detected: true,
    workspacePath: root,
    projectRoot: root,
    projectName: 'Refuse',
    buildSystem: 'cmake',
    buildDir: path.join(root, 'build'),
    evidence: [],
  };
  const unknown = await exportCmakeProjectToMdk(project, { destinationDirectory: destination });
  assert.equal(unknown.success, false);
  assert.match(unknown.error, /MCU could not be identified/);
  const nonEmpty = await exportCmakeProjectToMdk(
    { ...project, mcu: 'STM32G474VET6' },
    { destinationDirectory: destination },
  );
  assert.equal(nonEmpty.success, false);
  assert.match(nonEmpty.error, /not empty/);
  assert.equal(await fs.readFile(path.join(destination, 'keep.txt'), 'utf8'), 'keep');
});

async function createMdkFixture(multipleTargets = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stm32-safe-mdk-'));
  const external = await fs.mkdtemp(path.join(os.tmpdir(), 'stm32-external-dependency-'));
  await fs.mkdir(path.join(root, 'Src'), { recursive: true });
  await fs.mkdir(path.join(root, 'Inc'), { recursive: true });
  await fs.mkdir(path.join(external, 'Src'), { recursive: true });
  await fs.mkdir(path.join(external, 'Inc'), { recursive: true });
  await fs.writeFile(path.join(root, 'Src', 'main.c'), '#include "main.h"\n#include "embedded.c"\nint main(void){return embedded();}\n');
  await fs.writeFile(path.join(root, 'Src', 'embedded.c'), 'static int embedded(void){return 0;}\n');
  await fs.writeFile(path.join(root, 'Src', 'unused.c'), 'int unused(void){return 0;}\n');
  await fs.writeFile(path.join(root, 'Inc', 'main.h'), '#pragma once\n');
  await fs.writeFile(path.join(external, 'Src', 'ext.c'), '#include "ext.h"\n');
  await fs.writeFile(path.join(external, 'Inc', 'ext.h'), '#pragma once\n');
  await fs.writeFile(path.join(external, 'Inc', 'unused.bin'), Buffer.alloc(64));
  await fs.writeFile(path.join(root, 'startup_stm32f407xx.s'), 'AREA RESET, DATA, READONLY\n');
  await fs.writeFile(path.join(root, 'startup_stm32f407xx.S'), '.syntax unified\n.global Reset_Handler\nReset_Handler: b .\n');
  await fs.writeFile(path.join(root, 'custom.sct'), 'LR_IROM1 0x08000000 0x00100000 {}\n');
  await fs.writeFile(path.join(root, 'vendor.lib'), Buffer.alloc(16));
  await fs.writeFile(path.join(root, 'secret-do-not-copy.txt'), 'secret');
  const target = (name) => `<Target><TargetName>${name}</TargetName><uAC6>0</uAC6><TargetOption><TargetCommonOption><Device>STM32F407ZGTx</Device><Cpu>IROM(0x08000000,0x00100000) IRAM(0x20000000,0x00020000)</Cpu></TargetCommonOption><TargetArmAds><Cads><VariousControls><Define>STM32F407xx</Define><IncludePath>${path.join(root, 'Inc')};${path.join(external, 'Inc')}</IncludePath></VariousControls></Cads><LDads><ScatterFile>custom.sct</ScatterFile></LDads></TargetArmAds></TargetOption><Groups><Group><Files><File><FilePath>Src/main.c</FilePath></File><File><FilePath>${path.join(external, 'Src', 'ext.c')}</FilePath></File><File><FilePath>startup_stm32f407xx.s</FilePath></File><File><FilePath>vendor.lib</FilePath></File></Files></Group></Groups></Target>`;
  const projectFile = path.join(root, 'project.uvprojx');
  await fs.writeFile(projectFile, `<Project><Targets>${target('SafeTarget')}${multipleTargets ? target('SecondTarget') : ''}</Targets></Project>`);
  return { root, external, projectFile };
}

async function findFiles(root, basename) {
  const result = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile() && entry.name === basename) result.push(candidate);
    }
  }
  return result;
}

async function exists(candidate) {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
