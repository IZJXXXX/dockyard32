import { fork, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';

import type {
  SerialAdapter,
  SerialAdapterConnection,
  SerialAdapterOpenOptions,
  SerialConfiguration,
  SerialLogEvent,
  SerialOperationResult,
  SerialPortInfo,
  SerialServiceOptions,
  SerialStatus,
  SerialWaitOptions,
  SerialWaitResult,
} from '../types/serial';
import type {
  SerialWorkerEvent,
  SerialWorkerMessage,
  SerialWorkerMethod,
  SerialWorkerRequest,
  SerialWorkerResponse,
} from '../types/serialWorker';

const DEFAULT_MAX_LOG_LINES = 10_000;
const DEFAULT_MAX_LOG_CHARACTERS = 1_000_000;

interface SerialWaiter {
  readonly pattern: string;
  readonly startedAt: number;
  readonly resolve: (result: SerialWaitResult) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly signal?: AbortSignal;
  readonly abortListener?: () => void;
  searchText: string;
}

type LogListener = (event: SerialLogEvent) => void;
type StatusListener = (status: SerialStatus) => void;

export class SerialService {
  private readonly adapter: SerialAdapter;
  private readonly maxLogLines: number;
  private readonly maxLogCharacters: number;
  private readonly logListeners = new Set<LogListener>();
  private readonly statusListeners = new Set<StatusListener>();
  private readonly waiters = new Set<SerialWaiter>();
  private readonly decoder = new TextDecoder('utf-8', { fatal: false });

  private connection?: SerialAdapterConnection;
  private configuration?: SerialConfiguration;
  private state: SerialStatus['state'] = 'disconnected';
  private log = '';
  private pendingCarriageReturn = false;
  private bytesReceived = 0;
  private bytesSent = 0;
  private openedAt?: number;
  private lastError?: string;

  public constructor(options: SerialServiceOptions = {}) {
    this.adapter = options.adapter ?? new NodeSerialAdapter();
    this.maxLogLines = positiveInteger(
      options.maxLogLines,
      DEFAULT_MAX_LOG_LINES,
    );
    this.maxLogCharacters = positiveInteger(
      options.maxLogCharacters,
      DEFAULT_MAX_LOG_CHARACTERS,
    );
  }

  public async listSerialPorts(): Promise<readonly SerialPortInfo[]> {
    try {
      const ports = await this.adapter.list();
      this.lastError = undefined;
      this.emitStatus();
      return ports
        .map((port) => ({ ...port }))
        .sort(compareSerialPorts);
    } catch (error: unknown) {
      this.recordError(error);
      return [];
    }
  }

  public async connectSerial(
    configuration: SerialConfiguration,
  ): Promise<SerialOperationResult> {
    const validationError = validateConfiguration(configuration);
    if (validationError !== undefined) {
      this.recordError(validationError);
      return { success: false, error: validationError };
    }
    if (this.state !== 'disconnected') {
      return {
        success: false,
        error: `Serial port is currently ${this.state}`,
      };
    }

    this.state = 'connecting';
    this.configuration = { ...configuration };
    this.lastError = undefined;
    this.emitStatus();

    try {
      const connection = await this.adapter.open({
        ...configuration,
        onData: (data) => this.receiveData(data),
        onError: (error) => this.handleConnectionError(error),
        onClose: () => this.handleConnectionClose(),
      });
      this.connection = connection;
      this.state = 'connected';
      this.openedAt = Date.now();
      this.bytesReceived = 0;
      this.bytesSent = 0;
      this.lastError = undefined;
      this.emitStatus();
      return {
        success: true,
        message: `Connected to ${configuration.path}`,
      };
    } catch (error: unknown) {
      this.connection = undefined;
      this.state = 'disconnected';
      this.openedAt = undefined;
      const message = errorMessage(error);
      this.lastError = message;
      this.emitStatus();
      return { success: false, error: message };
    }
  }

  public async disconnectSerial(): Promise<SerialOperationResult> {
    const connection = this.connection;
    if (connection === undefined || this.state === 'disconnected') {
      return { success: true, message: 'Serial port is already disconnected' };
    }

    this.state = 'disconnecting';
    this.emitStatus();
    try {
      await connection.close();
      this.finishDecoding();
      this.connection = undefined;
      this.state = 'disconnected';
      this.openedAt = undefined;
      this.emitStatus();
      return { success: true, message: 'Serial port disconnected' };
    } catch (error: unknown) {
      const message = errorMessage(error);
      this.lastError = message;
      this.state = connection.isOpen ? 'connected' : 'disconnected';
      this.emitStatus();
      return { success: false, error: message };
    }
  }

  public async sendSerial(text: string): Promise<SerialOperationResult> {
    const connection = this.connection;
    if (
      connection === undefined ||
      !connection.isOpen ||
      this.state !== 'connected'
    ) {
      return { success: false, error: 'Serial port is not connected' };
    }
    if (text.length === 0) {
      return { success: false, error: 'Text to send is empty' };
    }

    const data = Buffer.from(text, 'utf8');
    try {
      await connection.write(data);
      this.bytesSent += data.byteLength;
      this.lastError = undefined;
      this.emitStatus();
      return {
        success: true,
        message: `Sent ${data.byteLength} bytes`,
      };
    } catch (error: unknown) {
      const message = errorMessage(error);
      this.lastError = message;
      this.emitStatus();
      return { success: false, error: message };
    }
  }

  public getSerialStatus(): SerialStatus {
    return {
      connected: this.state === 'connected',
      state: this.state,
      port: this.configuration?.path,
      baudRate: this.configuration?.baudRate,
      openedAt: this.openedAt,
      bytesReceived: this.bytesReceived,
      bytesSent: this.bytesSent,
      lastError: this.lastError,
    };
  }

  public getSerialLog(): string {
    return this.log;
  }

  public clearSerialLog(): SerialOperationResult {
    this.log = '';
    this.pendingCarriageReturn = false;
    this.emitLog('', true);
    return { success: true, message: 'Serial log cleared' };
  }

  public waitSerial(
    pattern: string,
    timeoutMs: number,
    options: SerialWaitOptions = {},
  ): Promise<SerialWaitResult> {
    const startedAt = Date.now();
    if (pattern.length === 0) {
      return Promise.resolve({
        success: false,
        pattern,
        elapsedMs: 0,
        error: 'Serial wait pattern is empty',
      });
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return Promise.resolve({
        success: false,
        pattern,
        elapsedMs: 0,
        error: 'Serial wait timeout must be greater than zero',
      });
    }
    if (options.signal?.aborted === true) {
      return Promise.resolve({
        success: false,
        pattern,
        elapsedMs: 0,
        error: 'Serial wait cancelled',
      });
    }
    const includeExisting = options.includeExisting ?? true;
    if (includeExisting && this.log.includes(pattern)) {
      return Promise.resolve({
        success: true,
        pattern,
        elapsedMs: 0,
        matchedText: pattern,
      });
    }

    return new Promise((resolve) => {
      const abortListener = (): void => {
        this.finishWaiter(waiter, {
          success: false,
          pattern,
          elapsedMs: Date.now() - startedAt,
          error: 'Serial wait cancelled',
        });
      };
      const waiter: SerialWaiter = {
        pattern,
        startedAt,
        resolve,
        timer: setTimeout(() => {
          this.finishWaiter(waiter, {
            success: false,
            pattern,
            elapsedMs: Date.now() - startedAt,
            error: `Timed out waiting for serial pattern: ${pattern}`,
          });
        }, timeoutMs),
        signal: options.signal,
        abortListener: options.signal === undefined ? undefined : abortListener,
        searchText: includeExisting
          ? trailingText(this.log, pattern.length - 1)
          : '',
      };
      this.waiters.add(waiter);
      options.signal?.addEventListener('abort', abortListener, { once: true });
      if (options.signal?.aborted === true) {
        abortListener();
      }
    });
  }

  public onDidReceiveLog(listener: LogListener): () => void {
    this.logListeners.add(listener);
    return () => this.logListeners.delete(listener);
  }

  public onDidChangeStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  public dispose(): void {
    this.finishAllWaiters('Serial service disposed');
    this.logListeners.clear();
    this.statusListeners.clear();
    void this.disconnectSerial();
  }

  private receiveData(data: Buffer): void {
    this.bytesReceived += data.byteLength;
    const decoded = this.decoder.decode(data, { stream: true });
    const normalized = this.normalizeLineEndings(decoded);
    if (normalized.length > 0) {
      this.appendLog(normalized);
    }
    this.emitStatus();
  }

  private normalizeLineEndings(text: string): string {
    let input = text;
    let output = '';
    if (this.pendingCarriageReturn) {
      if (input.startsWith('\n')) {
        input = input.slice(1);
      }
      this.pendingCarriageReturn = false;
    }

    for (let index = 0; index < input.length; index += 1) {
      const character = input[index];
      if (character === '\r') {
        output += '\n';
        if (index + 1 < input.length) {
          if (input[index + 1] === '\n') {
            index += 1;
          }
        } else {
          this.pendingCarriageReturn = true;
        }
      } else {
        output += character;
      }
    }
    return output;
  }

  private finishDecoding(): void {
    const decoded = this.decoder.decode();
    const normalized = this.normalizeLineEndings(decoded);
    this.pendingCarriageReturn = false;
    if (normalized.length > 0) {
      this.appendLog(normalized);
    }
  }

  private appendLog(text: string): void {
    this.log += text;
    const trimmed = this.trimLog();
    this.resolveWaiters(text);
    this.emitLog(trimmed ? this.log : text, trimmed);
  }

  private trimLog(): boolean {
    let trimmed = false;
    if (this.log.length > this.maxLogCharacters) {
      this.log = this.log.slice(-this.maxLogCharacters);
      trimmed = true;
    }

    let newlineCount = 0;
    for (let index = this.log.length - 1; index >= 0; index -= 1) {
      if (this.log[index] === '\n') {
        newlineCount += 1;
        if (newlineCount > this.maxLogLines) {
          this.log = this.log.slice(index + 1);
          trimmed = true;
          break;
        }
      }
    }
    return trimmed;
  }

  private resolveWaiters(text: string): void {
    for (const waiter of this.waiters) {
      waiter.searchText += text;
      if (waiter.searchText.includes(waiter.pattern)) {
        this.finishWaiter(waiter, {
          success: true,
          pattern: waiter.pattern,
          elapsedMs: Date.now() - waiter.startedAt,
          matchedText: waiter.pattern,
        });
      } else {
        waiter.searchText = trailingText(
          waiter.searchText,
          waiter.pattern.length - 1,
        );
      }
    }
  }

  private finishWaiter(
    waiter: SerialWaiter,
    result: SerialWaitResult,
  ): void {
    if (!this.waiters.delete(waiter)) {
      return;
    }
    clearTimeout(waiter.timer);
    if (waiter.abortListener !== undefined) {
      waiter.signal?.removeEventListener('abort', waiter.abortListener);
    }
    waiter.resolve(result);
  }

  private finishAllWaiters(error: string): void {
    for (const waiter of [...this.waiters]) {
      this.finishWaiter(waiter, {
        success: false,
        pattern: waiter.pattern,
        elapsedMs: Date.now() - waiter.startedAt,
        error,
      });
    }
  }

  private handleConnectionError(error: Error): void {
    this.lastError = error.message;
    this.finishAllWaiters(`Serial port error: ${error.message}`);
    this.emitStatus();
  }

  private handleConnectionClose(): void {
    this.finishDecoding();
    this.connection = undefined;
    this.state = 'disconnected';
    this.openedAt = undefined;
    this.finishAllWaiters('Serial port disconnected');
    this.emitStatus();
  }

  private recordError(error: unknown): void {
    this.lastError = errorMessage(error);
    this.emitStatus();
  }

  private emitLog(text: string, replace = false): void {
    const event = { text, totalLength: this.log.length, replace };
    for (const listener of this.logListeners) {
      listener(event);
    }
  }

  private emitStatus(): void {
    const status = this.getSerialStatus();
    for (const listener of this.statusListeners) {
      listener(status);
    }
  }
}

class NodeSerialAdapter implements SerialAdapter {
  public async list(): Promise<readonly SerialPortInfo[]> {
    const worker = new SerialWorkerClient();
    try {
      const response = await worker.request('list');
      return response.result ?? [];
    } finally {
      worker.dispose();
    }
  }

  public async open(
    options: SerialAdapterOpenOptions,
  ): Promise<SerialAdapterConnection> {
    let open = false;
    let closed = false;
    const worker = new SerialWorkerClient({
      onEvent: (event): void => {
        if (event.event === 'data' && event.data !== undefined) {
          options.onData(Buffer.from(event.data, 'base64'));
        } else if (event.event === 'error') {
          options.onError(new Error(event.error ?? 'Serial backend error'));
        } else if (event.event === 'close') {
          open = false;
          if (!closed) {
            closed = true;
            options.onClose();
          }
        }
      },
      onUnexpectedExit: (message): void => {
        open = false;
        options.onError(new Error(message));
        if (!closed) {
          closed = true;
          options.onClose();
        }
      },
    });
    try {
      await worker.request('open', {
        path: options.path,
        baudRate: options.baudRate,
        dataBits: options.dataBits,
        stopBits: options.stopBits,
        parity: options.parity,
      });
      open = true;
    } catch (error: unknown) {
      worker.dispose();
      throw error;
    }

    return {
      get isOpen(): boolean {
        return open;
      },
      write: async (data: Buffer): Promise<void> => {
        await worker.request('write', { data: data.toString('base64') });
      },
      close: async (): Promise<void> => {
        if (open) {
          await worker.request('close');
        }
        open = false;
        closed = true;
        worker.dispose();
      },
    };
  }
}

interface SerialWorkerClientOptions {
  readonly onEvent?: (event: SerialWorkerEvent) => void;
  readonly onUnexpectedExit?: (message: string) => void;
}

interface PendingWorkerRequest {
  readonly resolve: (response: SerialWorkerResponse) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

class SerialWorkerClient {
  private readonly child: ChildProcess;
  private readonly pending = new Map<number, PendingWorkerRequest>();
  private nextRequestId = 1;
  private disposed = false;

  public constructor(private readonly options: SerialWorkerClientOptions = {}) {
    this.child = fork(path.join(__dirname, 'serialWorker.js'), [], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      execArgv: [],
    });
    this.child.on('message', (message: unknown) => this.handleMessage(message));
    this.child.once('error', (error) => this.handleExit(error.message));
    this.child.once('exit', (code, signal) => {
      if (!this.disposed) {
        this.handleExit(
          `Serial backend exited unexpectedly (${signal ?? `code ${code ?? 'unknown'}`})`,
        );
      }
    });
  }

  public request(
    method: SerialWorkerMethod,
    payload?: SerialWorkerRequest['payload'],
  ): Promise<SerialWorkerResponse> {
    if (this.disposed || !this.child.connected) {
      return Promise.reject(new Error('Serial backend is unavailable'));
    }
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Serial backend timed out during ${method}`));
      }, method === 'open' ? 10_000 : 5_000);
      this.pending.set(id, { resolve, reject, timer });
      const request: SerialWorkerRequest = {
        kind: 'request',
        id,
        method,
        payload,
      };
      this.child.send(request, (error) => {
        if (error !== null) {
          const pending = this.pending.get(id);
          if (pending !== undefined) {
            clearTimeout(pending.timer);
            this.pending.delete(id);
            pending.reject(error);
          }
        }
      });
    });
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Serial backend stopped'));
    }
    this.pending.clear();
    if (this.child.connected) {
      this.child.disconnect();
    } else if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill();
    }
  }

  private handleMessage(message: unknown): void {
    if (!isWorkerMessage(message)) {
      return;
    }
    if (message.kind === 'event') {
      this.options.onEvent?.(message);
      return;
    }
    const pending = this.pending.get(message.id);
    if (pending === undefined) {
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.success) {
      pending.resolve(message);
    } else {
      pending.reject(new Error(message.error ?? 'Serial backend operation failed'));
    }
  }

  private handleExit(message: string): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.pending.clear();
    this.options.onUnexpectedExit?.(message);
  }
}

function isWorkerMessage(value: unknown): value is SerialWorkerMessage {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.kind === 'event') {
    return record.event === 'data' ||
      record.event === 'error' ||
      record.event === 'close';
  }
  return record.kind === 'response' &&
    typeof record.id === 'number' &&
    typeof record.success === 'boolean';
}

function compareSerialPorts(left: SerialPortInfo, right: SerialPortInfo): number {
  const leftPriority = serialPortPriority(left);
  const rightPriority = serialPortPriority(right);
  return leftPriority - rightPriority || left.path.localeCompare(right.path);
}

function serialPortPriority(port: SerialPortInfo): number {
  const searchable = [
    port.path,
    port.friendlyName,
    port.manufacturer,
    port.vendorId,
    port.productId,
  ].filter((value): value is string => value !== undefined).join(' ').toLowerCase();
  const isCallout = port.path.startsWith('/dev/cu.');
  const isDialIn = port.path.startsWith('/dev/tty.');
  const isSystemOnly = /bluetooth|debug-console/u.test(searchable);
  const isUsbSerial = port.vendorId !== undefined ||
    /usbmodem|usbserial|wchusbserial|slab_usb|cp210|ch34|ch91|ftdi|usb single serial/u
      .test(searchable);

  if (isSystemOnly) {
    return isCallout ? 40 : 60;
  }
  if (isCallout && isUsbSerial) {
    return 0;
  }
  if (isCallout) {
    return 10;
  }
  if (isDialIn && isUsbSerial) {
    return 20;
  }
  if (!isDialIn && isUsbSerial) {
    return 15;
  }
  return isDialIn ? 50 : 30;
}

function validateConfiguration(
  configuration: SerialConfiguration,
): string | undefined {
  if (configuration.path.trim().length === 0 || configuration.path === 'auto') {
    return 'A serial port must be selected';
  }
  if (
    !Number.isSafeInteger(configuration.baudRate) ||
    configuration.baudRate <= 0
  ) {
    return 'Baud rate must be a positive integer';
  }
  return undefined;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;
}

function trailingText(value: string, length: number): string {
  return length > 0 ? value.slice(-length) : '';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
