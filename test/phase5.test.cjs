const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { Dockyard32OperationLock } = require('../out/core/operationLock.js');
const {
  buildAndRun,
  validateFirmwareArtifact,
} = require('../out/core/run.js');
const { SerialService } = require('../out/core/serial.js');

function projectInfo(root = '/workspace/Controller') {
  return {
    detected: true,
    workspacePath: root,
    projectRoot: root,
    projectName: 'Controller',
    mcu: 'STM32F407VGT6',
    mcuDetection: 'exact',
    buildSystem: 'cmake',
    buildDir: path.join(root, 'build'),
    evidence: ['.ioc', 'CMakeLists.txt'],
  };
}

function buildResult(success = true) {
  return {
    success,
    stage: 'build',
    exitCode: success ? 0 : 2,
    stdout: '',
    stderr: success ? '' : 'main.c:3:1: error: broken',
    durationMs: 10,
    errors: success
      ? []
      : [{ severity: 'error', file: 'main.c', line: 3, column: 1, message: 'broken' }],
    warnings: [],
  };
}

function flashResult(success = true, error) {
  return {
    success,
    stage: 'flash',
    exitCode: success ? 0 : 1,
    stdout: '',
    stderr: error ?? '',
    durationMs: 12,
    firmwarePath: '/workspace/Controller/build/Controller.elf',
    chip: 'STM32F407VG',
    verify: true,
    reset: false,
    error,
  };
}

function resetResult(success = true, error) {
  return {
    success,
    stage: 'reset',
    exitCode: success ? 0 : 1,
    stdout: '',
    stderr: error ?? '',
    durationMs: 4,
    chip: 'STM32F407VG',
    error,
  };
}

function deviceStatus() {
  return {
    programmerAvailable: true,
    probeConnected: true,
    probes: [{ index: 0, serialNumber: 'STLINK1' }],
    checkedAt: Date.now(),
    stdout: '',
    stderr: '',
  };
}

function dependencies(overrides = {}) {
  return {
    buildProject: async () => buildResult(),
    findFirmwareArtifact: async () => '/workspace/Controller/build/Controller.elf',
    validateFirmwareArtifact: async (_project, firmwarePath) => ({
      success: true,
      firmwarePath,
    }),
    getDeviceStatus: async () => deviceStatus(),
    flashFirmware: async () => flashResult(),
    resetTarget: async () => resetResult(),
    ...overrides,
  };
}

function disconnectedStatus() {
  return {
    connected: false,
    state: 'disconnected',
    bytesReceived: 0,
    bytesSent: 0,
  };
}

function serialSettings(serialPort = 'auto') {
  return {
    serialPort,
    baudRate: 115200,
    dataBits: 8,
    stopBits: 1,
    parity: 'none',
  };
}

class FakeSerial {
  constructor(options = {}) {
    this.status = options.status ?? disconnectedStatus();
    this.ports = options.ports ?? [];
    this.waitResult = options.waitResult ?? {
      success: true,
      pattern: 'SYSTEM READY',
      elapsedMs: 25,
      matchedText: 'SYSTEM READY',
    };
    this.order = options.order;
    this.connectCalls = [];
    this.waitCalls = [];
    this.clearCalls = 0;
  }

  async listSerialPorts() {
    this.order?.push('listSerialPorts');
    return this.ports;
  }

  async connectSerial(configuration) {
    this.order?.push('connectSerial');
    this.connectCalls.push(configuration);
    this.status = {
      connected: true,
      state: 'connected',
      port: configuration.path,
      baudRate: configuration.baudRate,
      openedAt: Date.now(),
      bytesReceived: 0,
      bytesSent: 0,
    };
    return { success: true, message: 'connected' };
  }

  getSerialStatus() {
    return { ...this.status };
  }

  clearSerialLog() {
    this.clearCalls += 1;
    return { success: true };
  }

  async waitSerial(pattern, timeoutMs, options) {
    this.order?.push('waitSerial');
    this.waitCalls.push({ pattern, timeoutMs, options });
    return { ...this.waitResult, pattern };
  }
}

function runOptions(overrides = {}) {
  return {
    project: projectInfo(),
    cmakeExecutable: '/tools/cmake',
    programmerExecutable: '/tools/STM32_Programmer_CLI',
    dependencies: dependencies(),
    ...overrides,
  };
}

test('complete Build & Run returns structured success and progress', async () => {
  const stages = [];
  const serial = new FakeSerial({
    status: {
      connected: true,
      state: 'connected',
      port: '/dev/cu.usbserial-110',
      baudRate: 115200,
      openedAt: Date.now(),
      bytesReceived: 0,
      bytesSent: 0,
    },
  });
  const result = await buildAndRun(
    runOptions({
      serial,
      serialSettings: serialSettings(),
      waitForSerialReady: true,
      onProgress: (progress) => stages.push(progress.stage),
    }),
  );

  assert.equal(result.success, true);
  assert.equal(result.status, 'success');
  assert.equal(result.build.success, true);
  assert.equal(result.flash.success, true);
  assert.equal(result.reset.success, true);
  assert.equal(result.serialConnected, true);
  assert.equal(result.readyDetected, true);
  assert.equal(serial.clearCalls, 0);
  assert.ok(Number.isSafeInteger(result.runId));
  assert.deepEqual(stages, [
    'preparing', 'building', 'firmware', 'device', 'flashing', 'verifying',
    'serial', 'serial', 'resetting', 'waiting', 'complete',
  ]);
});

test('Build failure never discovers or flashes stale firmware', async () => {
  const calls = [];
  const result = await buildAndRun(runOptions({
    dependencies: dependencies({
      buildProject: async () => {
        calls.push('build');
        return buildResult(false);
      },
      findFirmwareArtifact: async () => {
        calls.push('firmware');
        return '/stale.elf';
      },
      flashFirmware: async () => {
        calls.push('flash');
        return flashResult();
      },
      resetTarget: async () => {
        calls.push('reset');
        return resetResult();
      },
    }),
  }));
  assert.equal(result.success, false);
  assert.equal(result.failedStage, 'building');
  assert.deepEqual(calls, ['build']);
});

test('failure results preserve an existing serial connection status', async () => {
  const serial = new FakeSerial({
    status: {
      connected: true,
      state: 'connected',
      port: '/dev/cu.debug',
      baudRate: 115200,
      openedAt: Date.now(),
      bytesReceived: 0,
      bytesSent: 0,
    },
  });
  const result = await buildAndRun(runOptions({
    serial,
    dependencies: dependencies({ buildProject: async () => buildResult(false) }),
  }));
  assert.equal(result.success, false);
  assert.equal(result.serialConnected, true);
  assert.equal(result.serialPort, '/dev/cu.debug');
});

test('firmware discovery occurs only after a successful build', async () => {
  const order = [];
  const result = await buildAndRun(runOptions({
    dependencies: dependencies({
      buildProject: async () => {
        order.push('build');
        return buildResult();
      },
      findFirmwareArtifact: async () => {
        order.push('firmware');
        return '/workspace/Controller/build/Controller.elf';
      },
    }),
  }));
  assert.equal(result.success, true);
  assert.ok(order.indexOf('firmware') > order.indexOf('build'));
});

test('missing firmware stops before Flash and Reset', async () => {
  let flashCalls = 0;
  let resetCalls = 0;
  const result = await buildAndRun(runOptions({
    dependencies: dependencies({
      findFirmwareArtifact: async () => undefined,
      flashFirmware: async () => {
        flashCalls += 1;
        return flashResult();
      },
      resetTarget: async () => {
        resetCalls += 1;
        return resetResult();
      },
    }),
  }));
  assert.equal(result.failedStage, 'firmware');
  assert.equal(result.error, 'Firmware not found after successful build');
  assert.equal(flashCalls, 0);
  assert.equal(resetCalls, 0);
});

test('missing ST-LINK stops before Flash and Reset', async () => {
  let flashCalls = 0;
  let resetCalls = 0;
  const result = await buildAndRun(runOptions({
    dependencies: dependencies({
      getDeviceStatus: async () => ({
        programmerAvailable: true,
        probeConnected: false,
        probes: [],
        checkedAt: Date.now(),
        stdout: '',
        stderr: '',
      }),
      flashFirmware: async () => {
        flashCalls += 1;
        return flashResult();
      },
      resetTarget: async () => {
        resetCalls += 1;
        return resetResult();
      },
    }),
  }));
  assert.equal(result.failedStage, 'device');
  assert.equal(result.error, 'No ST-LINK probe detected');
  assert.equal(flashCalls, 0);
  assert.equal(resetCalls, 0);
});

test('Flash failure stops before Reset', async () => {
  let resetCalls = 0;
  const result = await buildAndRun(runOptions({
    dependencies: dependencies({
      flashFirmware: async () => flashResult(false, 'SWD write failed'),
      resetTarget: async () => {
        resetCalls += 1;
        return resetResult();
      },
    }),
  }));
  assert.equal(result.failedStage, 'flashing');
  assert.equal(resetCalls, 0);
});

test('Verify failure is identified and stops before Reset', async () => {
  let resetCalls = 0;
  const result = await buildAndRun(runOptions({
    dependencies: dependencies({
      flashFirmware: async () => flashResult(false, 'Verification failed'),
      resetTarget: async () => {
        resetCalls += 1;
        return resetResult();
      },
    }),
  }));
  assert.equal(result.failedStage, 'verifying');
  assert.equal(resetCalls, 0);
});

test('an existing serial connection is preserved', async () => {
  const serial = new FakeSerial({
    status: {
      connected: true,
      state: 'connected',
      port: '/dev/cu.usbmodem1',
      baudRate: 230400,
      openedAt: Date.now(),
      bytesReceived: 10,
      bytesSent: 0,
    },
  });
  const result = await buildAndRun(runOptions({ serial, serialSettings: serialSettings() }));
  assert.equal(result.serialPort, '/dev/cu.usbmodem1');
  assert.equal(serial.connectCalls.length, 0);
});

test('auto serial connects only when one clear /dev/cu.* port exists', async () => {
  const serial = new FakeSerial({
    ports: [
      { path: '/dev/cu.Bluetooth-Incoming-Port' },
      { path: '/dev/cu.usbserial-110' },
      { path: '/dev/tty.usbserial-110' },
    ],
  });
  const result = await buildAndRun(runOptions({ serial, serialSettings: serialSettings() }));
  assert.equal(result.serialConnected, true);
  assert.equal(serial.connectCalls[0].path, '/dev/cu.usbserial-110');
});

test('multiple serial ports are not selected randomly', async () => {
  const serial = new FakeSerial({
    ports: [
      { path: '/dev/cu.usbserial-1' },
      { path: '/dev/cu.usbmodem-2' },
    ],
  });
  const result = await buildAndRun(runOptions({ serial, serialSettings: serialSettings() }));
  assert.equal(result.success, true);
  assert.equal(result.status, 'warning');
  assert.equal(result.serialConnected, false);
  assert.equal(serial.connectCalls.length, 0);
  assert.match(result.warnings[0], /Multiple serial ports/u);
});

test('ready waiter is established before target Reset', async () => {
  const order = [];
  const serial = new FakeSerial({
    order,
    status: {
      connected: true,
      state: 'connected',
      port: '/dev/cu.usbserial-1',
      baudRate: 115200,
      openedAt: Date.now(),
      bytesReceived: 0,
      bytesSent: 0,
    },
  });
  await buildAndRun(runOptions({
    serial,
    serialSettings: serialSettings(),
    waitForSerialReady: true,
    dependencies: dependencies({
      resetTarget: async () => {
        order.push('resetTarget');
        return resetResult();
      },
    }),
  }));
  assert.ok(order.indexOf('waitSerial') < order.indexOf('resetTarget'));
  assert.equal(serial.waitCalls[0].options.includeExisting, false);
});

test('Ready success and timeout are represented independently of deployment', async () => {
  const ready = new FakeSerial({
    status: {
      connected: true, state: 'connected', port: '/dev/cu.ready', baudRate: 115200,
      openedAt: Date.now(), bytesReceived: 0, bytesSent: 0,
    },
    waitResult: { success: true, pattern: 'SYSTEM READY', elapsedMs: 384 },
  });
  const success = await buildAndRun(runOptions({
    serial: ready,
    serialSettings: serialSettings(),
    waitForSerialReady: true,
  }));
  assert.equal(success.readyDetected, true);
  assert.equal(success.readyElapsedMs, 384);

  const timeout = new FakeSerial({
    status: ready.status,
    waitResult: {
      success: false,
      pattern: 'SYSTEM READY',
      elapsedMs: 5000,
      error: 'Timed out waiting for serial pattern: SYSTEM READY',
    },
  });
  const warning = await buildAndRun(runOptions({
    serial: timeout,
    serialSettings: serialSettings(),
    waitForSerialReady: true,
  }));
  assert.equal(warning.success, true);
  assert.equal(warning.status, 'warning');
  assert.equal(warning.readyDetected, false);
  assert.match(warning.warnings[0], /runtime readiness was not confirmed/u);
});

test('serial disconnect during Ready wait returns warning without failing deployment', async () => {
  const serial = new FakeSerial({
    status: {
      connected: true, state: 'connected', port: '/dev/cu.drop', baudRate: 115200,
      openedAt: Date.now(), bytesReceived: 0, bytesSent: 0,
    },
    waitResult: {
      success: false,
      pattern: 'SYSTEM READY',
      elapsedMs: 18,
      error: 'Serial port disconnected',
    },
  });
  serial.waitSerial = async function(pattern) {
    this.status = disconnectedStatus();
    return { ...this.waitResult, pattern };
  };
  const result = await buildAndRun(runOptions({
    serial,
    serialSettings: serialSettings(),
    waitForSerialReady: true,
  }));
  assert.equal(result.success, true);
  assert.equal(result.serialConnected, false);
  assert.match(result.warnings[0], /disconnected/u);
});

test('Reset failure aborts and cleans the pending Ready waiter', async () => {
  let aborted = false;
  const serial = new FakeSerial({
    status: {
      connected: true, state: 'connected', port: '/dev/cu.abort', baudRate: 115200,
      openedAt: Date.now(), bytesReceived: 0, bytesSent: 0,
    },
  });
  serial.waitSerial = (_pattern, _timeout, options) => new Promise((resolve) => {
    options.signal.addEventListener('abort', () => {
      aborted = true;
      resolve({ success: false, pattern: 'SYSTEM READY', elapsedMs: 1, error: 'Serial wait cancelled' });
    }, { once: true });
  });
  const result = await buildAndRun(runOptions({
    serial,
    serialSettings: serialSettings(),
    waitForSerialReady: true,
    dependencies: dependencies({
      resetTarget: async () => resetResult(false, 'Reset failed'),
    }),
  }));
  assert.equal(result.failedStage, 'resetting');
  assert.equal(aborted, true);
});

test('Run IDs increase for consecutive runs', async () => {
  const first = await buildAndRun(runOptions());
  const second = await buildAndRun(runOptions());
  assert.notEqual(first.runId, second.runId);
  assert.equal(second.runId, first.runId + 1);
});

test('duplicate Build & Run is rejected by the operation lock', async () => {
  const lock = new Dockyard32OperationLock();
  let releaseBuild;
  const blockedBuild = new Promise((resolve) => { releaseBuild = resolve; });
  const firstRun = buildAndRun(runOptions({
    operationLock: lock,
    dependencies: dependencies({
      buildProject: async () => {
        await blockedBuild;
        return buildResult();
      },
    }),
  }));
  await new Promise((resolve) => setImmediate(resolve));
  const duplicate = await buildAndRun(runOptions({ operationLock: lock }));
  assert.equal(duplicate.success, false);
  assert.equal(duplicate.error, 'Build & Run already in progress');
  releaseBuild();
  assert.equal((await firstRun).success, true);
});

test('run lock protects independent Flash and Reset operations', () => {
  const lock = new Dockyard32OperationLock();
  const runLease = lock.acquire('run');
  assert.ok(runLease);
  assert.equal(lock.acquire('flash'), undefined);
  assert.equal(lock.acquire('reset'), undefined);
  runLease.release();
  const flashLease = lock.acquire('flash');
  assert.ok(flashLease);
  flashLease.release();
});

test('firmware validation requires a real file inside the current build directory', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stm32-run-firmware-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const buildDirectory = path.join(root, 'build');
  await fs.mkdir(buildDirectory);
  const firmware = path.join(buildDirectory, 'Controller.elf');
  const outside = path.join(root, 'stale.elf');
  await Promise.all([
    fs.writeFile(firmware, 'ELF'),
    fs.writeFile(outside, 'STALE'),
  ]);
  const project = projectInfo(root);
  assert.equal((await validateFirmwareArtifact(project, firmware, Date.now())).success, true);
  const rejected = await validateFirmwareArtifact(project, outside, Date.now());
  assert.equal(rejected.success, false);
  assert.match(rejected.error, /current build directory/u);
});

test('new-data serial waits ignore old startup text and clean up on abort/disconnect', async () => {
  class Connection {
    isOpen = true;
    constructor(options) { this.options = options; }
    async write() {}
    async close() { this.isOpen = false; this.options.onClose(); }
    receive(text) { this.options.onData(Buffer.from(text)); }
  }
  const adapter = {
    connection: undefined,
    list: async () => [],
    async open(options) {
      this.connection = new Connection(options);
      return this.connection;
    },
  };
  const service = new SerialService({ adapter });
  await service.connectSerial({
    path: '/dev/cu.mock', baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none',
  });
  adapter.connection.receive('SYSTEM READY\n');
  const controller = new AbortController();
  const cancelled = service.waitSerial('SYSTEM READY', 500, {
    includeExisting: false,
    signal: controller.signal,
  });
  controller.abort();
  assert.match((await cancelled).error, /cancelled/u);

  const disconnected = service.waitSerial('NEXT READY', 500, { includeExisting: false });
  await service.disconnectSerial();
  assert.match((await disconnected).error, /disconnected/u);
  service.dispose();
});

test('Run Marker remains UI metadata and does not enter Core raw serial log', async () => {
  const serialSource = await fs.readFile(
    path.join(__dirname, '..', 'src', 'ui', 'serialPanel.ts'),
    'utf8',
  );
  assert.match(serialSource, /appendMarker/u);
  const service = new SerialService({
    adapter: { list: async () => [], open: async () => { throw new Error('unused'); } },
  });
  const before = service.getSerialLog();
  await buildAndRun(runOptions({ serial: service, serialSettings: serialSettings() }));
  assert.equal(service.getSerialLog(), before);
  service.dispose();
});
