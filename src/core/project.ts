import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { parse as parseJsonc } from 'jsonc-parser';

import { parseMdkProject } from './mdk';
import type {
  McuDetectionSource,
  Stm32ProjectInfo,
} from '../types/project';
import type { ParsedMdkProject } from '../types/mdk';

const MAX_SCAN_DEPTH = 8;
const MAX_SCANNED_FILES = 25_000;
const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.svn',
  '.hg',
  'node_modules',
  'build',
  'out',
  'dist',
  'Debug',
  'Release',
]);

interface ScannedFile {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly name: string;
}

interface ParsedIoc {
  readonly mcu?: string;
  readonly family?: string;
}

interface InferredMcu {
  readonly mcu: string;
  readonly family?: string;
  readonly source: McuDetectionSource;
}

interface CmakePreset {
  readonly name?: string;
  readonly hidden?: boolean;
  readonly inherits?: string | readonly string[];
  readonly binaryDir?: string;
  readonly configurePreset?: string;
}

interface CmakePresetsFile {
  readonly configurePresets?: readonly CmakePreset[];
  readonly buildPresets?: readonly CmakePreset[];
}

interface ResolvedCmakeBuild {
  readonly buildDir: string;
  readonly configurePreset?: string;
  readonly buildPreset?: string;
}

export async function detectProject(
  workspacePath?: string,
): Promise<Stm32ProjectInfo> {
  if (workspacePath === undefined) {
    return emptyProject('no-workspace');
  }

  const resolvedWorkspace = path.resolve(workspacePath);
  const files = await scanWorkspace(resolvedWorkspace);
  const iocFiles = files.filter((file) =>
    file.name.toLowerCase().endsWith('.ioc'),
  );
  const cmakeFiles = files.filter(
    (file) => file.name.toLowerCase() === 'cmakelists.txt',
  );
  const mdkFiles = files.filter((file) =>
    file.name.toLowerCase().endsWith('.uvprojx') ||
    file.name.toLowerCase().endsWith('.uvproj'));
  const linkerFiles = files.filter((file) => isStm32LinkerScript(file.name));
  const startupFiles = files.filter((file) => isStm32StartupFile(file.name));

  const primaryIoc = iocFiles[0];
  const projectRoot = chooseProjectRoot(
    resolvedWorkspace,
    primaryIoc,
    cmakeFiles,
  );
  const hasCore = hasDirectorySegment(files, projectRoot, 'Core');
  const hasDrivers = hasDirectorySegment(files, projectRoot, 'Drivers');
  const cmakeFile = findCmakeForRoot(projectRoot, cmakeFiles);

  const evidence: string[] = [];
  if (primaryIoc !== undefined) {
    evidence.push('.ioc');
  }
  if (cmakeFile !== undefined) {
    evidence.push('CMakeLists.txt');
  }
  const discoveredMdk = preferredMdkProject(mdkFiles);
  const primaryMdk = cmakeFile === undefined ? discoveredMdk : undefined;
  if (primaryMdk !== undefined) {
    evidence.push(path.extname(primaryMdk.name).toLowerCase());
  }
  if (hasCore) {
    evidence.push('Core/');
  }
  if (hasDrivers) {
    evidence.push('Drivers/');
  }
  if (linkerFiles.length > 0) {
    evidence.push('STM32 linker script');
  }
  if (startupFiles.length > 0) {
    evidence.push('STM32 startup file');
  }

  const detected =
    primaryIoc !== undefined ||
    primaryMdk !== undefined ||
    linkerFiles.length > 0 ||
    startupFiles.length > 0 ||
    (hasCore && hasDrivers);

  if (!detected) {
    return {
      ...emptyProject('not-stm32'),
      workspacePath: resolvedWorkspace,
      evidence,
    };
  }

  const parsedIoc = await parsePrimaryIoc(primaryIoc);
  const parsedMdk = await parsePrimaryMdk(primaryMdk);
  const importMetadata = cmakeFile === undefined
    ? undefined
    : await readMdkImportMetadata(path.dirname(cmakeFile.absolutePath));
  const mdkTarget = parsedMdk?.targets[0];
  const inferred = inferMcu(linkerFiles, startupFiles);
  const importedDevice = typeof importMetadata?.device === 'string'
    ? normalizeMdkDevice(importMetadata.device)
    : undefined;
  const mcu = parsedIoc.mcu ?? normalizeMdkDevice(mdkTarget?.device) ?? importedDevice ?? inferred?.mcu;
  const family = parsedIoc.family ?? familyFromMcu(mcu) ?? inferred?.family;
  const actualProjectRoot = cmakeFile
    ? path.dirname(cmakeFile.absolutePath)
    : primaryMdk !== undefined
      ? resolvedMdkRoot(resolvedWorkspace, primaryMdk.absolutePath)
      : projectRoot;
  const cmakeBuild = cmakeFile
    ? await resolveCmakeBuild(actualProjectRoot)
    : undefined;

  return {
    detected: true,
    workspacePath: resolvedWorkspace,
    projectRoot: actualProjectRoot,
    projectName: mdkTarget?.name ?? (typeof importMetadata?.target === 'string'
      ? importMetadata.target
      : primaryIoc
      ? path.basename(primaryIoc.name, path.extname(primaryIoc.name))
      : path.basename(actualProjectRoot)),
    iocPath: primaryIoc?.absolutePath,
    mcu,
    family,
    mcuDetection: parsedIoc.mcu || mdkTarget?.device || importedDevice
      ? 'exact'
      : inferred ? 'inferred' : 'unknown',
    mcuSource: parsedIoc.mcu ? 'ioc' : inferred?.source,
    buildSystem: cmakeFile ? 'cmake' : primaryMdk ? 'mdk' : 'unknown',
    buildDir: cmakeBuild?.buildDir ?? (primaryMdk
      ? path.join(actualProjectRoot, '.dockyard32', 'mdk-output')
      : undefined),
    configurePreset: cmakeBuild?.configurePreset,
    buildPreset: cmakeBuild?.buildPreset,
    mdk: primaryMdk === undefined ? undefined : {
      projectFile: primaryMdk.absolutePath,
      targetName: mdkTarget?.name,
      device: mdkTarget?.device,
      outputDirectory: mdkTarget?.outputDirectory,
      outputName: mdkTarget?.outputName,
    },
    evidence,
  };
}

async function readMdkImportMetadata(
  projectRoot: string,
): Promise<Record<string, unknown> | undefined> {
  for (const metadataDirectory of ['.dockyard32', '.stm32-workbench']) {
    try {
      return JSON.parse(await fs.readFile(
        path.join(projectRoot, metadataDirectory, 'mdk-import.json'),
        'utf8',
      )) as Record<string, unknown>;
    } catch {
      // Try the current or legacy metadata directory.
    }
  }
  return undefined;
}

function preferredMdkProject(files: readonly ScannedFile[]): ScannedFile | undefined {
  return files
    .filter((file) => !path.basename(file.name).startsWith('._'))
    .sort((left, right) => {
      const leftMdk = /(?:^|[\\/])MDK-ARM(?:[\\/]|$)/iu.test(left.relativePath) ? 0 : 1;
      const rightMdk = /(?:^|[\\/])MDK-ARM(?:[\\/]|$)/iu.test(right.relativePath) ? 0 : 1;
      return leftMdk - rightMdk || left.relativePath.localeCompare(right.relativePath);
    })[0];
}

async function parsePrimaryMdk(
  file: ScannedFile | undefined,
): Promise<ParsedMdkProject | undefined> {
  if (file === undefined) {
    return undefined;
  }
  try {
    return await parseMdkProject(file.absolutePath);
  } catch {
    return undefined;
  }
}

function resolvedMdkRoot(workspace: string, projectFile: string): string {
  const projectDirectory = path.dirname(projectFile);
  const relative = path.relative(workspace, projectDirectory);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
    ? workspace
    : projectDirectory;
}

function normalizeMdkDevice(device: string | undefined): string | undefined {
  if (device === undefined) {
    return undefined;
  }
  const normalized = device.replace(/x+$/iu, '').toUpperCase();
  return normalized.startsWith('STM32') ? normalized : undefined;
}

async function resolveCmakeBuild(
  projectRoot: string,
): Promise<ResolvedCmakeBuild> {
  const fallback = path.join(projectRoot, 'build');
  let presets: CmakePresetsFile;
  try {
    presets = parseJsonc(
      await fs.readFile(path.join(projectRoot, 'CMakePresets.json'), 'utf8'),
    ) as CmakePresetsFile;
  } catch {
    return { buildDir: fallback };
  }

  const configurePresets = presets.configurePresets ?? [];
  const buildPreset = preferredPreset(presets.buildPresets ?? []);
  const configurePresetName = buildPreset?.configurePreset ??
    preferredPreset(configurePresets)?.name;
  if (configurePresetName === undefined) {
    return { buildDir: fallback };
  }

  const byName = new Map(
    configurePresets
      .filter((preset): preset is CmakePreset & { readonly name: string } =>
        typeof preset.name === 'string')
      .map((preset) => [preset.name, preset]),
  );
  const binaryDir = inheritedBinaryDir(
    configurePresetName,
    byName,
    new Set(),
  );
  if (binaryDir === undefined) {
    return { buildDir: fallback };
  }

  const expanded = binaryDir
    .replaceAll('${sourceDir}', projectRoot)
    .replaceAll('${sourceParentDir}', path.dirname(projectRoot))
    .replaceAll('${sourceDirName}', path.basename(projectRoot))
    .replaceAll('${presetName}', configurePresetName);
  return {
    buildDir: expanded.includes('${')
      ? fallback
      : path.resolve(projectRoot, expanded),
    configurePreset: configurePresetName,
    buildPreset: buildPreset?.name,
  };
}

function preferredPreset(
  presets: readonly CmakePreset[],
): CmakePreset | undefined {
  const visible = presets.filter((preset) => preset.hidden !== true);
  return visible.find((preset) => preset.name?.toLowerCase() === 'debug') ??
    visible[0];
}

function inheritedBinaryDir(
  presetName: string,
  presets: ReadonlyMap<string, CmakePreset>,
  visited: ReadonlySet<string>,
): string | undefined {
  if (visited.has(presetName)) {
    return undefined;
  }
  const preset = presets.get(presetName);
  if (preset === undefined) {
    return undefined;
  }
  if (preset.binaryDir !== undefined) {
    return preset.binaryDir;
  }
  const nextVisited = new Set(visited);
  nextVisited.add(presetName);
  const inherited = typeof preset.inherits === 'string'
    ? [preset.inherits]
    : preset.inherits ?? [];
  for (const parent of inherited) {
    const binaryDir = inheritedBinaryDir(parent, presets, nextVisited);
    if (binaryDir !== undefined) {
      return binaryDir;
    }
  }
  return undefined;
}

export async function parseIocFile(iocPath: string): Promise<ParsedIoc> {
  const content = await fs.readFile(iocPath, 'utf8');
  const values = new Map<string, string>();

  for (const line of content.split(/\r?\n/u)) {
    const separator = line.indexOf('=');
    if (separator <= 0) {
      continue;
    }

    const key = line.slice(0, separator).trim().toLowerCase();
    const value = stripWrappingQuotes(line.slice(separator + 1).trim());
    if (value.length > 0) {
      values.set(key, value);
    }
  }

  const preferredMcuKeys = [
    'mcu.cpn',
    'mcu.partnumber',
    'mcu.name',
    'projectmanager.deviceid',
  ];
  const preferredFamilyKeys = ['mcu.family', 'projectmanager.family'];

  const mcu =
    firstStm32Value(values, preferredMcuKeys) ??
    [...values.entries()].find(
      ([key, value]) => key.includes('mcu') && isStm32Value(value),
    )?.[1];
  const family =
    firstValue(values, preferredFamilyKeys)?.toUpperCase() ??
    familyFromMcu(mcu);

  return {
    mcu: mcu?.toUpperCase(),
    family,
  };
}

function emptyProject(
  reason: 'no-workspace' | 'not-stm32',
): Stm32ProjectInfo {
  return {
    detected: false,
    mcuDetection: 'unknown',
    buildSystem: 'unknown',
    evidence: [],
    reason,
  };
}

async function scanWorkspace(root: string): Promise<ScannedFile[]> {
  const files: ScannedFile[] = [];

  async function visit(directory: string, depth: number): Promise<void> {
    if (depth > MAX_SCAN_DEPTH || files.length >= MAX_SCANNED_FILES) {
      return;
    }

    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    await Promise.all(
      entries.map(async (entry) => {
        if (files.length >= MAX_SCANNED_FILES || entry.isSymbolicLink()) {
          return;
        }

        const absolutePath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!IGNORED_DIRECTORIES.has(entry.name)) {
            await visit(absolutePath, depth + 1);
          }
          return;
        }

        if (entry.isFile()) {
          files.push({
            absolutePath,
            relativePath: path.relative(root, absolutePath),
            name: entry.name,
          });
        }
      }),
    );
  }

  await visit(root, 0);
  files.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
  return files;
}

function chooseProjectRoot(
  workspacePath: string,
  iocFile: ScannedFile | undefined,
  cmakeFiles: readonly ScannedFile[],
): string {
  if (iocFile !== undefined) {
    const iocDirectory = path.dirname(iocFile.absolutePath);
    const containingCmake = cmakeFiles
      .map((file) => path.dirname(file.absolutePath))
      .filter((directory) => isInside(iocDirectory, directory))
      .sort((left, right) => right.length - left.length)[0];
    return containingCmake ?? iocDirectory;
  }

  return cmakeFiles[0]
    ? path.dirname(cmakeFiles[0].absolutePath)
    : workspacePath;
}

function findCmakeForRoot(
  projectRoot: string,
  cmakeFiles: readonly ScannedFile[],
): ScannedFile | undefined {
  return cmakeFiles.find(
    (file) => path.dirname(file.absolutePath) === projectRoot,
  );
}

function hasDirectorySegment(
  files: readonly ScannedFile[],
  projectRoot: string,
  segment: string,
): boolean {
  return files.some((file) => {
    if (!isInside(file.absolutePath, projectRoot)) {
      return false;
    }
    return path.relative(projectRoot, file.absolutePath).split(path.sep).includes(segment);
  });
}

async function parsePrimaryIoc(
  iocFile: ScannedFile | undefined,
): Promise<ParsedIoc> {
  if (iocFile === undefined) {
    return {};
  }

  try {
    return await parseIocFile(iocFile.absolutePath);
  } catch {
    return {};
  }
}

function inferMcu(
  linkerFiles: readonly ScannedFile[],
  startupFiles: readonly ScannedFile[],
): InferredMcu | undefined {
  for (const file of linkerFiles) {
    const series = extractStm32Series(file.name);
    if (series !== undefined) {
      return {
        mcu: series,
        family: familyFromMcu(series),
        source: 'linker-script',
      };
    }
  }

  for (const file of startupFiles) {
    const series = extractStm32Series(file.name);
    if (series !== undefined) {
      return {
        mcu: series,
        family: familyFromMcu(series),
        source: 'startup',
      };
    }
  }

  return undefined;
}

function extractStm32Series(fileName: string): string | undefined {
  const match = /stm32([a-z]\d{3}|[a-z]{2}\d{2}|[a-z]\d)/iu.exec(fileName);
  return match?.[1] ? `STM32${match[1].toUpperCase()}` : undefined;
}

function familyFromMcu(mcu?: string): string | undefined {
  if (mcu === undefined) {
    return undefined;
  }

  const suffix = /^STM32([A-Z]{1,2})(\d)/u.exec(mcu.toUpperCase());
  if (suffix?.[1] === undefined) {
    return undefined;
  }

  return suffix[1].length === 1
    ? `STM32${suffix[1]}${suffix[2] ?? ''}`
    : `STM32${suffix[1]}`;
}

function isStm32LinkerScript(fileName: string): boolean {
  return /^stm32.*\.ld$/iu.test(fileName);
}

function isStm32StartupFile(fileName: string): boolean {
  return /^startup_stm32.*\.(?:s|asm)$/iu.test(fileName);
}

function isInside(target: string, parent: string): boolean {
  const relative = path.relative(parent, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function firstStm32Value(
  values: ReadonlyMap<string, string>,
  keys: readonly string[],
): string | undefined {
  return keys.map((key) => values.get(key)).find(isStm32Value);
}

function firstValue(
  values: ReadonlyMap<string, string>,
  keys: readonly string[],
): string | undefined {
  return keys.map((key) => values.get(key)).find((value) => value !== undefined);
}

function isStm32Value(value: string | undefined): value is string {
  return value !== undefined && /^STM32[A-Z0-9(]/iu.test(value);
}

function stripWrappingQuotes(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1).trim();
  }
  return value;
}
