import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import type { BuildDiagnostic } from '../types/build';
import type {
  MdkMemoryRegion,
  MdkTargetInfo,
  ParsedMdkProject,
} from '../types/mdk';

export async function parseMdkProject(
  projectFile: string,
): Promise<ParsedMdkProject> {
  const xml = await fs.readFile(projectFile, 'utf8');
  const targets = extractElements(xml, 'Target').map(parseTarget);
  return { projectFile: path.resolve(projectFile), targets };
}

export function parseKeilDiagnostics(output: string): BuildDiagnostic[] {
  const diagnostics: BuildDiagnostic[] = [];
  const seen = new Set<string>();
  const pattern = /^(.+?)\((\d+)(?:,(\d+))?\):\s*(?:error|warning)(?:\s+#?[A-Z]?\d+(?:-[A-Z])?)?:\s*(.+)$/iu;
  for (const rawLine of output.split(/\r?\n/u)) {
    const line = rawLine.trim();
    const match = pattern.exec(line);
    if (match === null) {
      continue;
    }
    const diagnostic: BuildDiagnostic = {
      severity: /:\s*warning/iu.test(line) ? 'warning' : 'error',
      file: match[1]?.replaceAll('\\', path.sep).trim(),
      line: Number.parseInt(match[2] ?? '1', 10),
      column: match[3] === undefined
        ? undefined
        : Number.parseInt(match[3], 10),
      message: (match[4]?.trim() ?? line)
        .replace(/^#[A-Z]?\d+(?:-[A-Z])?:\s*/iu, ''),
    };
    const key = JSON.stringify(diagnostic);
    if (!seen.has(key)) {
      seen.add(key);
      diagnostics.push(diagnostic);
    }
  }
  return diagnostics;
}

function parseTarget(xml: string): MdkTargetInfo {
  const common = firstElement(xml, 'TargetCommonOption') ?? xml;
  const output = firstElement(xml, 'TargetOption') ?? xml;
  const cpu = textOf(common, 'Cpu') ?? '';
  const compiler = textOf(xml, 'uAC6') === '1'
    ? 'armclang6'
    : textOf(xml, 'uAC6') === '0' ? 'armcc5' : 'unknown';
  const filePaths = extractElements(xml, 'FilePath').map(decodeXml);
  return {
    name: textOf(xml, 'TargetName') ?? 'Target 1',
    device: textOf(common, 'Device'),
    outputDirectory: textOf(output, 'OutputDirectory'),
    outputName: textOf(output, 'OutputName'),
    createHexFile: textOf(output, 'CreateHexFile') === '1',
    sources: filePaths.filter((file) => !isLibrary(file)),
    libraries: filePaths.filter(isLibrary),
    includePaths: splitSemicolon(textOf(xml, 'IncludePath')),
    defines: splitComma(textOf(xml, 'Define')),
    scatterFile: textOf(xml, 'ScatterFile'),
    compiler,
    flash: memoryFromCpu(cpu, 'IROM') ?? memoryFromProject(xml, 'IROM'),
    ram: memoryFromCpu(cpu, 'IRAM') ?? memoryFromProject(xml, 'IRAM'),
    ccmRam: memoryFromCpu(cpu, 'IRAM2') ?? memoryFromProject(xml, 'IRAM2'),
  };
}

function isLibrary(file: string): boolean {
  return /\.(?:a|lib)$/iu.test(file);
}

function memoryFromProject(
  xml: string,
  name: 'IROM' | 'IRAM' | 'IRAM2',
): MdkMemoryRegion | undefined {
  const memory = firstElement(xml, name);
  const origin = memory === undefined ? undefined : textOf(memory, 'StartAddress');
  const length = memory === undefined ? undefined : textOf(memory, 'Size');
  return origin === undefined || length === undefined || Number.parseInt(length, 0) === 0
    ? undefined
    : { origin: normalizeHex(origin), length: normalizeHex(length) };
}

function memoryFromCpu(
  cpu: string,
  name: 'IROM' | 'IRAM' | 'IRAM2',
): MdkMemoryRegion | undefined {
  const match = new RegExp(`\\b${name}\\((0x[0-9a-f]+),(0x[0-9a-f]+)\\)`, 'iu')
    .exec(cpu);
  return match?.[1] === undefined || match[2] === undefined
    ? undefined
    : { origin: normalizeHex(match[1]), length: normalizeHex(match[2]) };
}

function extractElements(xml: string, tag: string): string[] {
  const escaped = escapeRegExp(tag);
  const pattern = new RegExp(
    `<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`,
    'giu',
  );
  return [...xml.matchAll(pattern)].map((match) => match[1] ?? '');
}

function firstElement(xml: string, tag: string): string | undefined {
  return extractElements(xml, tag)[0];
}

function textOf(xml: string, tag: string): string | undefined {
  const value = extractElements(xml, tag)
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate.length > 0);
  return value === undefined ? undefined : decodeXml(value);
}

function splitSemicolon(value: string | undefined): string[] {
  return (value ?? '').split(';').map((item) => item.trim()).filter(Boolean);
}

function splitComma(value: string | undefined): string[] {
  return (value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
}

function decodeXml(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function normalizeHex(value: string): string {
  const parsed = Number.parseInt(value, 16);
  return Number.isNaN(parsed)
    ? value
    : `0x${parsed.toString(16).toUpperCase().padStart(8, '0')}`;
}
