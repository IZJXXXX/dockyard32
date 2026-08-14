export interface StLinkProbe {
  readonly index?: number;
  readonly serialNumber?: string;
  readonly firmwareVersion?: string;
  readonly board?: string;
}

export interface DeviceStatus {
  readonly programmerAvailable: boolean;
  readonly probeConnected: boolean;
  readonly probes: readonly StLinkProbe[];
  readonly checkedAt: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode?: number;
  readonly error?: string;
}
