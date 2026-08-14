import { constants as fsConstants, promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type {
  DevelopmentTools,
  DiscoveredTool,
  ToolDiscoveryOptions,
  ToolKind,
  ToolSource,
} from '../types/tools';

const MAX_SEARCH_DEPTH = 9;
const MAX_SEARCH_ENTRIES = 30_000;

const EXECUTABLE_NAMES: Readonly<Record<ToolKind, readonly string[]>> = {
  cmake: ['cmake'],
  ninja: ['ninja'],
  'arm-gcc': ['arm-none-eabi-gcc'],
  programmer: ['STM32_Programmer_CLI', 'STM32CubeProgrammer_CLI'],
};

export async function discoverDevelopmentTools(
  options: ToolDiscoveryOptions = {},
): Promise<DevelopmentTools> {
  const env = options.env ?? process.env;
  const configured = options.configured ?? {};
  const kinds: readonly ToolKind[] = [
    'cmake',
    'ninja',
    'arm-gcc',
    'programmer',
  ];

  const results = new Map<ToolKind, DiscoveredTool>();
  for (const kind of kinds) {
    const explicit = configured[kind];
    if (explicit !== undefined) {
      const valid = await isExecutable(expandHome(explicit));
      if (valid) {
        results.set(kind, availableTool(kind, expandHome(explicit), 'configured'));
        continue;
      }
    }

    const fromPath = await findOnPath(EXECUTABLE_NAMES[kind], env);
    if (fromPath !== undefined) {
      results.set(kind, availableTool(kind, fromPath, 'path'));
    }
  }

  const missing = kinds.filter((kind) => !results.has(kind));
  if (missing.length > 0) {
    const roots = options.searchRoots ?? defaultSearchRoots();
    const matches = await findKnownExecutables(roots, new Set(missing));
    for (const [kind, executable] of matches) {
      if (!results.has(kind)) {
        results.set(
          kind,
          availableTool(kind, executable, classifySource(executable)),
        );
      }
    }
  }

  return {
    cmake: results.get('cmake') ?? missingTool('cmake'),
    ninja: results.get('ninja') ?? missingTool('ninja'),
    armGcc: results.get('arm-gcc') ?? missingTool('arm-gcc'),
    programmer: results.get('programmer') ?? missingTool('programmer'),
    detectedAt: Date.now(),
  };
}

function defaultSearchRoots(): string[] {
  return [
    '/Applications/STMicroelectronics',
    '/Applications/STM32CubeProgrammer.app',
    '/Applications/STM32CubeCLT',
    path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'stm32cube',
      'bundles',
    ),
    path.join(os.homedir(), 'STMicroelectronics'),
    path.join(os.homedir(), 'STM32Cube'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
}

async function findOnPath(
  names: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const pathEntries = (env.PATH ?? '')
    .split(path.delimiter)
    .filter((entry) => entry.length > 0);
  for (const directory of pathEntries) {
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (await isExecutable(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

async function findKnownExecutables(
  roots: readonly string[],
  missingKinds: ReadonlySet<ToolKind>,
): Promise<Map<ToolKind, string>> {
  const names = new Map<string, ToolKind>();
  for (const kind of missingKinds) {
    for (const name of EXECUTABLE_NAMES[kind]) {
      names.set(name, kind);
    }
  }

  const found = new Map<ToolKind, string>();
  let visited = 0;

  async function visit(directory: string, depth: number): Promise<void> {
    if (
      depth > MAX_SEARCH_DEPTH ||
      visited >= MAX_SEARCH_ENTRIES ||
      found.size >= missingKinds.size
    ) {
      return;
    }

    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((left, right) =>
      right.name.localeCompare(left.name, undefined, {
        numeric: true,
        sensitivity: 'base',
      }),
    );

    for (const entry of entries) {
      visited += 1;
      if (entry.isSymbolicLink()) {
        continue;
      }
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(candidate, depth + 1);
      } else if (entry.isFile()) {
        const kind = names.get(entry.name);
        if (
          kind !== undefined &&
          !found.has(kind) &&
          (await isExecutable(candidate))
        ) {
          found.set(kind, candidate);
        }
      }
    }
  }

  for (const root of roots) {
    await visit(expandHome(root), 0);
  }
  return found;
}

async function isExecutable(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate, fsConstants.X_OK);
    return (await fs.stat(candidate)).isFile();
  } catch {
    return false;
  }
}

function availableTool(
  kind: ToolKind,
  executable: string,
  source: ToolSource,
): DiscoveredTool {
  return { kind, available: true, executable: path.resolve(executable), source };
}

function missingTool(kind: ToolKind): DiscoveredTool {
  return { kind, available: false };
}

function classifySource(executable: string): ToolSource {
  return executable.includes('.app/Contents/') ? 'application' : 'stm32cube';
}

function expandHome(value: string): string {
  return value === '~'
    ? os.homedir()
    : value.startsWith(`~${path.sep}`)
      ? path.join(os.homedir(), value.slice(2))
      : value;
}
