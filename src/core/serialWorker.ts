import { SerialPort } from 'serialport';
import { constants as fsConstants, promises as fs } from 'node:fs';

import type { SerialConfiguration } from '../types/serial';
import type {
  SerialWorkerEvent,
  SerialWorkerRequest,
  SerialWorkerResponse,
} from '../types/serialWorker';

let port: SerialPort | undefined;

if (process.env.STM32_SERIAL_WORKER_TEST_CRASH === '1') {
  process.exit(86);
}

process.on('message', (message: unknown) => {
  if (!isRequest(message)) {
    return;
  }
  void handleRequest(message);
});

process.on('disconnect', () => {
  if (port?.isOpen === true) {
    port.close();
  }
  process.exit(0);
});

async function handleRequest(request: SerialWorkerRequest): Promise<void> {
  try {
    switch (request.method) {
      case 'list': {
        const ports = await SerialPort.list();
        const expandedPorts = await addMacOsCalloutPorts(ports);
        respond({
          kind: 'response',
          id: request.id,
          success: true,
          result: expandedPorts.map((candidate) => ({
            path: candidate.path,
            manufacturer: candidate.manufacturer,
            serialNumber: candidate.serialNumber,
            vendorId: candidate.vendorId,
            productId: candidate.productId,
            friendlyName: optionalString(candidate, 'friendlyName'),
          })),
        });
        return;
      }
      case 'open': {
        const configuration = request.payload as SerialConfiguration;
        if (port?.isOpen === true) {
          throw new Error('A serial port is already open');
        }
        const nextPort = new SerialPort({
          ...configuration,
          autoOpen: false,
        });
        nextPort.on('data', (data: Buffer) => {
          emit({
            kind: 'event',
            event: 'data',
            data: Buffer.from(data).toString('base64'),
          });
        });
        nextPort.on('error', (error) => {
          emit({ kind: 'event', event: 'error', error: error.message });
        });
        nextPort.on('close', () => {
          port = undefined;
          emit({ kind: 'event', event: 'close' });
        });
        await callbackOperation((callback) => nextPort.open(callback));
        port = nextPort;
        respond({ kind: 'response', id: request.id, success: true });
        return;
      }
      case 'write': {
        if (port?.isOpen !== true) {
          throw new Error('Serial port is not connected');
        }
        const data = Buffer.from(
          (request.payload as { readonly data: string }).data,
          'base64',
        );
        await callbackOperation((callback) => port?.write(data, callback));
        await callbackOperation((callback) => port?.drain(callback));
        respond({ kind: 'response', id: request.id, success: true });
        return;
      }
      case 'close': {
        const current = port;
        if (current?.isOpen === true) {
          await callbackOperation((callback) => current.close(callback));
        }
        port = undefined;
        respond({ kind: 'response', id: request.id, success: true });
      }
    }
  } catch (error: unknown) {
    respond({
      kind: 'response',
      id: request.id,
      success: false,
      error: errorMessage(error),
    });
  }
}

async function addMacOsCalloutPorts<T extends { readonly path: string }>(
  ports: readonly T[],
): Promise<readonly T[]> {
  if (process.platform !== 'darwin') {
    return ports;
  }
  const expanded = [...ports];
  const paths = new Set(ports.map((candidate) => candidate.path));
  for (const candidate of ports) {
    if (!candidate.path.startsWith('/dev/tty.')) {
      continue;
    }
    const calloutPath = `/dev/cu.${candidate.path.slice('/dev/tty.'.length)}`;
    if (paths.has(calloutPath) || !(await pathExists(calloutPath))) {
      continue;
    }
    expanded.push({ ...candidate, path: calloutPath });
    paths.add(calloutPath);
  }
  return expanded;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, fsConstants.R_OK | fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function respond(response: SerialWorkerResponse): void {
  process.send?.(response);
}

function emit(event: SerialWorkerEvent): void {
  process.send?.(event);
}

function isRequest(value: unknown): value is SerialWorkerRequest {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return record.kind === 'request' &&
    typeof record.id === 'number' &&
    (record.method === 'list' ||
      record.method === 'open' ||
      record.method === 'write' ||
      record.method === 'close');
}

function callbackOperation(
  operation: (callback: (error: Error | null | undefined) => void) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    operation((error) => {
      if (error !== null && error !== undefined) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function optionalString(value: object, property: string): string | undefined {
  const candidate: unknown = Reflect.get(value, property);
  return typeof candidate === 'string' ? candidate : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
