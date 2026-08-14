import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';

import { parseMdkProject } from './mdk';
import type {
  MdkImportOptions,
  MdkImportPreview,
  MdkImportPreviewOptions,
  MdkImportResult,
  MdkTargetInfo,
} from '../types/mdk';
import { gccArchitectureFlags, stm32DeviceProfile } from './stm32Device';
import {
  isInside,
  removeLocalMetadataFiles,
  reportPath,
  validateConversionDestination,
  validateProjectSourceRoot,
  validateSelectedInputDirectory,
} from './conversionSafety';

const SUPPORTED_SOURCES = new Set(['.c', '.cc', '.cpp', '.cxx', '.s', '.S']);
const COPYABLE_HEADERS = new Set(['.h', '.hh', '.hpp', '.hxx', '.inc', '.inl']);
const MAX_IMPORT_FILES = 30_000;
const MAX_IMPORT_BYTES = 512 * 1024 * 1024;
const MAX_PREVIEW_EXTERNAL_DIRECTORIES = 12;

interface ImportModel {
  readonly name: string;
  readonly sourceRoot: string;
  readonly destination: string;
  readonly target: MdkTargetInfo;
  readonly sources: readonly string[];
  readonly includes: readonly string[];
  readonly linkerFile: string;
  readonly startupFile: string;
  readonly absoluteSections: readonly AbsoluteSection[];
  readonly libraries: readonly string[];
}

interface CopyBudget {
  files: number;
  bytes: number;
}

interface ImportedInputs {
  readonly sources: string[];
  readonly dependencies: string[];
  readonly includes: string[];
  readonly libraries: string[];
  readonly scatterFile?: string;
}

interface ImportSelection {
  readonly sources: readonly string[];
  readonly dependencies: readonly string[];
  readonly includes: readonly string[];
  readonly libraries: readonly string[];
  readonly scatterFile?: string;
  readonly files: readonly string[];
  readonly totalBytes: number;
}

interface PreparedImport {
  readonly sourceProjectFile: string;
  readonly sourceRoot: string;
  readonly target: MdkTargetInfo;
  readonly selection: ImportSelection;
}

interface AbsoluteSection {
  readonly name: string;
  readonly address: number;
  readonly region: 'CCMRAM' | 'EXTRAM';
}

export async function previewMdkImport(
  projectFile: string,
  options: MdkImportPreviewOptions = {},
): Promise<MdkImportPreview> {
  try {
    const prepared = await prepareMdkImport(projectFile, options);
    const externalFiles = prepared.selection.files.filter(
      (file) => !isInside(file, prepared.sourceRoot),
    );
    const externalDirectories = unique(externalFiles.map((file) => path.dirname(file)));
    return {
      success: true,
      targetName: prepared.target.name,
      device: prepared.target.device,
      fileCount: prepared.selection.files.length,
      totalBytes: prepared.selection.totalBytes,
      externalFileCount: externalFiles.length,
      externalDirectories: externalDirectories.slice(0, MAX_PREVIEW_EXTERNAL_DIRECTORIES),
      externalDirectoryCount: externalDirectories.length,
    };
  } catch (error: unknown) {
    return {
      success: false,
      fileCount: 0,
      totalBytes: 0,
      externalFileCount: 0,
      externalDirectories: [],
      externalDirectoryCount: 0,
      error: errorMessage(error),
    };
  }
}

export async function importMdkProjectToCmake(
  projectFile: string,
  options: MdkImportOptions,
): Promise<MdkImportResult> {
  const warnings: string[] = [];
  const convertedFiles: string[] = [];
  const requestedProjectFile = path.resolve(projectFile);
  const destination = path.resolve(options.destinationDirectory);
  let prepared: PreparedImport;
  try {
    prepared = await prepareMdkImport(requestedProjectFile, options);
  } catch (error: unknown) {
    return importFailure(requestedProjectFile, warnings, errorMessage(error));
  }
  const { sourceProjectFile, sourceRoot, target } = prepared;
  const profile = stm32DeviceProfile(target.device);
  const destinationInsideSource = isInside(destination, sourceRoot);
  if (destinationInsideSource) {
    return importFailure(
      sourceProjectFile,
      warnings,
      'Choose an import destination outside the original Keil project',
    );
  }
  const destinationError = await validateConversionDestination(destination);
  if (destinationError !== undefined) {
    return importFailure(sourceProjectFile, warnings, destinationError);
  }

  let imported: ImportedInputs;
  try {
    imported = await copySelectedMdkInputs(
      sourceRoot,
      destination,
      prepared.selection,
    );
  } catch (error: unknown) {
    return importFailure(
      sourceProjectFile,
      warnings,
      `Unable to copy selected Keil inputs safely: ${errorMessage(error)}`,
    );
  }
  const importedSources = imported.sources;
  const importedIncludes = imported.includes;
  const armStartup = importedSources.find((item) =>
    /^startup_stm32.*\.s$/iu.test(path.basename(item)));
  if (armStartup === undefined) {
    return importFailure(
      sourceProjectFile,
      warnings,
      'No STM32 startup assembly file was found in the MDK target',
    );
  }
  const generatedDirectory = path.join(destination, 'cmake', 'generated');
  await fs.mkdir(generatedDirectory, { recursive: true });
  const gnuStartup = await findGnuStartup(path.basename(armStartup), sourceRoot, profile.device);
  if (gnuStartup === undefined) {
    return importFailure(
      sourceProjectFile,
      warnings,
      `GNU startup template not found for ${path.basename(armStartup)}; install the matching STM32Cube device pack`,
    );
  }
  const startupFile = path.join(
    generatedDirectory,
    path.basename(gnuStartup).replace(/\.s$/iu, '.S'),
  );
  await fs.copyFile(gnuStartup, startupFile);
  convertedFiles.push(path.relative(destination, startupFile));

  const cmsisCompatibilityFiles = await ensureGnuCmsisHeaders(importedIncludes);
  convertedFiles.push(...cmsisCompatibilityFiles.map((file) =>
    path.relative(destination, file)));

  const portableSources = importedSources.filter((item) => item !== armStartup);
  portableSources.push(startupFile);
  const proprietaryAssembly = await findProprietaryAssembly(portableSources);
  if (proprietaryAssembly.length > 0) {
    warnings.push(
      `ARM/Keil assembly syntax requires manual review: ${proprietaryAssembly.map((file) => reportPath(destination, file)).join(', ')}.`,
    );
  }
  const portableLibraries = imported.libraries.filter((library) => path.extname(library).toLowerCase() === '.a');
  const incompatibleLibraries = imported.libraries.filter((library) => path.extname(library).toLowerCase() === '.lib');
  if (incompatibleLibraries.length > 0) {
    warnings.push(
      `ARMCC .lib files were copied for reference but cannot be linked by GNU Arm: ${incompatibleLibraries.map((file) => path.basename(file)).join(', ')}.`,
    );
  }
  if (imported.scatterFile !== undefined) {
    warnings.push(
      `Custom Keil scatter file ${reportPath(destination, imported.scatterFile)} was retained for review; the generated GNU linker script is an approximation.`,
    );
  }
  const absoluteSections = await adaptCopiedSources(
    [...portableSources, ...imported.dependencies],
    destination,
    convertedFiles,
  );
  if (target.compiler === 'armcc5') {
    warnings.push(
      'The source project uses ARM Compiler 5. The imported project uses GNU Arm Embedded and may require manual changes for proprietary ARMCC syntax or libraries.',
    );
  }
  if (absoluteSections.length > 0) {
    warnings.push(
      `Mapped ${absoluteSections.length} absolute ARM/Keil RAM section(s) to GNU linker regions.`,
    );
  }

  const linkerFile = path.join(generatedDirectory, `${safeName(target.name)}.ld`);
  const model: ImportModel = {
    name: safeName(target.name),
    sourceRoot,
    destination,
    target,
    sources: portableSources,
    includes: importedIncludes,
    linkerFile,
    startupFile,
    absoluteSections,
    libraries: portableLibraries,
  };
  await Promise.all([
    fs.writeFile(linkerFile, createLinkerScript(model), 'utf8'),
    fs.writeFile(path.join(destination, 'CMakeLists.txt'), createCmakeLists(model), 'utf8'),
    fs.writeFile(path.join(destination, 'CMakePresets.json'), createPresets(), 'utf8'),
  ]);
  convertedFiles.push(
    path.relative(destination, linkerFile),
    'CMakeLists.txt',
    'CMakePresets.json',
  );
  const report = {
    formatVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceProjectFile: reportPath(sourceRoot, sourceProjectFile),
    sourceCompiler: target.compiler,
    target: target.name,
    device: profile.device,
    mcu: profile.device,
    projectDirectory: '.',
    sources: portableSources.length,
    includePaths: importedIncludes.length,
    convertedFiles,
    scatterFile: reportPath(destination, imported.scatterFile),
    libraries: imported.libraries.map((file) => reportPath(destination, file) ?? path.basename(file)),
    warnings,
  };
  await fs.mkdir(path.join(destination, '.dockyard32'), { recursive: true });
  await fs.writeFile(
    path.join(destination, '.dockyard32', 'mdk-import.json'),
    `${JSON.stringify(report, undefined, 2)}\n`,
    'utf8',
  );
  await removeLocalMetadataFiles(destination);
  const copiedFiles = await countFiles(destination);
  return {
    success: true,
    projectDirectory: destination,
    cmakeFile: path.join(destination, 'CMakeLists.txt'),
    sourceProjectFile,
    copiedFiles,
    convertedFiles,
    warnings,
  };
}

async function prepareMdkImport(
  projectFile: string,
  options: MdkImportPreviewOptions,
): Promise<PreparedImport> {
  const sourceProjectFile = await fs.realpath(path.resolve(projectFile));
  const parsed = await parseMdkProject(sourceProjectFile);
  if (options.targetName === undefined && parsed.targets.length > 1) {
    throw new Error('Multiple MDK targets were found; select a target before importing');
  }
  const selectedTarget = options.targetName === undefined
    ? parsed.targets[0]
    : parsed.targets.find((candidate) => candidate.name === options.targetName);
  if (selectedTarget === undefined) {
    throw new Error('The selected MDK target was not found');
  }
  let profile;
  try {
    profile = stm32DeviceProfile(options.device ?? selectedTarget.device);
  } catch (error: unknown) {
    throw new Error(
      `${errorMessage(error)}. Select the exact MCU before importing`,
    );
  }
  const target: MdkTargetInfo = { ...selectedTarget, device: profile.device };
  // A caller may explicitly approve a wider workspace root. Without that
  // approval, the MDK project directory is the only trusted project root.
  const sourceRoot = await fs.realpath(path.resolve(
    options.sourceRoot ?? path.dirname(sourceProjectFile),
  ));
  const sourceError = validateProjectSourceRoot(sourceRoot, sourceProjectFile);
  if (sourceError !== undefined) {
    throw new Error(sourceError);
  }
  const projectDirectory = path.dirname(sourceProjectFile);
  const sources = target.sources
    .map((item) => resolveMdkPath(projectDirectory, item))
    .filter((item) => SUPPORTED_SOURCES.has(path.extname(item)));
  const includes = target.includePaths.map((item) =>
    resolveMdkPath(projectDirectory, item));
  const libraries = target.libraries.map((item) =>
    resolveMdkPath(projectDirectory, item));
  const scatterFile = target.scatterFile === undefined
    ? undefined
    : resolveMdkPath(projectDirectory, target.scatterFile);
  const selection = await selectMdkInputs(
    sources,
    includes,
    libraries,
    scatterFile,
  );
  return { sourceProjectFile, sourceRoot, target, selection };
}

async function selectMdkInputs(
  sources: readonly string[],
  includes: readonly string[],
  libraries: readonly string[],
  scatterFile: string | undefined,
): Promise<ImportSelection> {
  const selectedIncludes: string[] = [];
  for (const includePath of unique(includes.map((candidate) => path.resolve(candidate)))) {
    let include: string;
    try {
      include = await fs.realpath(includePath);
    } catch {
      continue;
    }
    if (!await isDirectory(include)) {
      continue;
    }
    const scopeError = validateSelectedInputDirectory(include);
    if (scopeError !== undefined) {
      throw new Error(scopeError);
    }
    selectedIncludes.push(include);
  }
  const selectedSources = unique(await Promise.all(
    sources.map((candidate) => fs.realpath(path.resolve(candidate))),
  ));
  const sourceSet = new Set(selectedSources);
  const dependencies = new Set<string>();
  const visited = new Set<string>();
  const pending = [...selectedSources];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || visited.has(current)) {
      continue;
    }
    visited.add(current);
    let content: string;
    try {
      content = await fs.readFile(current, 'utf8');
    } catch {
      continue;
    }
    for (const match of content.matchAll(/^\s*#\s*include\s*[<"]([^>"]+)[>"]/gmu)) {
      const requested = match[1];
      if (requested === undefined || !isImportDependency(requested)) {
        continue;
      }
      const resolved = await resolveQuotedInclude(
        requested,
        path.dirname(current),
        selectedIncludes,
      );
      if (resolved === undefined || sourceSet.has(resolved) || dependencies.has(resolved)) {
        continue;
      }
      dependencies.add(resolved);
      pending.push(resolved);
    }
  }
  const selectedLibraries = unique(await Promise.all(
    libraries.map((candidate) => fs.realpath(path.resolve(candidate))),
  ));
  const selectedScatter = scatterFile !== undefined && await isFile(scatterFile)
    ? await fs.realpath(path.resolve(scatterFile))
    : undefined;
  const files = unique([
    ...selectedSources,
    ...dependencies,
    ...selectedLibraries,
    ...(selectedScatter === undefined ? [] : [selectedScatter]),
  ]);
  let totalBytes = 0;
  for (const file of files) {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Refusing non-regular input file: ${path.basename(file)}`);
    }
    totalBytes += stat.size;
  }
  if (files.length > MAX_IMPORT_FILES || totalBytes > MAX_IMPORT_BYTES) {
    throw new Error('Selected Keil inputs exceed the safe import limit');
  }
  return {
    sources: selectedSources,
    dependencies: [...dependencies],
    includes: selectedIncludes,
    libraries: selectedLibraries,
    scatterFile: selectedScatter,
    files,
    totalBytes,
  };
}

function isImportDependency(candidate: string): boolean {
  const extension = path.extname(candidate);
  return COPYABLE_HEADERS.has(extension.toLowerCase()) ||
    SUPPORTED_SOURCES.has(extension) ||
    SUPPORTED_SOURCES.has(extension.toLowerCase());
}

async function copySelectedMdkInputs(
  sourceRoot: string,
  destination: string,
  selection: ImportSelection,
): Promise<ImportedInputs> {
  const budget: CopyBudget = { files: 0, bytes: 0 };
  await fs.mkdir(destination, { recursive: true });
  const includeMappings = new Map<string, string>();
  for (const include of selection.includes) {
    const mapped = importedPath(sourceRoot, destination, include, true);
    await fs.mkdir(mapped, { recursive: true });
    includeMappings.set(include, mapped);
  }

  const mappingRoots = new Map<string, string>([
    [sourceRoot, destination],
    ...includeMappings,
  ]);
  for (const file of [...selection.sources, ...selection.dependencies]) {
    if (![...mappingRoots.keys()].some((root) => isInside(file, root))) {
      const directory = path.dirname(file);
      mappingRoots.set(
        directory,
        importedPath(sourceRoot, destination, directory, true),
      );
    }
  }
  const mapInput = (file: string): string => {
    const owner = [...mappingRoots.keys()]
      .filter((root) => isInside(file, root))
      .sort((left, right) => right.length - left.length)[0];
    return owner === undefined
      ? importedPath(sourceRoot, destination, file, false)
      : path.join(mappingRoots.get(owner) as string, path.relative(owner, file));
  };
  const importedSources: string[] = [];
  for (const source of selection.sources) {
    const mapped = mapInput(source);
    await copySelectedFile(source, mapped, budget);
    importedSources.push(mapped);
  }
  const importedDependencies: string[] = [];
  for (const dependency of selection.dependencies) {
    const mapped = mapInput(dependency);
    await copySelectedFile(dependency, mapped, budget);
    importedDependencies.push(mapped);
  }

  const importedLibraries: string[] = [];
  for (const library of selection.libraries) {
    const mapped = path.join(
      destination,
      'Libraries',
      `${shortHash(library)}-${path.basename(library)}`,
    );
    await copySelectedFile(library, mapped, budget);
    importedLibraries.push(mapped);
  }

  let importedScatter: string | undefined;
  if (selection.scatterFile !== undefined) {
    importedScatter = path.join(
      destination,
      'cmake',
      'original',
      path.basename(selection.scatterFile),
    );
    await copySelectedFile(selection.scatterFile, importedScatter, budget);
  }
  return {
    sources: importedSources,
    dependencies: importedDependencies,
    includes: [...includeMappings.values()],
    libraries: importedLibraries,
    scatterFile: importedScatter,
  };
}

async function resolveQuotedInclude(
  requested: string,
  sourceDirectory: string,
  includeDirectories: readonly string[],
): Promise<string | undefined> {
  for (const base of [sourceDirectory, ...includeDirectories]) {
    const candidate = path.resolve(base, requested.replaceAll('\\', path.sep));
    if (await isFile(candidate)) {
      return fs.realpath(candidate);
    }
  }
  return undefined;
}

async function copySelectedFile(
  source: string,
  destination: string,
  budget: CopyBudget,
): Promise<void> {
  const stat = await fs.lstat(source);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Refusing non-regular input file: ${path.basename(source)}`);
  }
  budget.files += 1;
  budget.bytes += stat.size;
  if (budget.files > MAX_IMPORT_FILES || budget.bytes > MAX_IMPORT_BYTES) {
    throw new Error('Selected Keil inputs exceed the safe import limit');
  }
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
}

function importedPath(
  sourceRoot: string,
  destination: string,
  candidate: string,
  directory: boolean,
): string {
  const relative = path.relative(sourceRoot, candidate);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return path.join(destination, relative || (directory ? 'Project' : path.basename(candidate)));
  }
  return path.join(
    destination,
    'External',
    `${shortHash(candidate)}-${path.basename(candidate)}`,
  );
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function resolveMdkPath(projectDirectory: string, value: string): string {
  return path.resolve(projectDirectory, value.replaceAll('\\', path.sep));
}

async function findProprietaryAssembly(sources: readonly string[]): Promise<string[]> {
  const result: string[] = [];
  for (const source of sources.filter((file) => /\.(?:s|asm)$/iu.test(file))) {
    let content: string;
    try {
      content = await fs.readFile(source, 'utf8');
    } catch {
      continue;
    }
    if (/^\s*(?:AREA|EXPORT|IMPORT|PRESERVE8|PROC|ENDP|THUMB)\b/imu.test(content)) {
      result.push(source);
    }
  }
  return result;
}

async function findGnuStartup(
  armStartupName: string,
  sourceRoot: string,
  device?: string,
): Promise<string | undefined> {
  const wanted = startupNameCandidates(armStartupName, device);
  const roots = [
    sourceRoot,
    path.join(os.homedir(), 'Library', 'Application Support', 'stm32cube', 'packs'),
    path.join(os.homedir(), 'STM32Cube', 'Repository'),
    '/Applications/STMicroelectronics',
    '/Applications/STM32CubeCLT',
  ];
  for (const root of roots) {
    const found = await findFile(root, (candidate) =>
      wanted.has(path.basename(candidate).toLowerCase().replace(/\.s$/u, '')) &&
      path.extname(candidate) === '.S');
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

function startupNameCandidates(armStartupName: string, device?: string): Set<string> {
  const result = new Set([armStartupName.toLowerCase().replace(/\.s$/u, '')]);
  const normalized = device?.toLowerCase().replace(/x+$/u, '');
  const f1 = normalized === undefined ? undefined : /^stm32f1(\d{2})([a-z])([0-9a-z])/u.exec(normalized);
  if (f1 === null || f1 === undefined) {
    return result;
  }
  const model = f1[1];
  const capacity = f1[3];
  const suffix = model === '05' || model === '07'
    ? 'xc'
    : capacity === '4' || capacity === '6'
      ? 'x6'
      : capacity === '8' || capacity === 'b'
        ? 'xb'
        : capacity === 'f' || capacity === 'g' ? 'xg' : 'xe';
  result.add(`startup_stm32f1${model}${suffix}`);
  const legacy = /_vl_/u.test(armStartupName.toLowerCase())
    ? capacity === '4' || capacity === '6' ? 'vl_ld' : capacity === '8' || capacity === 'b' ? 'vl_md' : 'vl_hd'
    : model === '05' || model === '07'
      ? 'cl'
      : capacity === '4' || capacity === '6' ? 'ld' : capacity === '8' || capacity === 'b' ? 'md' : capacity === 'f' || capacity === 'g' ? 'xl' : 'hd';
  result.add(`startup_stm32f10x_${legacy}`);
  return result;
}

async function ensureGnuCmsisHeaders(
  includeDirectories: readonly string[],
): Promise<string[]> {
  let cmsisInclude: string | undefined;
  for (const directory of includeDirectories) {
    if (await isFile(path.join(directory, 'cmsis_compiler.h'))) {
      cmsisInclude = directory;
      break;
    }
  }
  if (cmsisInclude === undefined || await isFile(path.join(cmsisInclude, 'cmsis_gcc.h'))) {
    return [];
  }
  const roots = [
    path.join(os.homedir(), 'Library', 'Application Support', 'stm32cube', 'packs'),
    '/Applications/STMicroelectronics',
    '/Applications/STM32CubeCLT',
  ];
  for (const root of roots) {
    const source = await findFile(root, (candidate) =>
      path.basename(candidate).toLowerCase() === 'cmsis_gcc.h');
    if (source !== undefined) {
      const destination = path.join(cmsisInclude, 'cmsis_gcc.h');
      await fs.copyFile(source, destination);
      const copied = [destination];
      const profileSource = path.join(path.dirname(source), 'm-profile');
      if (await isDirectory(profileSource)) {
        const profileDestination = path.join(cmsisInclude, 'm-profile');
        await fs.cp(profileSource, profileDestination, { recursive: true });
        copied.push(profileDestination);
      }
      return copied;
    }
  }
  return [];
}

async function findFile(
  root: string,
  predicate: (candidate: string) => boolean,
): Promise<string | undefined> {
  let visited = 0;
  async function visit(directory: string, depth: number): Promise<string | undefined> {
    if (depth > 10 || visited > 40_000) {
      return undefined;
    }
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const entry of entries) {
      visited += 1;
      const candidate = path.join(directory, entry.name);
      if (entry.isFile() && predicate(candidate)) {
        return candidate;
      }
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        const found = await visit(candidate, depth + 1);
        if (found !== undefined) {
          return found;
        }
      }
    }
    return undefined;
  }
  return visit(root, 0);
}

async function adaptCopiedSources(
  sources: readonly string[],
  destination: string,
  convertedFiles: string[],
): Promise<AbsoluteSection[]> {
  const sections = new Map<string, AbsoluteSection>();
  const headers = await collectFiles(destination, (candidate) =>
    path.extname(candidate).toLowerCase() === '.h');
  for (const source of [...new Set([...sources, ...headers])]) {
    if (!/\.(?:c|cc|cpp|cxx|h)$/iu.test(source)) {
      continue;
    }
    let content: string;
    try {
      content = await fs.readFile(source, 'utf8');
    } catch {
      continue;
    }
    const original = content;
    content = content.replace(
      /#if\s*!\s*\(__ARMCC_VERSION\s*>=\s*6010050\)/gu,
      '#if defined(__CC_ARM) && !(__ARMCC_VERSION >= 6010050)',
    );
    content = content.replace(
      /#ifndef\s+uint32_t\s+typedef\s+unsigned\s+char\s+uint8_t;\s+typedef\s+unsigned\s+short\s+(?:int\s+)?uint16_t;\s+typedef\s+unsigned\s+(?:int\s+)?uint32_t;\s+#endif/gu,
      '#include <stdint.h>',
    );
    for (const match of content.matchAll(/section\("(\.bss\.ARM\.__at_(0x[0-9a-f]+))"\)/giu)) {
      const name = match[1];
      const addressText = match[2];
      if (name === undefined || addressText === undefined) {
        continue;
      }
      const address = Number.parseInt(addressText, 16);
      sections.set(name, {
        name,
        address,
        region: address >= 0x60000000 ? 'EXTRAM' : 'CCMRAM',
      });
    }
    if (content !== original) {
      await fs.writeFile(source, content, 'utf8');
      convertedFiles.push(path.relative(destination, source));
    }
  }
  return [...sections.values()].sort((left, right) => left.address - right.address);
}

async function collectFiles(
  root: string,
  predicate: (candidate: string) => boolean,
): Promise<string[]> {
  const result: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(candidate);
      } else if (entry.isFile() && predicate(candidate)) {
        result.push(candidate);
      }
    }
  }
  await visit(root);
  return result;
}

function createCmakeLists(model: ImportModel): string {
  const sources = model.sources.map((item) => cmakePath(model.destination, item));
  const includes = model.includes.map((item) => cmakePath(model.destination, item));
  const defines = model.target.defines;
  const libraries = model.libraries.map((item) => cmakePath(model.destination, item));
  const architectureFlags = gccArchitectureFlags(stm32DeviceProfile(model.target.device)).join(' ');
  return `cmake_minimum_required(VERSION 3.20)\n` +
    `set(CMAKE_SYSTEM_NAME Generic)\n` +
    `set(CMAKE_SYSTEM_PROCESSOR arm)\n` +
    `set(CMAKE_TRY_COMPILE_TARGET_TYPE STATIC_LIBRARY)\n` +
    `set(CMAKE_EXPORT_COMPILE_COMMANDS ON)\n` +
    `find_program(CMAKE_C_COMPILER arm-none-eabi-gcc REQUIRED)\n` +
    `find_program(CMAKE_ASM_COMPILER arm-none-eabi-gcc REQUIRED)\n` +
    `find_program(CMAKE_OBJCOPY arm-none-eabi-objcopy REQUIRED)\n` +
    `find_program(CMAKE_SIZE arm-none-eabi-size REQUIRED)\n` +
    `project(${model.name} C ASM)\n` +
    `add_executable(\${PROJECT_NAME}\n${indent(sources)}\n)\n` +
    `target_include_directories(\${PROJECT_NAME} PRIVATE\n${indent(includes)}\n)\n` +
    `target_compile_definitions(\${PROJECT_NAME} PRIVATE\n${indent(defines)}\n)\n` +
    `target_compile_options(\${PROJECT_NAME} PRIVATE\n` +
    `  ${architectureFlags}\n` +
    `  -ffunction-sections -fdata-sections -fshort-enums\n` +
    `  $<$<COMPILE_LANGUAGE:C>:-Wno-error=incompatible-pointer-types>\n` +
    `  $<$<COMPILE_LANGUAGE:C>:-std=gnu11>\n` +
    `)\n` +
    `target_link_options(\${PROJECT_NAME} PRIVATE\n` +
    `  ${architectureFlags}\n` +
    `  -T\${CMAKE_CURRENT_SOURCE_DIR}/${cmakePath(model.destination, model.linkerFile)}\n` +
    `  -Wl,--gc-sections,-Map=\${CMAKE_CURRENT_BINARY_DIR}/\${PROJECT_NAME}.map\n` +
    `  --specs=nano.specs --specs=nosys.specs\n` +
    `)\n` +
    `target_link_libraries(\${PROJECT_NAME} PRIVATE${libraries.length === 0 ? '' : `\n${indent(libraries)}`}\n  m c gcc\n)\n` +
    `set_target_properties(\${PROJECT_NAME} PROPERTIES SUFFIX ".elf")\n` +
    `add_custom_command(TARGET \${PROJECT_NAME} POST_BUILD\n` +
    `  COMMAND \${CMAKE_OBJCOPY} -O ihex $<TARGET_FILE:\${PROJECT_NAME}> \${CMAKE_CURRENT_BINARY_DIR}/\${PROJECT_NAME}.hex\n` +
    `  COMMAND \${CMAKE_OBJCOPY} -O binary $<TARGET_FILE:\${PROJECT_NAME}> \${CMAKE_CURRENT_BINARY_DIR}/\${PROJECT_NAME}.bin\n` +
    `  COMMAND \${CMAKE_SIZE} $<TARGET_FILE:\${PROJECT_NAME}>\n` +
    `)\n`;
}

function createLinkerScript(model: ImportModel): string {
  const profile = stm32DeviceProfile(model.target.device);
  const flash = model.target.flash ?? { origin: '0x08000000', length: bytesToHex(profile.defaultFlashBytes) };
  const ram = model.target.ram ?? { origin: '0x20000000', length: bytesToHex(profile.defaultRamBytes) };
  const ccm = model.target.ccmRam ?? (profile.defaultCcmRamBytes === 0
    ? undefined
    : { origin: '0x10000000', length: bytesToHex(profile.defaultCcmRamBytes) });
  const ccmSections = absoluteSections(model.absoluteSections, 'CCMRAM');
  const externalSections = absoluteSections(model.absoluteSections, 'EXTRAM');
  const needsExternalRam = externalSections.length > 0;
  return `/* Generated by Dockyard32 from ${path.basename(model.target.name)}. */\n` +
    `ENTRY(Reset_Handler)\n` +
    `MEMORY {\n` +
    `  FLASH (rx)  : ORIGIN = ${flash.origin}, LENGTH = ${flash.length}\n` +
    `  RAM (xrw)   : ORIGIN = ${ram.origin}, LENGTH = ${ram.length}\n` +
    (ccm === undefined ? '' : `  CCMRAM (xrw): ORIGIN = ${ccm.origin}, LENGTH = ${ccm.length}\n`) +
    (needsExternalRam ? `  EXTRAM (xrw): ORIGIN = 0x68000000, LENGTH = 0x00100000\n` : '') +
    `}\n` +
    `_estack = ORIGIN(RAM) + LENGTH(RAM);\n_Min_Heap_Size = 0x200;\n_Min_Stack_Size = 0x800;\n` +
    `SECTIONS {\n` +
    `  .isr_vector : { . = ALIGN(4); KEEP(*(.isr_vector)) . = ALIGN(4); } > FLASH\n` +
    `  .text : { . = ALIGN(4); *(.text*) *(.glue_7*) *(.eh_frame*) KEEP(*(.init)) KEEP(*(.fini)) . = ALIGN(4); _etext = .; } > FLASH\n` +
    `  .rodata : { . = ALIGN(4); *(.rodata*) . = ALIGN(4); } > FLASH\n` +
    `  .ARM.extab : { *(.ARM.extab* .gnu.linkonce.armextab.*) } > FLASH\n` +
    `  .ARM : { __exidx_start = .; *(.ARM.exidx*) __exidx_end = .; } > FLASH\n` +
    `  .preinit_array : { PROVIDE_HIDDEN(__preinit_array_start = .); KEEP(*(.preinit_array*)) PROVIDE_HIDDEN(__preinit_array_end = .); } > FLASH\n` +
    `  .init_array : { PROVIDE_HIDDEN(__init_array_start = .); KEEP(*(SORT(.init_array.*))) KEEP(*(.init_array*)) PROVIDE_HIDDEN(__init_array_end = .); } > FLASH\n` +
    `  .fini_array : { PROVIDE_HIDDEN(__fini_array_start = .); KEEP(*(SORT(.fini_array.*))) KEEP(*(.fini_array*)) PROVIDE_HIDDEN(__fini_array_end = .); } > FLASH\n` +
    `  _sidata = LOADADDR(.data);\n` +
    `  .data : { . = ALIGN(4); _sdata = .; *(.data*) *(.RamFunc*) . = ALIGN(4); _edata = .; } > RAM AT> FLASH\n` +
    ccmSections + externalSections +
    `  .bss (NOLOAD) : { . = ALIGN(4); _sbss = .; __bss_start__ = _sbss; *(.bss*) *(COMMON) . = ALIGN(4); _ebss = .; __bss_end__ = _ebss; } > RAM\n` +
    `  ._user_heap_stack (NOLOAD) : { . = ALIGN(8); PROVIDE(end = .); PROVIDE(_end = .); . += _Min_Heap_Size; . += _Min_Stack_Size; . = ALIGN(8); } > RAM\n` +
    `  .ARM.attributes 0 : { *(.ARM.attributes) }\n` +
    `}\n`;
}

function absoluteSections(
  sections: readonly AbsoluteSection[],
  region: AbsoluteSection['region'],
): string {
  return sections
    .filter((section) => section.region === region)
    .map((section) => {
      const outputName = section.name.replace(/[^A-Za-z0-9_]/gu, '_');
      return `  .${outputName} 0x${section.address.toString(16).toUpperCase()} (NOLOAD) : { KEEP(*(${section.name})) } > ${region}\n`;
    })
    .join('');
}

function createPresets(): string {
  return `${JSON.stringify({
    version: 3,
    configurePresets: [{
      name: 'Debug',
      displayName: 'Dockyard32 Debug',
      generator: 'Ninja',
      binaryDir: '${sourceDir}/build',
      cacheVariables: { CMAKE_BUILD_TYPE: 'Debug' },
    }],
    buildPresets: [{ name: 'Debug', configurePreset: 'Debug' }],
  }, undefined, 2)}\n`;
}

function cmakePath(root: string, candidate: string): string {
  return path.relative(root, candidate).split(path.sep).join('/');
}

function indent(values: readonly string[]): string {
  return values.map((value) => `  "${value.replaceAll('"', '\\"')}"`).join('\n');
}

async function countFiles(root: string): Promise<number> {
  let count = 0;
  async function visit(directory: string): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await visit(path.join(directory, entry.name));
      } else if (entry.isFile()) {
        count += 1;
      }
    }
  }
  await visit(root);
  return count;
}

async function isFile(candidate: string): Promise<boolean> {
  try {
    return (await fs.stat(candidate)).isFile();
  } catch {
    return false;
  }
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await fs.stat(candidate)).isDirectory();
  } catch {
    return false;
  }
}

function safeName(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_]+/gu, '_').replace(/^_+|_+$/gu, '');
  return cleaned.length > 0 ? cleaned : 'STM32_Project';
}

function bytesToHex(value: number): string {
  return `0x${value.toString(16).toUpperCase().padStart(8, '0')}`;
}

function importFailure(
  sourceProjectFile: string,
  warnings: readonly string[],
  error: string,
): MdkImportResult {
  return {
    success: false,
    sourceProjectFile,
    copiedFiles: 0,
    convertedFiles: [],
    warnings,
    error,
  };
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
