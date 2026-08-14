export type SerialDataBits = 5 | 6 | 7 | 8;

export type SerialStopBits = 1 | 1.5 | 2;

export type SerialParity = 'none' | 'even' | 'odd' | 'mark' | 'space';

export type SerialConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'disconnecting';

export interface SerialPortInfo {
  readonly path: string;
  readonly manufacturer?: string;
  readonly serialNumber?: string;
  readonly vendorId?: string;
  readonly productId?: string;
  readonly friendlyName?: string;
}

export interface SerialConfiguration {
  readonly path: string;
  readonly baudRate: number;
  readonly dataBits: SerialDataBits;
  readonly stopBits: SerialStopBits;
  readonly parity: SerialParity;
}

export interface SerialStatus {
  readonly connected: boolean;
  readonly state: SerialConnectionState;
  readonly port?: string;
  readonly baudRate?: number;
  readonly openedAt?: number;
  readonly bytesReceived: number;
  readonly bytesSent: number;
  readonly lastError?: string;
}

export interface SerialOperationResult {
  readonly success: boolean;
  readonly message?: string;
  readonly error?: string;
}

export interface SerialWaitResult {
  readonly success: boolean;
  readonly pattern: string;
  readonly elapsedMs: number;
  readonly matchedText?: string;
  readonly error?: string;
}

export interface SerialWaitOptions {
  /** Search the current bounded log before waiting for future data. */
  readonly includeExisting?: boolean;
  /** Cancels the wait and removes its listener without closing the port. */
  readonly signal?: AbortSignal;
}

export interface SerialLogEvent {
  readonly text: string;
  readonly totalLength: number;
  readonly replace: boolean;
}

export interface SerialAdapterPort {
  readonly path: string;
  readonly manufacturer?: string;
  readonly serialNumber?: string;
  readonly vendorId?: string;
  readonly productId?: string;
  readonly friendlyName?: string;
}

export interface SerialAdapterConnection {
  readonly isOpen: boolean;
  write(data: Buffer): Promise<void>;
  close(): Promise<void>;
}

export interface SerialAdapterOpenOptions extends SerialConfiguration {
  readonly onData: (data: Buffer) => void;
  readonly onError: (error: Error) => void;
  readonly onClose: () => void;
}

export interface SerialAdapter {
  list(): Promise<readonly SerialAdapterPort[]>;
  open(options: SerialAdapterOpenOptions): Promise<SerialAdapterConnection>;
}

export interface SerialServiceOptions {
  readonly maxLogLines?: number;
  readonly maxLogCharacters?: number;
  readonly adapter?: SerialAdapter;
}
