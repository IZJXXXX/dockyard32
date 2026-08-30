const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const {
  confirmRtosFromElf,
  detectRtos,
  findElfArtifact,
} = require('../out/core/rtos.js');
const {
  createFreeRtosGdbPython,
  discoverRtosDebugTools,
  parseRtosSnapshotOutput,
} = require('../out/core/rtosDebug.js');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dockyard32-rtos-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function project(root, buildDir = path.join(root, 'build')) {
  return {
    detected: true,
    workspacePath: root,
    projectRoot: root,
    projectName: 'RtosFixture',
    mcu: 'STM32F407ZGT6',
    family: 'STM32F4',
    mcuDetection: 'exact',
    buildSystem: 'cmake',
    buildDir,
    evidence: ['fixture'],
  };
}

test('RTOS detection recognizes CubeMX FreeRTOS and CMSIS-RTOS v2 automatically', async (t) => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'Middlewares', 'Third_Party', 'FreeRTOS', 'Source', 'include'), {
    recursive: true,
  });
  await fs.mkdir(path.join(root, 'Core', 'Inc'), { recursive: true });
  await fs.mkdir(path.join(root, 'Core', 'Src'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'Core', 'Inc', 'FreeRTOSConfig.h'),
    '#define configMAX_PRIORITIES 7\n',
  );
  await fs.writeFile(
    path.join(root, 'Middlewares', 'Third_Party', 'FreeRTOS', 'Source', 'include', 'FreeRTOS.h'),
    '#define tskKERNEL_VERSION_NUMBER "V10.3.1"\n',
  );
  await fs.writeFile(path.join(root, 'Core', 'Src', 'cmsis_os2.c'), 'osThreadNew(worker, 0, 0);\n');
  await fs.writeFile(path.join(root, 'fixture.ioc'), 'FREERTOS.IPParameters=Tasks01\n');

  const result = await detectRtos(project(root));
  assert.equal(result.detected, true);
  assert.equal(result.kernel, 'freertos');
  assert.equal(result.version, '10.3.1');
  assert.equal(result.cmsisWrapper, 'v2');
  assert.equal(result.confidence, 'high');
  assert.ok(result.evidence.includes('FreeRTOSConfig.h'));
  assert.ok(result.evidence.includes('.ioc FreeRTOS middleware'));
});

test('RTOS detection leaves a bare-metal project disabled without prompting', async (t) => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'main.c'), 'int main(void) { for (;;) {} }\n');
  const result = await detectRtos(project(root));
  assert.equal(result.detected, false);
  assert.equal(result.confidence, 'unknown');
});

test('a generic task.c filename alone is not treated as FreeRTOS', async (t) => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'task.c'), 'void application_task(void) {}\n');
  const result = await detectRtos(project(root));
  assert.equal(result.detected, false);
});

test('RTOS detection honors an explicit kernel override for unusual layouts', async (t) => {
  const root = await fixture(t);
  const result = await detectRtos(project(root), { mode: 'freertos' });
  assert.equal(result.detected, true);
  assert.equal(result.kernel, 'freertos');
  assert.equal(result.confidence, 'inferred');
});

test('RTOS detection recognizes ThreadX and Zephyr without MCU-specific rules', async (t) => {
  const threadxRoot = await fixture(t);
  await fs.writeFile(path.join(threadxRoot, 'tx_api.h'), '#define TX_API_H\n');
  const threadx = await detectRtos(project(threadxRoot));
  assert.equal(threadx.detected, true);
  assert.equal(threadx.kernel, 'threadx');

  const zephyrRoot = await fixture(t);
  await fs.writeFile(path.join(zephyrRoot, 'prj.conf'), 'CONFIG_THREAD_MONITOR=y\n');
  await fs.writeFile(
    path.join(zephyrRoot, 'CMakeLists.txt'),
    'find_package(Zephyr REQUIRED HINTS $ENV{ZEPHYR_BASE})\n',
  );
  const zephyr = await detectRtos(project(zephyrRoot));
  assert.equal(zephyr.detected, true);
  assert.equal(zephyr.kernel, 'zephyr');
});

test('ELF symbols upgrade FreeRTOS detection to exact confidence', async (t) => {
  const root = await fixture(t);
  const elf = path.join(root, 'firmware.elf');
  const fakeNm = path.join(root, 'arm-none-eabi-nm');
  await fs.writeFile(elf, 'fixture');
  await fs.writeFile(
    fakeNm,
    '#!/bin/sh\nprintf "20000000 B pxCurrentTCB\\n20000004 B uxCurrentNumberOfTasks\\n"\n',
  );
  await fs.chmod(fakeNm, 0o755);
  const confirmed = await confirmRtosFromElf(elf, fakeNm);
  assert.equal(confirmed?.kernel, 'freertos');
  const result = await detectRtos(project(root), {
    mode: 'auto',
    elfPath: elf,
    nmExecutable: fakeNm,
  });
  assert.equal(result.detected, true);
  assert.equal(result.kernel, 'freertos');
  assert.equal(result.confidence, 'exact');
  assert.equal(result.elfPath, elf);
});

test('ELF discovery does not let a matching HEX hide a debug ELF', async (t) => {
  const root = await fixture(t);
  const build = path.join(root, 'build');
  await fs.mkdir(build);
  await fs.writeFile(path.join(build, 'RtosFixture.hex'), 'hex');
  await fs.writeFile(path.join(build, 'firmware.elf'), 'elf');
  assert.equal(await findElfArtifact(project(root, build)), path.join(build, 'firmware.elf'));
});

test('RTOS snapshot parser returns structured task and stack data', () => {
  const payload = {
    currentTaskAddress: 536871168,
    tasks: [
      {
        id: 2,
        address: 536871168,
        name: 'USB',
        state: 'running',
        priority: 5,
        stackFreeBytes: 192,
        stackTotalBytes: 512,
        stackUsedPercent: 62.5,
        runtimeCounter: 100,
        runtimePercent: 40,
      },
    ],
    objects: [
      {
        address: 536872000,
        name: 'SharedStateMutex',
        type: 'mutex',
        messagesWaiting: 0,
        length: 1,
        itemSize: 0,
        holderTaskAddress: 536871168,
        waitingToSendTaskAddresses: [],
        waitingToReceiveTaskAddresses: [536871424],
      },
    ],
    relations: [
      {
        taskAddress: 536871168,
        objectAddress: 536872000,
        kind: 'holds',
      },
      {
        taskAddress: 536871424,
        objectAddress: 536872000,
        kind: 'waits-for-mutex',
      },
    ],
    warnings: [],
  };
  const result = parseRtosSnapshotOutput(
    `gdb output\nDOCKYARD32_RTOS_JSON:${JSON.stringify(payload)}\n`,
    1234,
    true,
  );
  assert.equal(result?.success, true);
  assert.equal(result?.capturedAt, 1234);
  assert.equal(result?.tasks[0]?.name, 'USB');
  assert.equal(result?.tasks[0]?.stackUsedPercent, 62.5);
  assert.equal(result?.currentTaskAddress, 536871168);
  assert.equal(result?.objects[0]?.name, 'SharedStateMutex');
  assert.equal(result?.objects[0]?.holderTaskAddress, 536871168);
  assert.equal(result?.relations[1]?.kind, 'waits-for-mutex');
  assert.equal(result?.targetResumed, true);
});

test('RTOS snapshot parser defaults object and relation collections for older payloads', () => {
  const result = parseRtosSnapshotOutput(
    'DOCKYARD32_RTOS_JSON:{"tasks":[],"warnings":[]}',
    1234,
  );
  assert.deepEqual(result?.objects, []);
  assert.deepEqual(result?.relations, []);
});

test('generated GDB Python is syntactically valid and reads the FreeRTOS queue registry', () => {
  const script = createFreeRtosGdbPython();
  assert.match(script, /xQueueRegistry/);
  assert.match(script, /xTasksWaitingToReceive/);
  assert.match(script, /xMutexHolder/);
  assert.match(script, /xPendingReadyList", "pending-ready"/);
  assert.match(script, /suspended_or_blocked_state/);
  assert.match(script, /class Dockyard32Detach/);
  assert.match(script, /gdb\.execute\("detach"/);
  assert.doesNotMatch(script, /stm32-workbench|stm32Workbench/i);
  const result = spawnSync('python3', [
    '-c',
    'import sys; compile(sys.stdin.read(), "freertos_snapshot.py", "exec")',
  ], { input: script, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('RTOS debug tool discovery honors configured executables', async (t) => {
  const root = await fixture(t);
  const gdb = path.join(root, 'arm-none-eabi-gdb');
  const server = path.join(root, 'ST-LINK_gdbserver');
  await Promise.all([
    fs.writeFile(gdb, '#!/bin/sh\nexit 0\n'),
    fs.writeFile(server, '#!/bin/sh\nexit 0\n'),
  ]);
  await Promise.all([fs.chmod(gdb, 0o755), fs.chmod(server, 0o755)]);
  const result = await discoverRtosDebugTools({
    configuredGdb: gdb,
    configuredGdbServer: server,
    programmerExecutable: '/fixture/STM32_Programmer_CLI',
    searchRoots: [],
  });
  assert.equal(result.gdbExecutable, gdb);
  assert.equal(result.gdbServerExecutable, server);
  assert.equal(result.programmerExecutable, '/fixture/STM32_Programmer_CLI');
});

test('F407 relationship example stays slim and registers five tasks plus four objects', async () => {
  const example = path.resolve(__dirname, '../examples/F407_FreeRTOS_Relationship_Demo');
  const [main, toolchain, config] = await Promise.all([
    fs.readFile(path.join(example, 'Src/main.c'), 'utf8'),
    fs.readFile(path.join(example, 'cmake/arm-none-eabi.cmake'), 'utf8'),
    fs.readFile(path.join(example, 'Inc/FreeRTOSConfig.h'), 'utf8'),
  ]);
  assert.equal((main.match(/xTaskCreate\(/g) ?? []).length, 5);
  assert.equal((main.match(/vQueueAddToRegistry\(/g) ?? []).length, 4);
  assert.match(config, /configUSE_TRACE_FACILITY\s+1/);
  assert.match(config, /configQUEUE_REGISTRY_SIZE\s+16/);
  assert.match(toolchain, /ARM_NONE_EABI_BIN_DIR/);
  assert.match(toolchain, /ARM_NONE_EABI_BIN_DIR}\/arm-none-eabi-objcopy/);
  await Promise.all([
    fs.access(path.join(example, 'ThirdParty/FreeRTOS-Kernel/LICENSE.md')),
    fs.access(path.join(example, 'ThirdParty/STM32CubeF4/Drivers/CMSIS/LICENSE.txt')),
    fs.access(path.join(example, 'THIRD_PARTY_NOTICES.md')),
  ]);
  await assert.rejects(fs.access(path.join(example, 'build')));
});
