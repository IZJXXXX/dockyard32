const assert = require('node:assert/strict');
const test = require('node:test');

const { SerialService } = require('../out/core/serial.js');

class MockConnection {
  isOpen = true;
  writes = [];

  constructor(options) {
    this.options = options;
  }

  async write(data) {
    this.writes.push(Buffer.from(data));
  }

  async close() {
    this.isOpen = false;
    this.options.onClose();
  }

  receive(data) {
    this.options.onData(Buffer.from(data));
  }

  fail(message) {
    this.options.onError(new Error(message));
  }
}

class MockAdapter {
  connection;

  async list() {
    return [
      { path: '/dev/tty.usbmodem1201' },
      {
        path: '/dev/cu.wchusbserial110',
        manufacturer: 'WCH',
        serialNumber: 'ABC123',
        vendorId: '1A86',
        productId: '7523',
      },
      { path: '/dev/cu.Bluetooth-Incoming-Port' },
      { path: '/dev/cu.debug-console' },
      {
        path: '/dev/cu.usbmodem5A7B0294941',
        friendlyName: 'USB Single Serial',
        vendorId: '1A86',
        productId: '55D3',
      },
      { path: '/dev/custom-uart' },
    ];
  }

  async open(options) {
    this.connection = new MockConnection(options);
    return this.connection;
  }
}

const configuration = {
  path: '/dev/cu.wchusbserial110',
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
};

test('serial ports prioritize physical USB callout devices without excluding other valid ports', async () => {
  const service = new SerialService({ adapter: new MockAdapter() });
  const ports = await service.listSerialPorts();
  assert.deepEqual(
    ports.map((port) => port.path),
    [
      '/dev/cu.usbmodem5A7B0294941',
      '/dev/cu.wchusbserial110',
      '/dev/tty.usbmodem1201',
      '/dev/custom-uart',
      '/dev/cu.Bluetooth-Incoming-Port',
      '/dev/cu.debug-console',
    ],
  );
  assert.equal(ports[1].manufacturer, 'WCH');
  service.dispose();
});

test('serial receive preserves split UTF-8 text and normalizes CR/LF boundaries', async () => {
  const adapter = new MockAdapter();
  const service = new SerialService({ adapter });
  const connected = await service.connectSerial(configuration);
  assert.equal(connected.success, true);

  const wait = service.waitSerial('SYSTEM READY', 500);
  adapter.connection.receive(Buffer.from('SYSTEM RE'));
  adapter.connection.receive(Buffer.from('ADY\r'));
  assert.equal(service.getSerialLog(), 'SYSTEM READY\n');
  adapter.connection.receive(Buffer.from('\nNEXT\rDONE\n'));
  assert.equal((await wait).success, true);
  assert.equal(service.getSerialLog(), 'SYSTEM READY\nNEXT\nDONE\n');
  assert.equal(service.getSerialStatus().bytesReceived, 24);

  adapter.connection.receive(Buffer.from([0x66, 0x6f, 0x80, 0x6f]));
  assert.match(service.getSerialLog(), /fo�o$/u);
  assert.equal(service.getSerialStatus().lastError, undefined);
  await service.disconnectSerial();
  service.dispose();
});

test('serial send returns structured results and tracks bytes', async () => {
  const adapter = new MockAdapter();
  const service = new SerialService({ adapter });
  assert.equal((await service.sendSerial('test')).success, false);
  await service.connectSerial({ ...configuration, baudRate: 921600 });

  const result = await service.sendSerial('你好');
  assert.equal(result.success, true);
  assert.equal(service.getSerialStatus().bytesSent, 6);
  assert.equal(adapter.connection.writes[0].toString('utf8'), '你好');
  assert.equal(service.getSerialStatus().baudRate, 921600);
  await service.disconnectSerial();
  assert.equal(service.getSerialStatus().connected, false);
  service.dispose();
});

test('serial log is bounded, clear replaces UI content, and wait can timeout', async () => {
  const adapter = new MockAdapter();
  const service = new SerialService({
    adapter,
    maxLogLines: 3,
    maxLogCharacters: 100,
  });
  const events = [];
  service.onDidReceiveLog((event) => events.push(event));
  await service.connectSerial(configuration);
  adapter.connection.receive(Buffer.from('1\n2\n3\n4\n'));
  assert.equal(service.getSerialLog(), '2\n3\n4\n');
  assert.equal(events.at(-1).replace, true);

  assert.equal(service.clearSerialLog().success, true);
  assert.equal(service.getSerialLog(), '');
  assert.deepEqual(events.at(-1), { text: '', totalLength: 0, replace: true });

  const timeout = await service.waitSerial('NEVER', 10);
  assert.equal(timeout.success, false);
  assert.match(timeout.error, /Timed out/u);
  service.dispose();
});

test('adapter errors are exposed through structured status without throwing', async () => {
  const adapter = {
    list: async () => {
      throw new Error('native binding unavailable');
    },
    open: async () => {
      throw new Error('permission denied');
    },
  };
  const service = new SerialService({ adapter });
  assert.deepEqual(await service.listSerialPorts(), []);
  assert.equal(service.getSerialStatus().lastError, 'native binding unavailable');
  const result = await service.connectSerial(configuration);
  assert.equal(result.success, false);
  assert.equal(result.error, 'permission denied');
  assert.equal(service.getSerialStatus().state, 'disconnected');
  service.dispose();
});
