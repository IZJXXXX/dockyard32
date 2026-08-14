const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { parseKeilDiagnostics, parseMdkProject } = require('../out/core/mdk.js');
const { exportCmakeProjectToMdk } = require('../out/core/mdkExport.js');
const { importMdkProjectToCmake } = require('../out/core/mdkImport.js');
const { detectProject } = require('../out/core/project.js');

test('detectProject recognizes a native MDK project and parses its target', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stm32-mdk-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'Projects', 'MDK-ARM'), { recursive: true });
  const projectFile = path.join(root, 'Projects', 'MDK-ARM', 'board.uvprojx');
  await fs.writeFile(projectFile, `<?xml version="1.0"?><Project><Targets><Target>
    <TargetName>F407 Board</TargetName><TargetOption><TargetCommonOption>
    <Device>STM32F407ZGTx</Device><IncludePath></IncludePath><OutputDirectory>..\\..\\Output\\</OutputDirectory>
    <OutputName>firmware</OutputName><CreateHexFile>1</CreateHexFile>
    </TargetCommonOption><TargetArmAds><Cads><VariousControls>
    <Define>USE_HAL_DRIVER,STM32F407xx</Define><IncludePath>..\\..\\Inc;..\\..\\Drivers</IncludePath>
    </VariousControls></Cads></TargetArmAds></TargetOption><Groups><Group><Files>
    <File><FilePath>..\\..\\Src\\main.c</FilePath></File>
    </Files></Group></Groups></Target></Targets></Project>`);

  const parsed = await parseMdkProject(projectFile);
  assert.equal(parsed.targets[0].name, 'F407 Board');
  assert.equal(parsed.targets[0].createHexFile, true);
  assert.deepEqual(parsed.targets[0].defines, ['USE_HAL_DRIVER', 'STM32F407xx']);

  const info = await detectProject(root);
  assert.equal(info.detected, true);
  assert.equal(info.buildSystem, 'mdk');
  assert.equal(info.mcu, 'STM32F407ZGT');
  assert.equal(info.mdk.projectFile, projectFile);
  assert.equal(info.buildDir, path.join(root, '.dockyard32', 'mdk-output'));
});

test('parseMdkProject distinguishes ARM Compiler 5 and ARM Compiler 6 targets', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stm32-mdk-compilers-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectFile = path.join(root, 'dual.uvprojx');
  await fs.writeFile(projectFile, `<?xml version="1.0"?><Project><Targets>
    <Target><TargetName>AC5</TargetName><uAC6>0</uAC6><TargetOption><TargetCommonOption><Device>STM32F407ZGTx</Device></TargetCommonOption></TargetOption></Target>
    <Target><TargetName>AC6</TargetName><uAC6>1</uAC6><TargetOption><TargetCommonOption><Device>STM32F407ZGTx</Device></TargetCommonOption></TargetOption></Target>
  </Targets></Project>`);
  const parsed = await parseMdkProject(projectFile);
  assert.deepEqual(parsed.targets.map((target) => target.compiler), ['armcc5', 'armclang6']);
});

test('parseKeilDiagnostics creates structured source locations', () => {
  assert.deepEqual(parseKeilDiagnostics(
    '../Src/main.c(42,7): error: #20: identifier "PWM_FREQ" is undefined\n' +
    '../Src/main.c(50): warning: #177-D: variable "value" was declared but never referenced',
  ), [
    { severity: 'error', file: '../Src/main.c', line: 42, column: 7, message: 'identifier "PWM_FREQ" is undefined' },
    { severity: 'warning', file: '../Src/main.c', line: 50, column: undefined, message: 'variable "value" was declared but never referenced' },
  ]);
});

test('exportCmakeProjectToMdk emits uvprojx, scatter file, and metadata', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stm32-mdk-export-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'Src'), { recursive: true });
  await fs.mkdir(path.join(root, 'Inc'), { recursive: true });
  await fs.mkdir(path.join(root, 'build'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'Src', 'main.c'),
    'typedef struct __FILE FILE;\n__asm(".global __use_no_semihosting");\nFILE __stdout;\nint fputc(int ch, FILE *f) { (void)f; return ch; }\nint main(void) { for (;;) {} }\n',
  );
  await fs.writeFile(path.join(root, 'CMakeLists.txt'), 'project(F407_Test C)\ntarget_link_options(F407_Test PRIVATE -T${CMAKE_CURRENT_SOURCE_DIR}/cmake/generated/F407_Test.ld)\n');
  await fs.mkdir(path.join(root, 'cmake', 'generated'), { recursive: true });
  await fs.writeFile(path.join(root, 'cmake', 'generated', 'F407_Test.ld'), `ENTRY(Reset_Handler)
  _Min_Heap_Size = 0x200;
  _Min_Stack_Size = 0x900;
  MEMORY {
    RAM (xrw) : ORIGIN = 0x20000000, LENGTH = 128K
    CCMRAM (xrw) : ORIGIN = 0x10000000, LENGTH = 64K
    FLASH (rx) : ORIGIN = 0x08000000, LENGTH = 1024K
  }`);
  await fs.writeFile(path.join(root, 'build', 'compile_commands.json'), JSON.stringify([{
    directory: path.join(root, 'build'),
    command: `arm-none-eabi-gcc -DSTM32F407xx -DUSE_HAL_DRIVER -I${path.join(root, 'Inc')} -c ${path.join(root, 'Src', 'main.c')}`,
    file: path.join(root, 'Src', 'main.c'),
  }]));
  const exportDirectory = path.join(root, 'custom-keil-output');
  const result = await exportCmakeProjectToMdk({
    detected: true,
    projectRoot: root,
    projectName: 'F407_Test',
    mcu: 'STM32F407ZGT6',
    mcuDetection: 'exact',
    buildSystem: 'cmake',
    buildDir: path.join(root, 'build'),
    evidence: ['CMakeLists.txt'],
  }, { destinationDirectory: exportDirectory });
  assert.equal(result.success, true);
  const project = await fs.readFile(result.projectFile, 'utf8');
  assert.match(project, /<uAC6>1<\/uAC6>/);
  assert.match(project, /STM32F407ZGTx/);
  assert.match(project, /STM32F407xx,USE_HAL_DRIVER/);
  assert.match(project, /<useUlib>1<\/useUlib>/);
  const exportedMain = await fs.readFile(
    path.join(exportDirectory, 'SourceTree', 'Src', 'main.c'),
    'latin1',
  );
  assert.match(exportedMain, /#if !defined\(__ARMCC_VERSION\).*__ARMCC_VERSION < 6010050/su);
  const scatter = await fs.readFile(path.join(exportDirectory, 'Generated', 'F407_Test.sct'), 'utf8');
  assert.match(scatter, /LR_IROM1 0x08000000 0x00100000/);
  assert.match(scatter, /ARM_LIB_HEAP\s+\+0 EMPTY 0x00000200/);
  assert.match(scatter, /ARM_LIB_STACK 0x20020000 EMPTY -0x00000900/);
  const report = JSON.parse(await fs.readFile(path.join(exportDirectory, 'dockyard32-export.json'), 'utf8'));
  assert.equal(report.linkerScript, 'cmake/generated/F407_Test.ld');
  assert.equal(report.entry, 'Reset_Handler');
  assert.deepEqual(report.memoryRegions.map((region) => region.name), ['RAM', 'CCMRAM', 'FLASH']);
});

test('importMdkProjectToCmake creates an independent native macOS project', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stm32-mdk-import-source-'));
  const destination = await fs.mkdtemp(path.join(os.tmpdir(), 'stm32-mdk-import-destination-'));
  t.after(() => Promise.all([
    fs.rm(root, { recursive: true, force: true }),
    fs.rm(destination, { recursive: true, force: true }),
  ]));
  await fs.mkdir(path.join(root, 'Projects', 'MDK-ARM'), { recursive: true });
  await fs.mkdir(path.join(root, 'Src'), { recursive: true });
  await fs.mkdir(path.join(root, 'Inc'), { recursive: true });
  await fs.mkdir(path.join(root, 'Cube'), { recursive: true });
  await fs.writeFile(path.join(root, 'Src', 'main.c'), 'int main(void) { for (;;) {} }\n');
  await fs.writeFile(path.join(root, 'Src', 'startup_stm32f407xx.s'), 'AREA RESET, DATA, READONLY\n');
  await fs.writeFile(path.join(root, 'Cube', 'startup_stm32f407xx.S'), '.global Reset_Handler\nReset_Handler:\n b Reset_Handler\n');
  const projectFile = path.join(root, 'Projects', 'MDK-ARM', 'board.uvprojx');
  await fs.writeFile(projectFile, `<?xml version="1.0"?><Project><Targets><Target>
    <TargetName>F407_Native</TargetName><uAC6>0</uAC6><TargetOption><TargetCommonOption>
    <Device>STM32F407ZGTx</Device><Cpu>IROM(0x08000000,0x00100000) IRAM(0x20000000,0x00020000)</Cpu>
    </TargetCommonOption><TargetArmAds><Cads><VariousControls>
    <Define>USE_HAL_DRIVER,STM32F407xx</Define><IncludePath>..\\..\\Inc</IncludePath>
    </VariousControls></Cads></TargetArmAds></TargetOption><Groups><Group><Files>
    <File><FilePath>..\\..\\Src\\main.c</FilePath></File>
    <File><FilePath>..\\..\\Src\\startup_stm32f407xx.s</FilePath></File>
    </Files></Group></Groups></Target></Targets></Project>`);

  const result = await importMdkProjectToCmake(projectFile, {
    destinationDirectory: destination,
    sourceRoot: root,
  });
  assert.equal(result.success, true);
  assert.equal(result.projectDirectory, destination);
  const cmake = await fs.readFile(path.join(destination, 'CMakeLists.txt'), 'utf8');
  assert.match(cmake, /arm-none-eabi-gcc/);
  assert.match(cmake, /startup_stm32f407xx\.S/);
  assert.equal(await fs.readFile(path.join(root, 'Src', 'main.c'), 'utf8'), 'int main(void) { for (;;) {} }\n');
  const report = JSON.parse(await fs.readFile(path.join(destination, '.dockyard32', 'mdk-import.json'), 'utf8'));
  assert.equal(report.sourceCompiler, 'armcc5');

  await fs.rename(
    path.join(destination, '.dockyard32'),
    path.join(destination, '.stm32-workbench'),
  );
  const legacyProject = await detectProject(destination);
  assert.equal(legacyProject.mcu, 'STM32F407ZGT');
  assert.equal(legacyProject.mcuDetection, 'exact');
});

test('importMdkProjectToCmake imports an ARM Compiler 6 project', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stm32-mdk-ac6-source-'));
  const destination = await fs.mkdtemp(path.join(os.tmpdir(), 'stm32-mdk-ac6-destination-'));
  t.after(() => Promise.all([
    fs.rm(root, { recursive: true, force: true }),
    fs.rm(destination, { recursive: true, force: true }),
  ]));
  await fs.mkdir(path.join(root, 'MDK-ARM'), { recursive: true });
  await fs.mkdir(path.join(root, 'Src'), { recursive: true });
  await fs.mkdir(path.join(root, 'Drivers', 'CMSIS', 'Device', 'ST', 'STM32F4xx', 'Source', 'Templates', 'gcc'), { recursive: true });
  await fs.writeFile(path.join(root, 'Src', 'main.c'), 'int main(void) { for (;;) {} }\n');
  await fs.writeFile(path.join(root, 'Src', 'startup_stm32f407xx.s'), 'AREA RESET, DATA, READONLY\n');
  await fs.writeFile(path.join(root, 'Drivers', 'CMSIS', 'Device', 'ST', 'STM32F4xx', 'Source', 'Templates', 'gcc', 'startup_stm32f407xx.S'), '.global Reset_Handler\nReset_Handler:\n b Reset_Handler\n');
  const projectFile = path.join(root, 'MDK-ARM', 'board.uvprojx');
  await fs.writeFile(projectFile, `<?xml version="1.0"?><Project><Targets><Target>
    <TargetName>F407_AC6</TargetName><uAC6>1</uAC6><TargetOption><TargetCommonOption>
    <Device>STM32F407ZGTx</Device><Cpu>IROM(0x08000000,0x00100000) IRAM(0x20000000,0x00020000)</Cpu>
    </TargetCommonOption><TargetArmAds><Cads><VariousControls><Define>STM32F407xx</Define><IncludePath>..\\Src</IncludePath></VariousControls></Cads></TargetArmAds></TargetOption>
    <Groups><Group><Files><File><FilePath>..\\Src\\main.c</FilePath></File><File><FilePath>..\\Src\\startup_stm32f407xx.s</FilePath></File></Files></Group></Groups>
  </Target></Targets></Project>`);
  const result = await importMdkProjectToCmake(projectFile, { destinationDirectory: destination, sourceRoot: root });
  assert.equal(result.success, true);
  const report = JSON.parse(await fs.readFile(path.join(destination, '.dockyard32', 'mdk-import.json'), 'utf8'));
  assert.equal(report.sourceCompiler, 'armclang6');
  assert.equal(report.warnings.some((warning) => warning.includes('ARM Compiler 5')), false);
});
