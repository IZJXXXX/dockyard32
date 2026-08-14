import type {
  SerialAdapterPort,
  SerialConfiguration,
} from './serial';

export type SerialWorkerMethod = 'list' | 'open' | 'write' | 'close';

export interface SerialWorkerRequest {
  readonly kind: 'request';
  readonly id: number;
  readonly method: SerialWorkerMethod;
  readonly payload?: SerialConfiguration | { readonly data: string };
}

export interface SerialWorkerResponse {
  readonly kind: 'response';
  readonly id: number;
  readonly success: boolean;
  readonly result?: readonly SerialAdapterPort[];
  readonly error?: string;
}

export interface SerialWorkerEvent {
  readonly kind: 'event';
  readonly event: 'data' | 'error' | 'close';
  readonly data?: string;
  readonly error?: string;
}

export type SerialWorkerMessage = SerialWorkerResponse | SerialWorkerEvent;
