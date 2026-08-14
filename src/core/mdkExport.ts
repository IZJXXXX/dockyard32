import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import * as path from 'node:path';

import type { MdkExportOptions, MdkExportResult } from '../types/mdk';
import type { Stm32ProjectInfo } from '../types/project';
import {
  keilArchitectureFlags,
  normalizeStm32Device,
  stm32Family,
  stm32DeviceProfile,
  type Stm32DeviceProfile,
} from './stm32Device';
import {
  removeLocalMetadataFiles,
  reportPath,
  validateConversionDestination,
} from './conversionSafety';

interface CompileCommand {
  readonly directory: string;
  readonly command?: string;
  readonly arguments?: readonly string[];
  readonly file: string;
}

interface CompileOptions {
  readonly includes: readonly string[];
  readonly defines: readonly string[];
  readonly miscControls: readonly string[];
}

interface ParsedCompileCommand extends CompileOptions {
  readonly source: string;
}

interface MemoryRegion {
  readonly name: string;
  readonly origin: string;
  readonly length: string;
}

interface LinkerModel {
  readonly script?: string;
  readonly entry: string;
  readonly regions: readonly MemoryRegion[];
  readonly flash: MemoryRegion;
  readonly ram: MemoryRegion;
  readonly heapSize: string;
  readonly stackSize: string;
  readonly sections: ReadonlyMap<string, readonly string[]>;
}

interface ExportModel {
  readonly name: string;
  readonly device: string;
  readonly root: string;
  readonly exportDirectory: string;
  readonly outputDirectory: string;
  readonly sources: readonly string[];
  readonly includes: readonly string[];
  readonly defines: readonly string[];
  readonly miscControls: readonly string[];
  readonly scatterFile: string;
  readonly linker: LinkerModel;
  readonly profile: Stm32DeviceProfile;
  readonly startup?: string;
  readonly startupSection: 'RESET' | '.isr_vector';
  readonly sourceOptions: ReadonlyMap<string, CompileOptions>;
  readonly libraries: readonly string[];
  readonly useMicroLib: boolean;
}

export async function exportCmakeProjectToMdk(
  project: Stm32ProjectInfo,
  options: MdkExportOptions = {},
): Promise<MdkExportResult> {
  const warnings: string[] = [];
  if (project.buildSystem !== 'cmake' || project.projectRoot === undefined) {
    return { success: false, warnings, error: 'A detected CMake project is required' };
  }
  const root = project.projectRoot;
  const compileCommandsPath = await findCompileCommands(project);
  if (compileCommandsPath === undefined) {
    return {
      success: false,
      warnings,
      error: 'compile_commands.json not found; configure the CMake project before exporting',
    };
  }
  let commands: readonly CompileCommand[];
  try {
    commands = JSON.parse(await fs.readFile(compileCommandsPath, 'utf8')) as readonly CompileCommand[];
  } catch (error: unknown) {
    return { success: false, warnings, error: `Unable to read compile_commands.json: ${errorMessage(error)}` };
  }
  const parsedCommands = commands.map((entry) =>
    parseCompileCommand(entry, path.dirname(compileCommandsPath)));
  const compileSources = unique(parsedCommands.map((entry) => entry.source))
    .filter((file) => isSupportedSource(file));
  const completedSources = await completeKnownHalDependencies(compileSources);
  const allSources = completedSources.sources;
  if (completedSources.added.length > 0) {
    warnings.push(`Added required STM32 HAL dependencies: ${completedSources.added.map((file) => path.basename(file)).join(', ')}.`);
  }
  const excludedGnuRuntime = allSources.filter(isGnuRuntimeStub);
  const sources = allSources.filter((file) => !isGnuRuntimeStub(file));
  if (sources.length === 0) {
    return { success: false, warnings, error: 'No C, C++, or assembly sources found in compile_commands.json' };
  }
  const compileOptionsBySource = new Map(parsedCommands.map((entry) => [entry.source, entry]));
  const sourceIncludes = unique(parsedCommands.flatMap((entry) => entry.includes));
  const commonIncludes = commonValues(parsedCommands.map((entry) => entry.includes));
  const defines = commonValues(parsedCommands.map((entry) => entry.defines));
  const commonMiscControls = commonValues(parsedCommands.map((entry) => entry.miscControls));
  const device = await resolveDevice(root, options.device ?? project.mcu);
  if (device === undefined || stm32Family(device) === undefined) {
    return {
      success: false,
      warnings,
      error: 'STM32 MCU could not be identified; select the exact F1, F4, or G4 device before exporting',
    };
  }
  const profile = stm32DeviceProfile(device);
  const linkerScript = await findLinkerScript(root, project.buildDir);
  const linker = linkerScript === undefined
    ? defaultLinkerModel(profile)
    : parseLinkerScript(linkerScript, await fs.readFile(linkerScript, 'utf8'), profile);
  if (linkerScript === undefined) {
    warnings.push(`GNU linker script not found; conservative ${profile.family} memory defaults were used for ${device}.`);
  }
  const flags = commands.flatMap(commandArguments);
  if (flags.some((flag) => flag.includes('--specs=') || flag.includes('-Wl,'))) {
    warnings.push('GNU linker-only flags are not copied; the generated Keil scatter file controls placement.');
  }
  if (excludedGnuRuntime.length > 0) {
    warnings.push(`Excluded GNU newlib runtime stubs: ${excludedGnuRuntime.map((file) => path.basename(file)).join(', ')}.`);
  }
  const linkedLibraries = await findLinkedLibraries(root, project.buildDir);
  if (linkedLibraries.length > 0) {
    warnings.push(
      `Copied ${linkedLibraries.length} precompiled librar${linkedLibraries.length === 1 ? 'y' : 'ies'}; verify ARM EABI and ARMClang compatibility on Windows.`,
    );
  }

  const exportDirectory = path.resolve(
    options.destinationDirectory ?? path.join(root, 'MDK-ARM'),
  );
  const destinationError = await validateConversionDestination(
    exportDirectory,
  );
  if (destinationError !== undefined) {
    return { success: false, warnings, error: destinationError };
  }
  const generatedDirectory = path.join(exportDirectory, 'Generated');
  await fs.mkdir(generatedDirectory, { recursive: true });
  const name = safeTargetName(project.projectName ?? path.basename(root));
  const scatterFile = path.join(generatedDirectory, `${name}.sct`);
  const startup = sources.find((file) => /^startup_stm32.*\.(?:s|S|asm)$/u.test(path.basename(file)));
  let exportedSources = [...sources];
  let generatedStartup: string | undefined;
  let startupSection: 'RESET' | '.isr_vector' = '.isr_vector';
  if (startup !== undefined) {
    const armStartup = await findArmStartupTemplate(root, startup);
    generatedStartup = path.join(generatedDirectory, path.basename(startup).replace(/\.(?:s|S|asm)$/u, '_ac6.s'));
    if (armStartup !== undefined) {
      startupSection = 'RESET';
      const adapted = adaptArmStartupMemory(await fs.readFile(armStartup, 'utf8'), linker.stackSize, linker.heapSize);
      await fs.writeFile(generatedStartup, adapted, 'utf8');
      warnings.push(`Used the matching Keil/CMSIS startup template ${path.relative(root, armStartup)} with linker stack and heap sizes.`);
    } else {
      const ramEnd = addHex(linker.ram.origin, linker.ram.length);
      const adapted = adaptGnuStartupForArmClang(await fs.readFile(startup, 'utf8'), ramEnd);
      await fs.writeFile(generatedStartup, adapted, 'utf8');
      warnings.push('Matching Keil/CMSIS startup template was not found; GNU startup assembly was adapted for ARM Compiler 6.');
    }
    exportedSources = exportedSources.map((file) => file === startup ? generatedStartup as string : file);
  }
  const standalone = await createStandaloneSourceTree(
    root,
    exportDirectory,
    exportedSources.filter((file) => file !== generatedStartup),
    sourceIncludes,
  );
  exportedSources = standalone.sources;
  const exportedLibraries = await copyStandaloneLibraries(
    root,
    exportDirectory,
    linkedLibraries,
  );
  exportedSources.push(...exportedLibraries);
  const mappedCommonIncludes = commonIncludes
    .map((include) => standalone.includeMap.get(include))
    .filter((include): include is string => include !== undefined);
  const sourceOptions = new Map<string, CompileOptions>();
  for (const [originalSource, compileOptions] of compileOptionsBySource) {
    const mappedSource = standalone.sourceMap.get(originalSource);
    if (mappedSource === undefined) {
      continue;
    }
    sourceOptions.set(mappedSource, {
      includes: compileOptions.includes
        .filter((include) => !commonIncludes.includes(include))
        .map((include) => standalone.includeMap.get(include))
        .filter((include): include is string => include !== undefined),
      defines: compileOptions.defines.filter((define) => !defines.includes(define)),
      miscControls: compileOptions.miscControls.filter((flag) => !commonMiscControls.includes(flag)),
    });
  }
  const compatibility = await adaptStandaloneProjectSources(exportedSources, standalone.includes);
  warnings.push(...compatibility.warnings);
  if (generatedStartup !== undefined) {
    exportedSources.push(generatedStartup);
  }
  const model: ExportModel = {
    name,
    device,
    root,
    exportDirectory,
    outputDirectory: path.join(exportDirectory, 'Objects'),
    sources: exportedSources,
    includes: mappedCommonIncludes,
    defines,
    miscControls: commonMiscControls,
    scatterFile,
    linker,
    profile,
    startup: generatedStartup,
    startupSection,
    sourceOptions,
    libraries: exportedLibraries,
    useMicroLib: compatibility.useMicroLib,
  };
  await fs.mkdir(model.outputDirectory, { recursive: true });
  await fs.writeFile(scatterFile, createScatterFile(model), 'utf8');
  const projectFile = path.join(exportDirectory, `${name}.uvprojx`);
  await fs.writeFile(projectFile, createUvprojx(model), 'utf8');
  const report = {
    generatedAt: new Date().toISOString(),
    source: 'compile_commands.json',
    projectFile: reportPath(exportDirectory, projectFile),
    device,
    sources: exportedSources.length,
    includePaths: standalone.includes.length,
    defines,
    linkerScript: reportPath(root, linkerScript),
    entry: linker.entry,
    memoryRegions: linker.regions,
    heapSize: linker.heapSize,
    stackSize: linker.stackSize,
    libraries: exportedLibraries.map((library) => reportPath(exportDirectory, library)),
    perFileOptions: [...sourceOptions.entries()].map(([source, compileOptions]) => ({
      source: reportPath(exportDirectory, source),
      defines: compileOptions.defines,
      includes: compileOptions.includes.map((include) => reportPath(exportDirectory, include)),
      miscControls: compileOptions.miscControls,
    })),
    compatibilityChanges: compatibility.changes.map((change) =>
      sanitizeCompatibilityChange(exportDirectory, change)),
    warnings,
  };
  await fs.writeFile(
    path.join(exportDirectory, 'dockyard32-export.json'),
    `${JSON.stringify(report, undefined, 2)}\n`,
    'utf8',
  );
  await removeLocalMetadataFiles(exportDirectory);
  return { success: true, projectFile, warnings };
}

function commandArguments(entry: CompileCommand): string[] {
  if (entry.arguments !== undefined) {
    return [...entry.arguments];
  }
  return splitShellLike(entry.command ?? '');
}

function parseCompileCommand(
  entry: CompileCommand,
  compileCommandsDirectory: string,
): ParsedCompileCommand {
  const directory = path.resolve(compileCommandsDirectory, entry.directory || '.');
  const args = commandArguments(entry);
  const includes: string[] = [];
  const defines: string[] = [];
  const miscControls: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index] ?? '';
    if (value === '-I' || value === '-isystem') {
      const include = args[index + 1];
      if (include !== undefined) {
        includes.push(path.resolve(directory, include));
        index += 1;
      }
      continue;
    }
    if (value.startsWith('-I') && value.length > 2) {
      includes.push(path.resolve(directory, value.slice(2)));
      continue;
    }
    if (value.startsWith('-isystem') && value.length > '-isystem'.length) {
      includes.push(path.resolve(directory, value.slice('-isystem'.length)));
      continue;
    }
    if (value === '-D') {
      const define = args[index + 1];
      if (define !== undefined) {
        defines.push(define);
        index += 1;
      }
      continue;
    }
    if (value.startsWith('-D') && value.length > 2) {
      defines.push(value.slice(2));
      continue;
    }
    if (isPortableCompileFlag(value)) {
      miscControls.push(value);
    }
  }
  return {
    source: path.resolve(directory, entry.file),
    includes: unique(includes),
    defines: unique(defines),
    miscControls: unique(miscControls),
  };
}

function isPortableCompileFlag(value: string): boolean {
  return /^(?:-O[0-3sz]|-g\d*|-std=[A-Za-z0-9+.-]+|-f(?:short-enums|short-wchar|signed-char|unsigned-char|no-builtin)|-W(?:all|extra|error|no-[A-Za-z0-9-]+))$/u.test(value);
}

function commonValues(groups: readonly (readonly string[])[]): string[] {
  if (groups.length === 0) {
    return [];
  }
  return unique(groups[0] ?? []).filter((value) =>
    groups.every((group) => group.includes(value)));
}

function splitShellLike(command: string): string[] {
  const values: string[] = [];
  const pattern = /"((?:\\.|[^"\\])*)"|'([^']*)'|([^\s]+)/gu;
  for (const match of command.matchAll(pattern)) {
    values.push((match[1] ?? match[2] ?? match[3] ?? '').replace(/\\"/gu, '"'));
  }
  return values;
}

async function findCompileCommands(project: Stm32ProjectInfo): Promise<string | undefined> {
  const candidates = [
    project.buildDir === undefined ? undefined : path.join(project.buildDir, 'compile_commands.json'),
    project.projectRoot === undefined ? undefined : path.join(project.projectRoot, 'build', 'compile_commands.json'),
  ].filter((candidate): candidate is string => candidate !== undefined);
  for (const candidate of candidates) {
    if (await isFile(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

async function findLinkerScript(root: string, buildDir?: string): Promise<string | undefined> {
  const buildFiles = buildDir === undefined
    ? []
    : await walkFiles(buildDir, (candidate) =>
      path.basename(candidate) === 'build.ninja' || path.basename(candidate) === 'link.txt');
  for (const buildFile of buildFiles) {
    const content = await fs.readFile(buildFile, 'utf8');
    for (const match of content.matchAll(/(?:^|\s)-T(?:\s*|=)(?:"([^"]+\.ld)"|'([^']+\.ld)'|([^\s]+\.ld))/gmu)) {
      const value = match[1] ?? match[2] ?? match[3];
      if (value === undefined) {
        continue;
      }
      const candidate = path.isAbsolute(value)
        ? value
        : path.resolve(path.dirname(buildFile), value);
      if (await isFile(candidate)) {
        return candidate;
      }
    }
  }
  const cmakeFiles = await walkFiles(root, (candidate) => path.basename(candidate) === 'CMakeLists.txt', [
    'build', 'MDK-ARM', 'Objects', '.git',
  ]);
  for (const cmakeFile of cmakeFiles) {
    const content = await fs.readFile(cmakeFile, 'utf8');
    for (const match of content.matchAll(/-T(?:\$\{CMAKE_CURRENT_SOURCE_DIR\})?\/?([^\s")]+\.ld)/gu)) {
      const relative = match[1];
      if (relative !== undefined) {
        const candidate = path.resolve(path.dirname(cmakeFile), relative);
        if (await isFile(candidate)) {
          return candidate;
        }
      }
    }
  }
  const candidates = await walkFiles(root, (candidate) => path.extname(candidate).toLowerCase() === '.ld', [
    'build', 'MDK-ARM', 'Objects', '.git',
  ]);
  return candidates[0];
}

async function findLinkedLibraries(root: string, buildDir?: string): Promise<string[]> {
  if (buildDir === undefined) {
    return [];
  }
  const buildFiles = await walkFiles(buildDir, (candidate) =>
    path.basename(candidate) === 'build.ninja' || path.basename(candidate) === 'link.txt');
  const result: string[] = [];
  for (const buildFile of buildFiles) {
    const content = await fs.readFile(buildFile, 'utf8');
    for (const match of content.matchAll(/(?:"([^"]+\.(?:a|lib))"|'([^']+\.(?:a|lib))'|([^\s]+\.(?:a|lib)))/giu)) {
      const value = match[1] ?? match[2] ?? match[3];
      if (value === undefined || /lib(?:c|m|gcc|nosys|stdc\+\+)(?:_nano)?\.a$/iu.test(value)) {
        continue;
      }
      const candidate = path.isAbsolute(value)
        ? value
        : path.resolve(path.dirname(buildFile), value);
      if (await isFile(candidate)) {
        result.push(candidate);
      }
    }
  }
  return unique(result).filter((library) =>
    isInside(library, root) || !path.normalize(library).includes(`${path.sep}arm-none-eabi${path.sep}`));
}

async function copyStandaloneLibraries(
  root: string,
  exportDirectory: string,
  libraries: readonly string[],
): Promise<string[]> {
  const destinationRoot = path.join(exportDirectory, 'SourceTree', 'Libraries');
  const result: string[] = [];
  for (const library of libraries) {
    const destination = isInside(library, root)
      ? path.join(destinationRoot, path.relative(root, library))
      : path.join(destinationRoot, `${createHash('sha256').update(library).digest('hex').slice(0, 12)}-${path.basename(library)}`);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(library, destination);
    result.push(destination);
  }
  return result;
}

function parseLinkerScript(script: string, content: string, profile: Stm32DeviceProfile): LinkerModel {
  const regions: MemoryRegion[] = [];
  const pattern = /^\s*([A-Z][A-Z0-9_]*)\s*\([^)]*\)\s*:\s*ORIGIN\s*=\s*([^,\s]+)\s*,\s*LENGTH\s*=\s*([^\s}]+)/gimu;
  for (const match of content.matchAll(pattern)) {
    if (match[1] !== undefined && match[2] !== undefined && match[3] !== undefined) {
      regions.push({
        name: match[1].toUpperCase(),
        origin: normalizeHex(match[2]),
        length: lengthToHex(match[3]),
      });
    }
  }
  const defaults = defaultLinkerModel(profile);
  const sectionMap = new Map<string, string[]>();
  const sectionPattern = /^\s*(\.[A-Za-z0-9_.$-]+)[^{]*\{([\s\S]*?)\}\s*>\s*([A-Z][A-Z0-9_]*)/gimu;
  for (const match of content.matchAll(sectionPattern)) {
    const region = match[3]?.toUpperCase();
    const body = match[2];
    if (region === undefined || body === undefined) {
      continue;
    }
    const selectors = [...body.matchAll(/\*\s*\(\s*(\.[A-Za-z0-9_.$*-]+)/gu)]
      .map((selector) => selector[1])
      .filter((selector): selector is string => selector !== undefined);
    if (selectors.length > 0) {
      sectionMap.set(region, unique([...(sectionMap.get(region) ?? []), ...selectors]));
    }
  }
  return {
    script,
    entry: /ENTRY\s*\(\s*([^\s)]+)\s*\)/iu.exec(content)?.[1] ?? 'Reset_Handler',
    regions,
    flash: regions.find((region) => region.name.includes('FLASH')) ?? defaults.flash,
    ram: regions.find((region) => region.name === 'RAM') ??
      regions.find((region) => region.name.includes('RAM') && !region.name.includes('CCM')) ?? defaults.ram,
    heapSize: linkerSymbol(content, '_Min_Heap_Size') ?? defaults.heapSize,
    stackSize: linkerSymbol(content, '_Min_Stack_Size') ?? defaults.stackSize,
    sections: sectionMap,
  };
}

function defaultLinkerModel(profile: Stm32DeviceProfile): LinkerModel {
  const flash = { name: 'FLASH', origin: '0x08000000', length: bytesToHex(profile.defaultFlashBytes) };
  const ram = { name: 'RAM', origin: '0x20000000', length: bytesToHex(profile.defaultRamBytes) };
  const ccm = profile.defaultCcmRamBytes === 0
    ? []
    : [{ name: 'CCMRAM', origin: '0x10000000', length: bytesToHex(profile.defaultCcmRamBytes) }];
  return {
    entry: 'Reset_Handler',
    regions: [flash, ram, ...ccm],
    flash,
    ram,
    heapSize: '0x00000400',
    stackSize: '0x00000800',
    sections: new Map(),
  };
}

function linkerSymbol(content: string, symbol: string): string | undefined {
  const match = new RegExp(`${escapeRegExp(symbol)}\\s*=\\s*(0x[0-9a-f]+|\\d+)`, 'iu').exec(content);
  return match?.[1] === undefined ? undefined : normalizeHex(match[1]);
}

async function resolveDevice(root: string, detected?: string): Promise<string | undefined> {
  for (const metadataDirectory of ['.dockyard32', '.stm32-workbench']) {
    try {
      const imported = JSON.parse(await fs.readFile(path.join(root, metadataDirectory, 'mdk-import.json'), 'utf8')) as { device?: unknown };
      if (typeof imported.device === 'string' && imported.device.length > 0) {
        return keilDeviceName(imported.device);
      }
    } catch {
      // Try the current or legacy import metadata.
    }
  }
  try {
    const target = await fs.readFile(path.join(root, 'cmake', 'target.cmake'), 'utf8');
    const match = /set\s*\(CMSIS_Dname\s+([^\s)]+)\s*\)/iu.exec(target);
    if (match?.[1] !== undefined) {
      return keilDeviceName(match[1]);
    }
  } catch {
    // Fall back to project detection.
  }
  return detected === undefined || detected.trim().length === 0
    ? undefined
    : keilDeviceName(detected);
}

function keilDeviceName(device: string): string {
  return normalizeStm32Device(device);
}

function adaptGnuStartupForArmClang(source: string, ramEnd: string): string {
  let result = source
    .replace(/^\s*\.word\s+_(?:sidata|sdata|edata|sbss|ebss)\s*$/gmu, '')
    .replace(/\b_estack\b/gu, () => ramEnd);
  result = result.replace(
    /Reset_Handler:\s*[\s\S]*?\.size\s+Reset_Handler\s*,\s*\.\s*-\s*Reset_Handler/um,
    `Reset_Handler:
  ldr   r0, =${ramEnd}
  mov   sp, r0
  bl    SystemInit
  bl    __main
LoopForever:
  b     LoopForever

  .size Reset_Handler, .-Reset_Handler`,
  );
  return `/* Generated by Dockyard32 for ARM Compiler 6. */\n.eabi_attribute 24, 1\n.eabi_attribute 25, 1\n${result}`;
}

async function findArmStartupTemplate(root: string, startup: string): Promise<string | undefined> {
  const basename = path.basename(startup).toLowerCase().replace(/\.(?:s|asm)$/u, '.s');
  const candidates = await walkFiles(root, (candidate) =>
    path.basename(candidate).toLowerCase() === basename &&
    path.extname(candidate) === '.s' &&
    /[\\/]templates[\\/]arm[\\/]/iu.test(candidate), [
    'build', 'MDK-ARM', 'Objects', '.git',
  ]);
  return candidates[0];
}

function adaptArmStartupMemory(source: string, stackSize: string, heapSize: string): string {
  const stack = formatArmAsmHex(stackSize);
  const heap = formatArmAsmHex(heapSize);
  return source
    .replace(/^(Stack_Size\s+EQU\s+)0x[0-9a-f]+/imu, `$1${stack}`)
    .replace(/^(Heap_Size\s+EQU\s+)0x[0-9a-f]+/imu, `$1${heap}`);
}

function formatArmAsmHex(value: string): string {
  const parsed = Number.parseInt(value, 0);
  return Number.isNaN(parsed) ? value : `0x${parsed.toString(16).toUpperCase().padStart(8, '0')}`;
}

function createScatterFile(model: ExportModel): string {
  const linker = model.linker;
  const stackStart = subtractHex(addHex(linker.ram.origin, linker.ram.length), linker.stackSize);
  const ramDataLength = model.startupSection === 'RESET'
    ? subtractHex(linker.ram.length, linker.stackSize)
    : linker.ram.length;
  const additionalRegions = linker.regions
    .filter((region) => region.name !== linker.flash.name && region.name !== linker.ram.name)
    .map((region) => {
      const selectors = linker.sections.get(region.name) ?? [];
      return selectors.length === 0
        ? `  ; ${region.name} ${region.origin} ${region.length}: no GNU input section was assigned to this region.\n`
        : `  RW_${safeScatterName(region.name)} ${region.origin} ${region.length} {\n` +
          selectors.map((selector) => `    * (${selector})`).join('\n') + '\n  }\n';
    }).join('');
  return `; Generated by Dockyard32.\n` +
    `; Source linker script: ${reportPath(model.root, linker.script) ?? `default ${model.profile.family} layout`}\n` +
    `LR_IROM1 ${linker.flash.origin} ${linker.flash.length} {\n` +
    `  ER_IROM1 ${linker.flash.origin} ${linker.flash.length} {\n` +
    `    *.o (${model.startupSection}, +First)\n` +
    `    *(InRoot$$Sections)\n` +
    `    .ANY (+RO)\n` +
    `  }\n` +
    `  RW_IRAM1 ${linker.ram.origin} ${ramDataLength} {\n` +
    `    .ANY (+RW +ZI)\n` +
    `  }\n` +
    additionalRegions +
    (model.startupSection === 'RESET' && model.startup !== undefined
      ? `  ARM_LIB_STACK ${stackStart} ${linker.stackSize} {\n` +
        `    ${path.basename(model.startup, path.extname(model.startup))}.o (STACK)\n` +
        `  }\n`
      : `  ARM_LIB_HEAP  +0 EMPTY ${linker.heapSize} { }\n` +
        `  ARM_LIB_STACK ${addHex(linker.ram.origin, linker.ram.length)} EMPTY -${linker.stackSize} { }\n`) +
    `}\n`;
}

function safeScatterName(value: string): string {
  return value.replace(/[^A-Za-z0-9_]/gu, '_');
}

function createUvprojx(model: ExportModel): string {
  const { flash, ram } = model.linker;
  const architectureFlags = keilArchitectureFlags(model.profile).join(' ');
  const outputRelative = relativeWindows(model.exportDirectory, model.outputDirectory);
  const scatterRelative = relativeWindows(model.exportDirectory, model.scatterFile);
  const includePaths = model.includes
    .map((item) => relativeWindows(model.exportDirectory, item))
    .join(';');
  const groups = groupSources(model).map(([group, sources]) => `
        <Group><GroupName>${xml(group)}</GroupName><Files>${sources.map((source) => `
          <File><FileName>${xml(path.basename(source))}</FileName><FileType>${fileType(source)}</FileType><FilePath>${xml(relativeWindows(model.exportDirectory, source))}</FilePath>${fileOptions(model, source)}</File>`).join('')}
        </Files></Group>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="no" ?>
<Project xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="project_projx.xsd">
  <SchemaVersion>2.1</SchemaVersion><Header>### uVision Project, generated by Dockyard32</Header>
  <Targets><Target><TargetName>${xml(model.name)}</TargetName><ToolsetNumber>0x4</ToolsetNumber><ToolsetName>ARM-ADS</ToolsetName><pCCUsed>6190000::V6.19::ARMCLANG</pCCUsed><uAC6>1</uAC6>
    <TargetOption><TargetCommonOption>
      <Device>${xml(model.device)}</Device><Vendor>STMicroelectronics</Vendor><Cpu>CPUTYPE("${model.profile.cortex}")${model.profile.fpu === undefined ? '' : ' FPU2'} ELITTLE</Cpu>
      <OutputDirectory>${xml(`${outputRelative}\\`)}</OutputDirectory><OutputName>${xml(model.name)}</OutputName><CreateExecutable>1</CreateExecutable><CreateLib>0</CreateLib><CreateHexFile>1</CreateHexFile><DebugInformation>1</DebugInformation><BrowseInformation>1</BrowseInformation><ListingPath>${xml(`${outputRelative}\\`)}</ListingPath><HexFormatSelection>1</HexFormatSelection><CreateBatchFile>0</CreateBatchFile>
      <TargetStatus><Error>0</Error><ExitCodeStop>0</ExitCodeStop><ButtonStop>0</ButtonStop><NotGenerated>0</NotGenerated><InvalidFlash>1</InvalidFlash></TargetStatus>
    </TargetCommonOption><CommonProperty><UseCPPCompiler>0</UseCPPCompiler><IncludeInBuild>1</IncludeInBuild><AlwaysBuild>0</AlwaysBuild><GenerateAssemblyFile>0</GenerateAssemblyFile><StopOnExitCode>3</StopOnExitCode></CommonProperty>
    <DllOption><SimDllName>SARMCM3.DLL</SimDllName><SimDllArguments>-MPU</SimDllArguments><TargetDllName>SARMCM3.DLL</TargetDllName><TargetDllArguments>-MPU</TargetDllArguments></DllOption>
    <DebugOption><OPTHX><HexSelection>1</HexSelection><HexRangeLowAddress>0</HexRangeLowAddress><HexRangeHighAddress>0</HexRangeHighAddress><HexOffset>0</HexOffset><Oh166RecLen>16</Oh166RecLen></OPTHX></DebugOption>
    <Utilities><Flash1><UseTargetDll>1</UseTargetDll><UseExternalTool>0</UseExternalTool><UpdateFlashBeforeDebugging>1</UpdateFlashBeforeDebugging></Flash1><Flash2>BIN\\UL2CM3.DLL</Flash2></Utilities>
    <TargetArmAds><ArmAdsMisc><GenerateListings>0</GenerateListings><AdsCpuType>"${model.profile.cortex}"</AdsCpuType><RvdsVP>2</RvdsVP><RvdsMve>0</RvdsMve><hadIRAM>1</hadIRAM><hadIROM>1</hadIROM><StupSel>8</StupSel><useUlib>${model.useMicroLib ? 1 : 0}</useUlib><RoSelD>3</RoSelD><RwSelD>4</RwSelD><CodeSel>0</CodeSel><NoZi1>0</NoZi1><NoZi2>0</NoZi2><NoZi3>0</NoZi3><NoZi4>0</NoZi4><NoZi5>0</NoZi5><Ir1Chk>1</Ir1Chk><Ir2Chk>0</Ir2Chk><Im1Chk>1</Im1Chk><Im2Chk>0</Im2Chk>
      <OnChipMemories><IRAM><Type>0</Type><StartAddress>${ram.origin}</StartAddress><Size>${ram.length}</Size></IRAM><IROM><Type>1</Type><StartAddress>${flash.origin}</StartAddress><Size>${flash.length}</Size></IROM><OCR_RVCT4><Type>1</Type><StartAddress>${flash.origin}</StartAddress><Size>${flash.length}</Size></OCR_RVCT4><OCR_RVCT9><Type>0</Type><StartAddress>${ram.origin}</StartAddress><Size>${ram.length}</Size></OCR_RVCT9></OnChipMemories>
    </ArmAdsMisc>
      <Cads><interw>1</interw><Optim>0</Optim><oTime>0</oTime><SplitLS>0</SplitLS><OneElfS>1</OneElfS><Strict>0</Strict><wLevel>2</wLevel><uThumb>0</uThumb><uC99>1</uC99><uGnu>1</uGnu><v6Lang>3</v6Lang><VariousControls><MiscControls>${xml([architectureFlags, ...model.miscControls].join(' '))}</MiscControls><Define>${xml(model.defines.join(','))}</Define><Undefine></Undefine><IncludePath>${xml(includePaths)}</IncludePath></VariousControls></Cads>
      <Aads><interw>1</interw><thumb>1</thumb><ClangAsOpt>1</ClangAsOpt><VariousControls><MiscControls>${architectureFlags}</MiscControls><Define>${xml(model.defines.join(','))}</Define><Undefine></Undefine><IncludePath>${xml(includePaths)}</IncludePath></VariousControls></Aads>
      <LDads><umfTarg>0</umfTarg><noStLib>0</noStLib><RepFail>1</RepFail><useFile>1</useFile><TextAddressRange>${flash.origin}</TextAddressRange><DataAddressRange>${ram.origin}</DataAddressRange><ScatterFile>${xml(scatterRelative)}</ScatterFile><Misc>--entry ${xml(model.linker.entry)} --map --symbols</Misc></LDads>
    </TargetArmAds></TargetOption><Groups>${groups}
    </Groups></Target></Targets>
</Project>
`;
}

function groupSources(model: ExportModel): Array<[string, string[]]> {
  const groups = new Map<string, string[]>();
  for (const source of model.sources) {
    const relative = path.relative(path.join(model.exportDirectory, 'SourceTree'), source);
    const parts = relative.split(path.sep);
    const first = parts[0];
    const group = source === model.startup
      ? 'Generated Startup'
      : first === undefined || first === '..'
        ? 'Sources'
        : groupName(parts);
    const values = groups.get(group) ?? [];
    values.push(source);
    groups.set(group, values);
  }
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function groupName(parts: readonly string[]): string {
  if (parts[0] === 'Drivers' && /^STM32(?:F1|F4|G4)xx_HAL_Driver$/iu.test(parts[1] ?? '')) {
    return `Drivers/${parts[1]}`;
  }
  if (parts[0] === 'Drivers' && parts[1] === 'CMSIS') {
    return 'Drivers/CMSIS';
  }
  return parts.slice(0, Math.min(parts.length - 1, 2)).join('/') || parts[0] || 'Sources';
}

function isVendorSource(source: string): boolean {
  return /[\\/](?:STM32(?:F1|F4|G4)xx_HAL_Driver|CMSIS)[\\/]/iu.test(source);
}

function fileOptions(model: ExportModel, source: string): string {
  const options = model.sourceOptions.get(source);
  const vendorFlags = isVendorSource(source)
    ? ['-Wno-unused-parameter', '-Wno-unused-function', '-Wno-sign-compare']
    : [];
  const miscControls = unique([...(options?.miscControls ?? []), ...vendorFlags]);
  const defines = options?.defines ?? [];
  const includes = (options?.includes ?? [])
    .map((include) => relativeWindows(model.exportDirectory, include));
  if (miscControls.length === 0 && defines.length === 0 && includes.length === 0) {
    return '';
  }
  const controls = `<VariousControls><MiscControls>${xml(miscControls.join(' '))}</MiscControls><Define>${xml(defines.join(','))}</Define><Undefine></Undefine><IncludePath>${xml(includes.join(';'))}</IncludePath></VariousControls>`;
  return '<FileOption><CommonProperty><UseCPPCompiler>2</UseCPPCompiler><IncludeInBuild>2</IncludeInBuild><AlwaysBuild>2</AlwaysBuild><GenerateAssemblyFile>2</GenerateAssemblyFile><StopOnExitCode>11</StopOnExitCode></CommonProperty>' +
    `<FileArmAds><Cads><interw>2</interw><Optim>0</Optim><uC99>2</uC99><uGnu>2</uGnu><v6Lang>0</v6Lang>${controls}</Cads><Aads><interw>2</interw><thumb>2</thumb>${controls}</Aads></FileArmAds></FileOption>`;
}

function fileType(file: string): number {
  const extension = path.extname(file).toLowerCase();
  return extension === '.c' ? 1 : extension === '.s' || extension === '.asm' ? 2 : extension === '.a' || extension === '.lib' ? 4 : extension === '.cpp' || extension === '.cxx' ? 8 : 5;
}

function relativeWindows(from: string, to: string): string {
  return path.relative(from, to).split(path.sep).join('\\');
}

async function createStandaloneSourceTree(
  root: string,
  exportDirectory: string,
  sources: readonly string[],
  includes: readonly string[],
): Promise<{
  readonly sources: string[];
  readonly includes: string[];
  readonly sourceMap: ReadonlyMap<string, string>;
  readonly includeMap: ReadonlyMap<string, string>;
}> {
  const sourceTree = path.join(exportDirectory, 'SourceTree');
  const copiedIncludes = new Map<string, string>();
  const resultIncludes: string[] = [];
  for (const include of unique(includes.map((candidate) => path.resolve(candidate)))) {
    const destination = standalonePath(root, sourceTree, include, true);
    if (!copiedIncludes.has(include) && await isDirectory(include)) {
      await fs.mkdir(destination, { recursive: true });
      copiedIncludes.set(include, destination);
      resultIncludes.push(destination);
    }
  }
  const requiredHeaders = await resolveIncludedHeaders(sources, [...copiedIncludes.keys()]);
  for (const header of requiredHeaders) {
    const owningInclude = [...copiedIncludes.keys()]
      .filter((include) => isInside(header, include))
      .sort((left, right) => right.length - left.length)[0];
    const destination = owningInclude === undefined
      ? standalonePath(root, sourceTree, header, false)
      : path.join(copiedIncludes.get(owningInclude) as string, path.relative(owningInclude, header));
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(header, destination);
  }
  const resultSources: string[] = [];
  const sourceMap = new Map<string, string>();
  for (const source of sources) {
    const owningInclude = [...copiedIncludes.keys()]
      .filter((include) => isInside(source, include))
      .sort((left, right) => right.length - left.length)[0];
    const destination = owningInclude === undefined
      ? standalonePath(root, sourceTree, source, false)
      : path.join(copiedIncludes.get(owningInclude) as string, path.relative(owningInclude, source));
    if (owningInclude === undefined) {
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(source, destination);
    } else if (!await isFile(destination)) {
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(source, destination);
    }
    resultSources.push(destination);
    sourceMap.set(path.resolve(source), destination);
  }
  return {
    sources: unique(resultSources),
    includes: unique(resultIncludes),
    sourceMap,
    includeMap: copiedIncludes,
  };
}

async function resolveIncludedHeaders(
  sources: readonly string[],
  includes: readonly string[],
): Promise<string[]> {
  const headers = new Set<string>();
  const visited = new Set<string>();
  const pending = sources.filter((source) => /\.(?:c|cc|cpp|cxx|h|hpp|s|asm)$/iu.test(source));
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
      if (requested === undefined) {
        continue;
      }
      const candidates = [path.resolve(path.dirname(current), requested)]
        .concat(includes.map((include) => path.resolve(include, requested)));
      let resolved: string | undefined;
      for (const candidate of candidates) {
        if (await isFile(candidate)) {
          resolved = candidate;
          break;
        }
      }
      if (resolved !== undefined && !headers.has(resolved)) {
        headers.add(resolved);
        pending.push(resolved);
      }
    }
  }
  return [...headers];
}

async function adaptStandaloneProjectSources(
  sources: readonly string[],
  includes: readonly string[],
): Promise<{
  readonly changes: string[];
  readonly warnings: string[];
  readonly useMicroLib: boolean;
}> {
  const changes: string[] = [];
  const warnings: string[] = [];
  let useMicroLib = false;
  for (const source of sources.filter((candidate) => path.extname(candidate).toLowerCase() === '.c')) {
    if (isVendorSource(source)) {
      continue;
    }
    const original = await fs.readFile(source, 'latin1');
    if (/__use_no_semihosting/u.test(original) && /\bfputc\s*\(/u.test(original)) {
      useMicroLib = true;
    }
    let adapted = original;
    adapted = adapted
      .replace(/^([ \t]*)([A-Za-z_]\w*)\s*=\s*\2\s*;/gmu, '$1(void)$2;')
      .replace(
        /^([ \t]*)FILE\s+__stdout\s*;\s*$/gmu,
        '$1#if !defined(__ARMCC_VERSION) || (__ARMCC_VERSION < 6010050)\r\n$1FILE __stdout;\r\n$1#endif',
      )
      .replace(/(char\s*\*_sys_command_string\s*\(char\s*\*cmd\s*,\s*int\s+len\s*\)\s*\{?\s*\r?\n)/u, '$1    (void)cmd;\r\n    (void)len;\r\n')
      .replace(/(int\s+fputc\s*\(int\s+ch\s*,\s*FILE\s*\*f\s*\)\s*\{?\s*\r?\n)/u, '$1    (void)f;\r\n')
      .replace(/(void\s+HAL_SRAM_MspInit\s*\(SRAM_HandleTypeDef\s*\*hsram\s*\)\s*\{?\s*\r?\n)/u, '$1    (void)hsram;\r\n');
    adapted = adaptCharacterTableIndex(adapted);
    if (adapted !== original) {
      await fs.writeFile(source, adapted, 'latin1');
      changes.push(`ARMClang compatibility: ${source}`);
    }
  }

  const configFiles = unique((await Promise.all(includes.map((include) =>
    walkFiles(include, (candidate) =>
      /^stm32(?:f1|f4|g4)xx_hal_conf\.h$/iu.test(path.basename(candidate)))))).flat());
  const enabledModules = halModulesUsedBySources(sources);
  for (const config of configFiles) {
    if (/[\\/]STM32(?:F1|F4|G4)xx_HAL_Driver[\\/]/iu.test(config)) {
      continue;
    }
    const original = await fs.readFile(config, 'latin1');
    const disabled: string[] = [];
    const adapted = original.replace(
      /^(\s*)#define\s+HAL_([A-Z0-9]+)_MODULE_ENABLED\s*$/gmu,
      (line, indentation: string, module: string) => {
        if (enabledModules.has(module)) {
          return line;
        }
        disabled.push(module);
        return `${indentation}/* #define HAL_${module}_MODULE_ENABLED */`;
      },
    );
    if (adapted !== original) {
      await fs.writeFile(config, adapted, 'latin1');
      changes.push(`Disabled unused HAL modules in ${config}: ${disabled.join(', ')}`);
      warnings.push(`Disabled unused HAL modules in the exported configuration: ${disabled.join(', ')}.`);
    }
  }
  if (sources.some(isVendorSource)) {
    changes.push('Applied ARMClang warning suppression only to copied HAL/CMSIS vendor source files.');
  }
  if (useMicroLib) {
    changes.push('Enabled Arm MicroLIB for legacy fputc/no-semihosting retarget code.');
  }
  return { changes, warnings, useMicroLib };
}

function halModulesUsedBySources(sources: readonly string[]): Set<string> {
  const modules = new Set<string>();
  for (const source of sources) {
    const match = /stm32(?:f1|f4|g4)xx_hal_([a-z0-9]+)(?:_ex)?\.c$/iu.exec(path.basename(source));
    if (match?.[1] !== undefined) {
      modules.add(match[1].toUpperCase());
    }
  }
  if (sources.some((source) => /stm32(?:f1|f4|g4)xx_hal(?:_rcc)?\.c$/iu.test(path.basename(source)))) {
    modules.add('FLASH');
  }
  return modules;
}

function adaptCharacterTableIndex(source: string): string {
  if (!/void\s+lcd_show_char\s*\([^)]*char\s+chr/iu.test(source) ||
      !/asc2_(?:1206|1608|2412|3216)\[chr\]/u.test(source)) {
    return source;
  }
  let adapted = source.replace(
    /(uint8_t\s+\*pfont\s*=\s*0\s*;\s*\r?\n)/u,
    '$1    uint8_t glyph_index;\r\n    const unsigned char ascii = (unsigned char)chr;\r\n\r\n    if (ascii < (unsigned char)\' \' || ascii > (unsigned char)\'~\')\r\n    {\r\n        return;\r\n    }\r\n\r\n    glyph_index = (uint8_t)(ascii - (unsigned char)\' \');\r\n',
  );
  adapted = adapted
    .replace(/^\s*chr\s*=\s*chr\s*-\s*' '\s*;.*$/gmu, '')
    .replace(/(asc2_(?:1206|1608|2412|3216))\[chr\]/gu, '$1[glyph_index]');
  return adapted;
}

function standalonePath(
  root: string,
  sourceTree: string,
  candidate: string,
  directory: boolean,
): string {
  const relative = path.relative(root, candidate);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return path.join(sourceTree, relative || (directory ? 'Project' : path.basename(candidate)));
  }
  const digest = createHash('sha1').update(candidate).digest('hex').slice(0, 8);
  return path.join(sourceTree, 'External', `${digest}-${path.basename(candidate)}`);
}

function isInside(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizeHex(value: string): string {
  const parsed = Number.parseInt(value, 0);
  return Number.isNaN(parsed) ? value : `0x${parsed.toString(16).toUpperCase().padStart(8, '0')}`;
}

function bytesToHex(value: number): string {
  return `0x${value.toString(16).toUpperCase().padStart(8, '0')}`;
}

function lengthToHex(value: string): string {
  const match = /^(0x[0-9a-f]+|\d+)([km]?)$/iu.exec(value.trim());
  if (match === null) {
    return value;
  }
  let result = Number.parseInt(match[1] ?? '0', 0);
  const suffix = match[2]?.toUpperCase();
  result *= suffix === 'K' ? 1024 : suffix === 'M' ? 1024 * 1024 : 1;
  return `0x${result.toString(16).toUpperCase().padStart(8, '0')}`;
}

function addHex(left: string, right: string): string {
  const value = Number.parseInt(left, 0) + Number.parseInt(right, 0);
  return `0x${value.toString(16).toUpperCase().padStart(8, '0')}`;
}

function subtractHex(left: string, right: string): string {
  const value = Number.parseInt(left, 0) - Number.parseInt(right, 0);
  return `0x${value.toString(16).toUpperCase().padStart(8, '0')}`;
}

function safeTargetName(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_.-]/gu, '_');
  return cleaned.length > 0 ? cleaned : 'STM32_Firmware';
}

function sanitizeCompatibilityChange(base: string, change: string): string {
  const separator = change.indexOf(': ');
  if (separator < 0) {
    return change;
  }
  const prefix = change.slice(0, separator + 2);
  const candidate = change.slice(separator + 2);
  return path.isAbsolute(candidate)
    ? `${prefix}${reportPath(base, candidate) ?? path.basename(candidate)}`
    : change;
}

function isSupportedSource(file: string): boolean {
  return ['.c', '.cc', '.cpp', '.cxx', '.s', '.asm'].includes(path.extname(file).toLowerCase());
}

function isGnuRuntimeStub(file: string): boolean {
  return /^(?:syscall|syscalls|sysmem)\.c$/iu.test(path.basename(file));
}

async function completeKnownHalDependencies(
  sources: readonly string[],
): Promise<{ readonly sources: string[]; readonly added: string[] }> {
  const result = [...sources];
  const added: string[] = [];
  const sourceSet = new Set(sources.map((file) => path.resolve(file)));
  const contents = await Promise.all(sources
    .filter((file) => path.extname(file).toLowerCase() === '.c')
    .map(async (file) => {
      try {
        return await fs.readFile(file, 'utf8');
      } catch {
        return '';
      }
    }));
  if (contents.some((content) => /\bHAL_DMA_(?:Start|Abort|GetError)/u.test(content))) {
    const halSource = sources.find((file) => /STM32(?:F1|F4|G4)xx_HAL_Driver[\\/]Src[\\/]/iu.test(file));
    if (halSource !== undefined) {
      const familyPrefix = /^stm32(?:f1|f4|g4)xx/iu.exec(path.basename(halSource))?.[0].toLowerCase();
      for (const name of familyPrefix === undefined ? [] : [`${familyPrefix}_hal_dma.c`, `${familyPrefix}_hal_dma_ex.c`]) {
        const candidate = path.join(path.dirname(halSource), name);
        if (!sourceSet.has(candidate) && await isFile(candidate)) {
          result.push(candidate);
          sourceSet.add(candidate);
          added.push(candidate);
        }
      }
    }
  }
  return { sources: result, added };
}

async function walkFiles(
  root: string,
  accept: (candidate: string) => boolean,
  ignoredDirectories: readonly string[] = [],
): Promise<string[]> {
  const result: string[] = [];
  const pending = [root];
  const ignored = new Set(ignoredDirectories);
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) {
      continue;
    }
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) {
          pending.push(candidate);
        }
      } else if (entry.isFile() && accept(candidate)) {
        result.push(candidate);
      }
    }
  }
  return result.sort();
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
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

function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
