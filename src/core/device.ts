import { runCommand } from './process';
import type { DeviceStatus, StLinkProbe } from '../types/device';

interface MutableProbe {
  index?: number;
  serialNumber?: string;
  firmwareVersion?: string;
  board?: string;
}

export async function getDeviceStatus(
  programmerExecutable?: string,
): Promise<DeviceStatus> {
  const checkedAt = Date.now();
  if (programmerExecutable === undefined) {
    return {
      programmerAvailable: false,
      probeConnected: false,
      probes: [],
      checkedAt,
      stdout: '',
      stderr: '',
      error: 'STM32CubeProgrammer CLI not found',
    };
  }

  const result = await runCommand(programmerExecutable, ['-l']);
  if (result.spawnError !== undefined) {
    return {
      programmerAvailable: false,
      probeConnected: false,
      probes: [],
      checkedAt,
      stdout: result.stdout,
      stderr: result.stderr,
      error:
        result.spawnError.code === 'ENOENT'
          ? 'STM32CubeProgrammer CLI not found'
          : result.spawnError.message,
    };
  }

  const probes = parseStLinkList(`${result.stdout}\n${result.stderr}`);
  return {
    programmerAvailable: true,
    probeConnected: probes.length > 0,
    probes,
    checkedAt,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    error:
      result.exitCode !== 0 && probes.length === 0
        ? lastMeaningfulLine(result.stderr, result.stdout)
        : undefined,
  };
}

export function parseStLinkList(output: string): StLinkProbe[] {
  const probes: StLinkProbe[] = [];
  let current: MutableProbe | undefined;

  function commit(): void {
    if (
      current !== undefined &&
      (current.serialNumber !== undefined || current.index !== undefined)
    ) {
      probes.push({ ...current });
    }
    current = undefined;
  }

  for (const rawLine of stripAnsi(output).split(/\r?\n/u)) {
    const line = rawLine.trim();
    const indexMatch = /(?:st-?link\s+)?(?:index|probe)\s*(?:[:#]\s*)?(\d+)/iu.exec(line);
    const serialMatch = /^(?:st-?link\s+)?(?:sn|serial(?:\s+number)?)\s*:\s*(\S+)/iu.exec(line);
    const firmwareMatch = /^(?:st-?link\s+)?(?:fw|firmware(?:\s+version)?)\s*:\s*(.+)$/iu.exec(line);
    const boardMatch = /^board\s*:\s*(.+)$/iu.exec(line);

    if (indexMatch?.[1] !== undefined) {
      commit();
      current = { index: Number.parseInt(indexMatch[1], 10) };
    } else if (serialMatch?.[1] !== undefined) {
      if (current?.serialNumber !== undefined) {
        commit();
      }
      current ??= {};
      current.serialNumber = serialMatch[1];
    } else if (firmwareMatch?.[1] !== undefined) {
      current ??= {};
      current.firmwareVersion = firmwareMatch[1].trim();
    } else if (boardMatch?.[1] !== undefined) {
      current ??= {};
      current.board = boardMatch[1].trim();
    }
  }
  commit();
  return probes;
}

function lastMeaningfulLine(stderr: string, stdout: string): string {
  return `${stderr}\n${stdout}`
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .at(-1) ?? 'Unable to query ST-LINK';
}

function stripAnsi(value: string): string {
  const escape = String.fromCodePoint(27);
  return value.replace(new RegExp(`${escape}\\[[0-?]*[ -/]*[@-~]`, 'gu'), '');
}
