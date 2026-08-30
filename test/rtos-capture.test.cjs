const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { captureFreeRtosSnapshot } = require('../out/core/rtosDebug.js');
const { RtosSnapshotStore } = require('../out/core/rtosSnapshotStore.js');

const SNAPSHOT = JSON.stringify({
  currentTaskAddress: 536871168,
  tasks: [{
    id: 1,
    address: 536871168,
    name: 'Worker',
    state: 'running',
    priority: 3,
  }],
  objects: [],
  relations: [],
  warnings: [],
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dockyard32-rtos-capture-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'firmware.elf'), 'ELF fixture');
  return root;
}

async function executable(file, source) {
  await fs.writeFile(file, `#!/usr/bin/env node\n${source}\n`);
  await fs.chmod(file, 0o755);
  return file;
}

async function server(root, options = {}) {
  const pidFile = path.join(root, options.pidName ?? 'server.pid');
  const launchFile = path.join(root, options.launchName ?? 'server.launches');
  const source = options.fail
    ? `process.exit(${options.fail});`
    : `
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
fs.appendFileSync(${JSON.stringify(launchFile)}, '1\\n');
${options.silent ? '' : "console.log('Waiting for debugger connection');"}
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`;
  return {
    executable: await executable(path.join(root, options.name ?? 'fake-server'), source),
    pidFile,
    launchFile,
  };
}

async function gdb(root, source, name = 'fake-gdb') {
  return executable(path.join(root, name), source);
}

function options(root, gdbExecutable, gdbServerExecutable, overrides = {}) {
  return {
    elfPath: path.join(root, 'firmware.elf'),
    gdbExecutable,
    gdbServerExecutable,
    programmerExecutable: path.join(root, 'STM32_Programmer_CLI'),
    serverStartupTimeoutMs: 3000,
    captureTimeoutMs: 3000,
    terminateGraceMs: 100,
    ...overrides,
  };
}

async function readPid(file) {
  return Number(await fs.readFile(file, 'utf8'));
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    throw error;
  }
}

async function waitForFile(file, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fs.access(file);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${file}`);
}

test('capture succeeds only with valid JSON, zero GDB exit, and confirmed detach', async (t) => {
  const root = await fixture(t);
  const fakeServer = await server(root);
  const fakeGdb = await gdb(root, `
console.log('DOCKYARD32_RTOS_JSON:' + ${JSON.stringify(SNAPSHOT)});
console.log('DOCKYARD32_RTOS_DETACHED');
`);
  const result = await captureFreeRtosSnapshot(options(root, fakeGdb, fakeServer.executable));
  assert.equal(result.success, true);
  assert.equal(result.targetResumed, true);
  assert.equal(result.tasks[0]?.name, 'Worker');
  assert.equal(processExists(await readPid(fakeServer.pidFile)), false);
});

test('JSON followed by a non-zero GDB exit is a capture failure', async (t) => {
  const root = await fixture(t);
  const fakeServer = await server(root);
  const fakeGdb = await gdb(root, `
console.log('DOCKYARD32_RTOS_JSON:' + ${JSON.stringify(SNAPSHOT)});
console.log('DOCKYARD32_RTOS_DETACHED');
process.exit(7);
`);
  const result = await captureFreeRtosSnapshot(options(root, fakeGdb, fakeServer.executable));
  assert.equal(result.success, false);
  assert.equal(result.targetResumed, true);
  assert.match(result.error, /exited with code 7/);
  assert.equal(processExists(await readPid(fakeServer.pidFile)), false);
});

test('missing detach confirmation fails and warns that target may remain paused', async (t) => {
  const root = await fixture(t);
  const fakeServer = await server(root);
  const fakeGdb = await gdb(root, `
console.log('DOCKYARD32_RTOS_JSON:' + ${JSON.stringify(SNAPSHOT)});
`);
  const result = await captureFreeRtosSnapshot(options(root, fakeGdb, fakeServer.executable));
  assert.equal(result.success, false);
  assert.equal(result.targetResumed, false);
  assert.match(result.error, /may still be paused/);
});

test('GDB timeout terminates GDB and GDB Server without residual processes', async (t) => {
  const root = await fixture(t);
  const fakeServer = await server(root);
  const gdbPidFile = path.join(root, 'gdb.pid');
  const fakeGdb = await gdb(root, `
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(gdbPidFile)}, String(process.pid));
process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
`);
  const result = await captureFreeRtosSnapshot(options(
    root,
    fakeGdb,
    fakeServer.executable,
    { captureTimeoutMs: 700, terminateGraceMs: 50 },
  ));
  assert.equal(result.success, false);
  assert.equal(result.targetResumed, false);
  assert.match(result.error, /timed out/);
  assert.equal(processExists(await readPid(gdbPidFile)), false);
  assert.equal(processExists(await readPid(fakeServer.pidFile)), false);
});

test('GDB Server startup failure does not launch GDB and leaves no process', async (t) => {
  const root = await fixture(t);
  const gdbLaunchFile = path.join(root, 'gdb-launched');
  const fakeServer = await server(root, { fail: 9 });
  const fakeGdb = await gdb(root, `
require('node:fs').writeFileSync(${JSON.stringify(gdbLaunchFile)}, 'yes');
`);
  const result = await captureFreeRtosSnapshot(options(root, fakeGdb, fakeServer.executable));
  assert.equal(result.success, false);
  assert.equal(result.targetResumed, true);
  await assert.rejects(fs.access(gdbLaunchFile));
});

test('GDB Server startup timeout terminates the server before launching GDB', async (t) => {
  const root = await fixture(t);
  const gdbLaunchFile = path.join(root, 'gdb-launched');
  const fakeServer = await server(root, { silent: true });
  const fakeGdb = await gdb(root, `
require('node:fs').writeFileSync(${JSON.stringify(gdbLaunchFile)}, 'yes');
`);
  const result = await captureFreeRtosSnapshot(options(
    root,
    fakeGdb,
    fakeServer.executable,
    { serverStartupTimeoutMs: 500 },
  ));
  assert.equal(result.success, false);
  assert.equal(result.targetResumed, true);
  assert.match(result.error, /server startup timed out/i);
  assert.equal(processExists(await readPid(fakeServer.pidFile)), false);
  await assert.rejects(fs.access(gdbLaunchFile));
});

test('duplicate Capture calls cannot start parallel GDB sessions', async (t) => {
  const root = await fixture(t);
  const fakeServer = await server(root);
  const gdbPidFile = path.join(root, 'slow-gdb.pid');
  const fakeGdb = await gdb(root, `
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(gdbPidFile)}, String(process.pid));
setTimeout(() => {
  console.log('DOCKYARD32_RTOS_JSON:' + ${JSON.stringify(SNAPSHOT)});
  console.log('DOCKYARD32_RTOS_DETACHED');
}, 180);
`);
  const first = captureFreeRtosSnapshot(options(root, fakeGdb, fakeServer.executable));
  await waitForFile(gdbPidFile);
  const second = await captureFreeRtosSnapshot(options(root, fakeGdb, fakeServer.executable));
  const firstResult = await first;
  assert.equal(firstResult.success, true);
  assert.equal(second.success, false);
  assert.match(second.error, /already in progress/);
  const launches = (await fs.readFile(fakeServer.launchFile, 'utf8')).trim().split('\n');
  assert.equal(launches.length, 1);
});

test('switching workspace, ELF, or kernel clears stale snapshots and rejects late captures', () => {
  const store = new RtosSnapshotStore();
  const snapshot = {
    success: true,
    kernel: 'freertos',
    capturedAt: 1,
    tasks: [],
    objects: [],
    relations: [],
    warnings: [],
    targetResumed: true,
  };
  store.updateContext({ workspacePath: '/workspace/a', kernel: 'freertos', elfPath: '/a.elf' });
  const oldToken = store.token();
  assert.equal(store.commit(oldToken, snapshot), true);
  assert.equal(store.get(), snapshot);
  assert.equal(store.updateContext({ workspacePath: '/workspace/a', kernel: 'freertos', elfPath: '/b.elf' }), true);
  assert.equal(store.get(), undefined);
  assert.equal(store.commit(oldToken, snapshot), false);
  const nextToken = store.token();
  assert.equal(store.commit(nextToken, snapshot), true);
  store.updateContext({ workspacePath: '/workspace/b', kernel: 'threadx', elfPath: '/b.elf' });
  assert.equal(store.get(), undefined);
});
