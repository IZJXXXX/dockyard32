const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  gccArchitectureFlags,
  normalizeStm32Device,
  stm32DeviceProfile,
} = require('../out/core/stm32Device.js');
const { exportCmakeProjectToMdk } = require('../out/core/mdkExport.js');
const { importMdkProjectToCmake } = require('../out/core/mdkImport.js');
const { parseMdkProject } = require('../out/core/mdk.js');

test('device profiles cover representative F1, F4, and G4 parts', () => {
  const f1 = stm32DeviceProfile('STM32F103C8T6');
  assert.equal(f1.device, 'STM32F103C8Tx');
  assert.equal(f1.family, 'STM32F1');
  assert.equal(f1.cortex, 'Cortex-M3');
  assert.equal(f1.defaultFlashBytes, 64 * 1024);
  assert.equal(f1.defaultRamBytes, 20 * 1024);
  assert.deepEqual(gccArchitectureFlags(f1), ['-mcpu=cortex-m3', '-mthumb']);

  const f4 = stm32DeviceProfile('STM32F407ZGT6');
  assert.equal(f4.family, 'STM32F4');
  assert.equal(f4.defaultFlashBytes, 1024 * 1024);
  assert.equal(f4.defaultRamBytes, 128 * 1024);
  assert.equal(f4.defaultCcmRamBytes, 64 * 1024);
  assert.deepEqual(gccArchitectureFlags(f4), [
    '-mcpu=cortex-m4', '-mthumb', '-mfpu=fpv4-sp-d16', '-mfloat-abi=hard',
  ]);

  const g4 = stm32DeviceProfile('STM32G474VET6');
  assert.equal(g4.device, 'STM32G474VETx');
  assert.equal(g4.family, 'STM32G4');
  assert.equal(g4.defaultFlashBytes, 512 * 1024);
  assert.equal(g4.defaultRamBytes, 128 * 1024);
  assert.equal(g4.defaultCcmRamBytes, 32 * 1024);
  assert.equal(normalizeStm32Device('STM32F103CBTx'), 'STM32F103CBTx');
});

for (const fixture of [
  { name: 'F103', device: 'STM32F103C8T6', define: 'STM32F103xB', cpu: 'cortex-m3', flash: '0x00010000', ram: '0x00005000' },
  { name: 'F407', device: 'STM32F407ZGT6', define: 'STM32F407xx', cpu: 'cortex-m4', flash: '0x00100000', ram: '0x00020000' },
  { name: 'G474', device: 'STM32G474VET6', define: 'STM32G474xx', cpu: 'cortex-m4', flash: '0x00080000', ram: '0x00020000' },
]) {
  test(`CMake export creates correct ${fixture.name} Keil architecture and defaults`, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `stm32-${fixture.name.toLowerCase()}-export-`));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.mkdir(path.join(root, 'Src'), { recursive: true });
    await fs.mkdir(path.join(root, 'Inc'), { recursive: true });
    await fs.mkdir(path.join(root, 'build'), { recursive: true });
    const source = path.join(root, 'Src', 'main.c');
    await fs.writeFile(source, 'int main(void) { for (;;) {} }\n');
    await fs.writeFile(path.join(root, 'CMakeLists.txt'), `project(${fixture.name} C)\n`);
    await fs.writeFile(path.join(root, 'build', 'compile_commands.json'), JSON.stringify([{
      directory: path.join(root, 'build'),
      command: `arm-none-eabi-gcc -D${fixture.define} -I${path.join(root, 'Inc')} -c ${source}`,
      file: source,
    }]));
    const destination = path.join(root, 'MDK-ARM');
    const result = await exportCmakeProjectToMdk({
      detected: true,
      projectRoot: root,
      projectName: fixture.name,
      mcu: fixture.device,
      mcuDetection: 'exact',
      buildSystem: 'cmake',
      buildDir: path.join(root, 'build'),
      evidence: ['CMakeLists.txt'],
    }, { destinationDirectory: destination });
    assert.equal(result.success, true);
    const project = await fs.readFile(result.projectFile, 'utf8');
    assert.match(project, new RegExp(`<Device>${fixture.device.slice(0, -1)}x</Device>`));
    assert.match(project, new RegExp(`-mcpu=${fixture.cpu}`));
    if (fixture.name === 'F103') assert.doesNotMatch(project, /-mfpu=/);
    else assert.match(project, /-mfpu=fpv4-sp-d16/);
    const scatter = await fs.readFile(path.join(destination, 'Generated', `${fixture.name}.sct`), 'utf8');
    assert.match(scatter, new RegExp(`LR_IROM1 0x08000000 ${fixture.flash}`));
    assert.match(scatter, new RegExp(`RW_IRAM1 0x20000000 ${fixture.ram}`));
  });
}

test('MDK parser reads memory from target dialog XML and imports F1 without FPU flags', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stm32-f1-import-source-'));
  const destination = await fs.mkdtemp(path.join(os.tmpdir(), 'stm32-f1-import-destination-'));
  t.after(() => Promise.all([fs.rm(root, { recursive: true, force: true }), fs.rm(destination, { recursive: true, force: true })]));
  await fs.mkdir(path.join(root, 'MDK-ARM'), { recursive: true });
  await fs.mkdir(path.join(root, 'Src'), { recursive: true });
  await fs.mkdir(path.join(root, 'Cube'), { recursive: true });
  await fs.writeFile(path.join(root, 'Src', 'main.c'), 'int main(void) { for (;;) {} }\n');
  await fs.writeFile(path.join(root, 'Src', 'startup_stm32f103xb.s'), 'AREA RESET, DATA, READONLY\n');
  await fs.writeFile(path.join(root, 'Cube', 'startup_stm32f103xb.S'), '.global Reset_Handler\nReset_Handler:\n b Reset_Handler\n');
  const projectFile = path.join(root, 'MDK-ARM', 'f103.uvprojx');
  await fs.writeFile(projectFile, `<?xml version="1.0"?><Project><Targets><Target><TargetName>F103</TargetName><uAC6>0</uAC6><TargetOption><TargetCommonOption><Device>STM32F103C8Tx</Device></TargetCommonOption><TargetArmAds><ArmAdsMisc><OnChipMemories><IRAM><StartAddress>0x20000000</StartAddress><Size>0x5000</Size></IRAM><IROM><StartAddress>0x08000000</StartAddress><Size>0x10000</Size></IROM></OnChipMemories></ArmAdsMisc><Cads><VariousControls><Define>STM32F103xB</Define><IncludePath>..\\Src</IncludePath></VariousControls></Cads></TargetArmAds></TargetOption><Groups><Group><Files><File><FilePath>..\\Src\\main.c</FilePath></File><File><FilePath>..\\Src\\startup_stm32f103xb.s</FilePath></File></Files></Group></Groups></Target></Targets></Project>`);
  const parsed = await parseMdkProject(projectFile);
  assert.deepEqual(parsed.targets[0].flash, { origin: '0x08000000', length: '0x00010000' });
  assert.deepEqual(parsed.targets[0].ram, { origin: '0x20000000', length: '0x00005000' });
  const result = await importMdkProjectToCmake(projectFile, { destinationDirectory: destination, sourceRoot: root });
  assert.equal(result.success, true);
  const cmake = await fs.readFile(path.join(destination, 'CMakeLists.txt'), 'utf8');
  assert.match(cmake, /-mcpu=cortex-m3 -mthumb/);
  assert.doesNotMatch(cmake, /-mfpu=/);
  const linker = await fs.readFile(path.join(destination, 'cmake', 'generated', 'F103.ld'), 'utf8');
  assert.match(linker, /FLASH \(rx\)\s+: ORIGIN = 0x08000000, LENGTH = 0x00010000/);
  assert.match(linker, /RAM \(xrw\)\s+: ORIGIN = 0x20000000, LENGTH = 0x00005000/);
  assert.doesNotMatch(linker, /CCMRAM/);
});
