const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createAgentApi } = require('../out/agent/api.js');
const { WorkbenchOperationLock } = require('../out/core/operationLock.js');

const workspace = '/workspace/F407';

function project() {
  return {
    detected: true,
    workspacePath: workspace,
    projectRoot: workspace,
    projectName: 'F407_Project',
    iocPath: path.join(workspace, 'F407_Project.ioc'),
    mcu: 'STM32F407VGT6',
    family: 'STM32F4',
    mcuDetection: 'exact',
    buildSystem: 'cmake',
    buildDir: path.join(workspace, 'build'),
    evidence: ['.ioc', 'CMakeLists.txt'],
  };
}

function tools() {
  return {
    cmake: { kind: 'cmake', available: true, executable: '/tools/cmake', source: 'configured' },
    ninja: { kind: 'ninja', available: true, executable: '/tools/ninja', source: 'configured' },
    armGcc: { kind: 'arm-gcc', available: true, executable: '/tools/arm-none-eabi-gcc', source: 'configured' },
    programmer: { kind: 'programmer', available: true, executable: '/tools/STM32_Programmer_CLI', source: 'configured' },
    detectedAt: 1,
  };
}

function buildResult(success = true) {
  return {
    success,
    stage: 'build',
    exitCode: success ? 0 : 2,
    stdout: '',
    stderr: success ? '' : "Core/Src/main.c:42:10: error: 'xxx' undeclared",
    durationMs: 10,
    errors: success ? [] : [{
      severity: 'error', file: 'Core/Src/main.c', line: 42, column: 10,
      message: "'xxx' undeclared",
    }],
    warnings: [],
  };
}

function flashResult(success = true) {
  return {
    success,
    stage: 'flash',
    exitCode: success ? 0 : 1,
    stdout: '',
    stderr: success ? '' : 'Download failed',
    durationMs: 5,
    firmwarePath: path.join(workspace, 'build', 'F407_Project.elf'),
    verify: true,
    reset: false,
    error: success ? undefined : 'Download failed',
  };
}

function resetResult(success = true) {
  return {
    success,
    stage: 'reset',
    exitCode: success ? 0 : 1,
    stdout: '',
    stderr: '',
    durationMs: 2,
    error: success ? undefined : 'Reset failed',
  };
}

function runResult(success = true) {
  return {
    runId: 7,
    success,
    status: success ? 'warning' : 'failed',
    startedAt: 1,
    completedAt: 11,
    durationMs: 10,
    failedStage: success ? undefined : 'building',
    build: buildResult(success),
    flash: success ? flashResult() : undefined,
    reset: success ? resetResult() : undefined,
    serialConnected: false,
    readyCheckEnabled: false,
    warnings: success ? ['Serial unavailable'] : [],
    error: success ? undefined : 'Build failed',
  };
}

function configuration() {
  return {
    configuredTools: {},
    serial: { serialPort: 'auto', baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none' },
    flashVerify: true,
    run: { waitForSerialReady: false, readyPattern: 'SYSTEM READY', readyTimeoutMs: 5000, clearSerialBeforeRun: false },
    timeouts: { buildMs: 1000, flashMs: 1000, resetMs: 1000, runMs: 1000 },
  };
}

function probe(count = 1) {
  return {
    programmerAvailable: true,
    probeConnected: count > 0,
    probes: Array.from({ length: count }, (_, index) => ({
      index, serialNumber: `STLINK${index}`, firmwareVersion: 'V2J45S7', board: 'STLINK-V3SET',
    })),
    checkedAt: 1,
    stdout: '',
    stderr: '',
  };
}

function createApi(overrides = {}, options = {}) {
  const firmware = path.join(workspace, 'build', 'F407_Project.elf');
  const dependencies = {
    detectProject: async () => project(),
    discoverDevelopmentTools: async () => tools(),
    getDeviceStatus: async () => probe(),
    buildProject: async () => buildResult(),
    findFirmwareArtifact: async () => firmware,
    validateFirmwareArtifact: async (_project, candidate) => ({ success: true, firmwarePath: candidate }),
    flashFirmware: async () => flashResult(),
    resetTarget: async () => resetResult(),
    buildAndRun: async () => runResult(),
    readConfiguration: async () => configuration(),
    readLastRun: async () => runResult(),
    writeLastRun: async () => {},
    ...overrides,
  };
  return createAgentApi({
    workspacePath: workspace,
    dependencies,
    operationLock: new WorkbenchOperationLock(),
    ...options,
  });
}

test('Agent API returns structured project and tool status without VS Code', async () => {
  const api = createApi();
  const projectInfo = await api.getProjectInfo();
  assert.equal(projectInfo.success, true);
  assert.equal(projectInfo.data.projectName, 'F407_Project');
  assert.equal(projectInfo.data.mcu, 'STM32F407VGT6');
  const toolStatus = await api.getToolStatus();
  assert.equal(toolStatus.success, true);
  assert.equal(toolStatus.data.cmake.path, '/tools/cmake');
  assert.doesNotMatch(require.resolve('../out/agent/api.js'), /vscode/u);
});

test('Agent API returns a single probe and rejects multiple probes', async () => {
  const single = await createApi().getProbeInfo();
  assert.equal(single.success, true);
  assert.equal(single.data.serialNumber, 'STLINK0');
  const multiple = await createApi({ getDeviceStatus: async () => probe(2) }).getProbeInfo();
  assert.equal(multiple.success, false);
  assert.equal(multiple.error.code, 'MULTIPLE_STLINK_PROBES');
});

test('Agent build returns success and structured GCC diagnostics', async () => {
  const success = await createApi().build();
  assert.equal(success.success, true);
  const failed = await createApi({ buildProject: async () => buildResult(false) }).build();
  assert.equal(failed.success, false);
  assert.equal(failed.error.code, 'BUILD_FAILED');
  assert.equal(failed.data.errors[0].file, 'Core/Src/main.c');
  assert.equal(failed.data.errors[0].line, 42);
});

test('Agent Flash requires a successful same-session build and maps failure', async () => {
  const api = createApi();
  const beforeBuild = await api.flash();
  assert.equal(beforeBuild.success, false);
  assert.equal(beforeBuild.error.code, 'FIRMWARE_NOT_FOUND');
  assert.equal((await api.build()).success, true);
  assert.equal((await api.flash()).success, true);

  const failedApi = createApi({ flashFirmware: async () => flashResult(false) });
  await failedApi.build();
  const failed = await failedApi.flash();
  assert.equal(failed.success, false);
  assert.equal(failed.error.code, 'FLASH_FAILED');
});

test('Agent reset and Build & Run reuse structured Core results', async () => {
  const api = createApi();
  assert.equal((await api.reset()).success, true);
  const run = await api.buildAndRun();
  assert.equal(run.success, true);
  assert.equal(run.data.runId, 7);
  assert.deepEqual(run.warnings, ['Serial unavailable']);
});

test('Agent operation lock returns OPERATION_BUSY across actions', async () => {
  const lock = new WorkbenchOperationLock();
  const lease = lock.acquire('run');
  assert.ok(lease);
  const busy = await createApi({}, { operationLock: lock }).reset();
  assert.equal(busy.success, false);
  assert.equal(busy.error.code, 'OPERATION_BUSY');
  lease.release();
});

test('Agent releases the operation lock when CMake is unavailable', async () => {
  const unavailableTools = tools();
  unavailableTools.cmake = { kind: 'cmake', available: false };
  const lock = new WorkbenchOperationLock();
  const result = await createApi(
    { discoverDevelopmentTools: async () => unavailableTools },
    { operationLock: lock },
  ).build();
  assert.equal(result.success, false);
  assert.equal(result.error.code, 'CMAKE_NOT_FOUND');
  const nextLease = lock.acquire('reset');
  assert.ok(nextLease, 'failed preflight must not leave the workspace busy');
  nextLease.release();
});

test('workspace operation lock is shared across independent instances', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stm32-shared-lock-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = new WorkbenchOperationLock(root);
  const second = new WorkbenchOperationLock(root);
  const lease = first.acquire('run');
  assert.ok(lease);
  assert.equal(second.acquire('flash'), undefined);
  assert.equal(second.getActiveOperation(), 'run');
  lease.release();
  const flashLease = second.acquire('flash');
  assert.ok(flashLease);
  flashLease.release();
});

test('Agent maps project, programmer, probe, and internal failures', async () => {
  const notProject = await createApi({
    detectProject: async () => ({ detected: false, mcuDetection: 'unknown', buildSystem: 'unknown', evidence: [], reason: 'not-stm32' }),
  }).build();
  assert.equal(notProject.error.code, 'NOT_STM32_PROJECT');

  const noProgrammerTools = tools();
  noProgrammerTools.programmer = { kind: 'programmer', available: false };
  const noProgrammer = await createApi({ discoverDevelopmentTools: async () => noProgrammerTools }).reset();
  assert.equal(noProgrammer.error.code, 'PROGRAMMER_NOT_FOUND');

  const noProbe = await createApi({ getDeviceStatus: async () => probe(0) }).reset();
  assert.equal(noProbe.error.code, 'STLINK_NOT_CONNECTED');

  const internal = await createApi({ detectProject: async () => { throw new Error('boom'); } }).getProjectInfo();
  assert.equal(internal.error.code, 'INTERNAL_ERROR');
});

test('independent Agent API reports serial ownership and validates bounded input', async () => {
  const api = createApi({}, { serialOwnedByExtension: true });
  const status = await api.getSerialStatus();
  assert.equal(status.error.code, 'SERIAL_OWNED_BY_EXTENSION');
  const wait = await api.waitSerial({ pattern: 'READY', timeoutMs: 60001 });
  assert.equal(wait.error.code, 'INVALID_ARGUMENT');
  const log = await api.getSerialLog(2001);
  assert.equal(log.error.code, 'INVALID_ARGUMENT');
});
