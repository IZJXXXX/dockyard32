const assert = require('node:assert/strict');
const test = require('node:test');

const { SerialService } = require('../out/core/serial.js');

test('default SerialService enumerates ports through the isolated worker', async () => {
  const service = new SerialService();
  const ports = await service.listSerialPorts();
  assert.ok(Array.isArray(ports));
  assert.equal(service.getSerialStatus().lastError, undefined);
  service.dispose();
});

test('a native worker failure cannot terminate the parent process', async () => {
  process.env.STM32_SERIAL_WORKER_TEST_CRASH = '1';
  const service = new SerialService();
  try {
    assert.deepEqual(await service.listSerialPorts(), []);
    assert.match(
      service.getSerialStatus().lastError,
      /Serial backend exited unexpectedly/u,
    );
  } finally {
    delete process.env.STM32_SERIAL_WORKER_TEST_CRASH;
    service.dispose();
  }
});
