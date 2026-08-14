import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { parse } from 'jsonc-parser';

import type { RunSerialSettings } from '../types/run';
import type { ToolKind } from '../types/tools';

export interface AgentWorkspaceConfiguration {
  readonly configuredTools: Partial<Record<ToolKind, string>>;
  readonly serial: RunSerialSettings;
  readonly flashVerify: boolean;
  readonly run: {
    readonly waitForSerialReady: boolean;
    readonly readyPattern: string;
    readonly readyTimeoutMs: number;
    readonly clearSerialBeforeRun: boolean;
  };
  readonly timeouts: {
    readonly buildMs: number;
    readonly flashMs: number;
    readonly resetMs: number;
    readonly runMs: number;
  };
}

const DEFAULT_CONFIGURATION: AgentWorkspaceConfiguration = {
  configuredTools: {},
  serial: {
    serialPort: 'auto',
    baudRate: 115_200,
    dataBits: 8,
    stopBits: 1,
    parity: 'none',
  },
  flashVerify: true,
  run: {
    waitForSerialReady: false,
    readyPattern: 'SYSTEM READY',
    readyTimeoutMs: 5_000,
    clearSerialBeforeRun: false,
  },
  timeouts: {
    buildMs: 10 * 60_000,
    flashMs: 2 * 60_000,
    resetMs: 30_000,
    runMs: 15 * 60_000,
  },
};

export async function readAgentWorkspaceConfiguration(
  workspacePath: string,
): Promise<AgentWorkspaceConfiguration> {
  const [settings, legacyConfiguration, dockyardConfiguration] = await Promise.all([
    readJsonc(path.join(workspacePath, '.vscode', 'settings.json')),
    readJsonc(path.join(workspacePath, '.vscode', 'stm32-workbench.json')),
    readJsonc(path.join(workspacePath, '.vscode', 'dockyard32.json')),
  ]);
  return mergeConfiguration(
    normalizeLegacySettings(settings),
    { ...legacyConfiguration, ...dockyardConfiguration },
  );
}

function normalizeLegacySettings(
  settings: Record<string, unknown>,
): Record<string, unknown> {
  const normalized = { ...settings };
  for (const [key, value] of Object.entries(settings)) {
    if (!key.startsWith('stm32Workbench.')) {
      continue;
    }
    const dockyardKey = `dockyard32.${key.slice('stm32Workbench.'.length)}`;
    if (!(dockyardKey in normalized)) {
      normalized[dockyardKey] = value;
    }
  }
  return normalized;
}

async function readJsonc(filePath: string): Promise<Record<string, unknown>> {
  try {
    const value: unknown = parse(await fs.readFile(filePath, 'utf8'));
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

function mergeConfiguration(
  settings: Record<string, unknown>,
  dockyardConfiguration: Record<string, unknown>,
): AgentWorkspaceConfiguration {
  const toolObject = nestedRecord(dockyardConfiguration, 'tools');
  const serialObject = nestedRecord(dockyardConfiguration, 'serial');
  const runObject = nestedRecord(dockyardConfiguration, 'run');
  const timeoutObject = nestedRecord(dockyardConfiguration, 'timeouts');
  return {
    configuredTools: compactTools({
      cmake: stringValue(
        settings['dockyard32.tools.cmakePath'],
        toolObject.cmakePath,
      ),
      ninja: stringValue(
        settings['dockyard32.tools.ninjaPath'],
        toolObject.ninjaPath,
      ),
      'arm-gcc': stringValue(
        settings['dockyard32.tools.armGccPath'],
        toolObject.armGccPath,
      ),
      programmer: stringValue(
        settings['dockyard32.tools.programmerPath'],
        toolObject.programmerPath,
      ),
    }),
    serial: {
      serialPort: stringValue(
        settings['dockyard32.serial.port'],
        dockyardConfiguration.serialPort,
        serialObject.port,
      ) ?? DEFAULT_CONFIGURATION.serial.serialPort,
      baudRate: positiveInteger(
        settings['dockyard32.serial.baudRate'],
        dockyardConfiguration.baudRate,
        serialObject.baudRate,
        DEFAULT_CONFIGURATION.serial.baudRate,
      ),
      dataBits: serialDataBits(
        settings['dockyard32.serial.dataBits'] ??
          dockyardConfiguration.dataBits ??
          serialObject.dataBits,
      ),
      stopBits: serialStopBits(
        settings['dockyard32.serial.stopBits'] ??
          dockyardConfiguration.stopBits ??
          serialObject.stopBits,
      ),
      parity: serialParity(
        settings['dockyard32.serial.parity'] ??
          dockyardConfiguration.parity ??
          serialObject.parity,
      ),
    },
    flashVerify: booleanValue(
      settings['dockyard32.flash.verify'],
      dockyardConfiguration.verify,
      true,
    ),
    run: {
      waitForSerialReady: booleanValue(
        settings['dockyard32.run.waitForSerialReady'],
        runObject.waitForSerialReady,
        false,
      ),
      readyPattern:
        stringValue(
          settings['dockyard32.run.readyPattern'],
          runObject.readyPattern,
        ) ?? DEFAULT_CONFIGURATION.run.readyPattern,
      readyTimeoutMs: positiveInteger(
        settings['dockyard32.run.readyTimeoutMs'],
        runObject.readyTimeoutMs,
        DEFAULT_CONFIGURATION.run.readyTimeoutMs,
      ),
      clearSerialBeforeRun: booleanValue(
        settings['dockyard32.run.clearSerialBeforeRun'],
        runObject.clearSerialBeforeRun,
        false,
      ),
    },
    timeouts: {
      buildMs: positiveInteger(
        timeoutObject.buildMs,
        DEFAULT_CONFIGURATION.timeouts.buildMs,
      ),
      flashMs: positiveInteger(
        timeoutObject.flashMs,
        DEFAULT_CONFIGURATION.timeouts.flashMs,
      ),
      resetMs: positiveInteger(
        timeoutObject.resetMs,
        DEFAULT_CONFIGURATION.timeouts.resetMs,
      ),
      runMs: positiveInteger(
        timeoutObject.runMs,
        DEFAULT_CONFIGURATION.timeouts.runMs,
      ),
    },
  };
}

function compactTools(
  values: Readonly<Record<ToolKind, string | undefined>>,
): Partial<Record<ToolKind, string>> {
  const result: Partial<Record<ToolKind, string>> = {};
  for (const kind of ['cmake', 'ninja', 'arm-gcc', 'programmer'] as const) {
    const value = values[kind];
    if (value !== undefined && value.trim().length > 0) {
      result[kind] = value;
    }
  }
  return result;
}

function nestedRecord(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = record[key];
  return isRecord(value) ? value : {};
}

function stringValue(...values: readonly unknown[]): string | undefined {
  return values.find(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
}

function booleanValue(
  ...values: readonly [...unknown[], boolean]
): boolean {
  const value = values.find((candidate) => typeof candidate === 'boolean');
  return typeof value === 'boolean' ? value : false;
}

function positiveInteger(...values: readonly [...unknown[], number]): number {
  const value = values.find(
    (candidate) =>
      typeof candidate === 'number' &&
      Number.isSafeInteger(candidate) &&
      candidate > 0,
  );
  return typeof value === 'number' ? value : 1;
}

function serialDataBits(value: unknown): 5 | 6 | 7 | 8 {
  return value === 5 || value === 6 || value === 7 || value === 8 ? value : 8;
}

function serialStopBits(value: unknown): 1 | 1.5 | 2 {
  return value === 1 || value === 1.5 || value === 2 ? value : 1;
}

function serialParity(
  value: unknown,
): 'none' | 'even' | 'odd' | 'mark' | 'space' {
  return value === 'even' ||
    value === 'odd' ||
    value === 'mark' ||
    value === 'space'
    ? value
    : 'none';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
