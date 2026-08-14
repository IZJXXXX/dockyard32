export type ToolKind = 'cmake' | 'ninja' | 'arm-gcc' | 'programmer';

export type ToolSource = 'path' | 'stm32cube' | 'application' | 'configured';

export interface DiscoveredTool {
  readonly kind: ToolKind;
  readonly available: boolean;
  readonly executable?: string;
  readonly source?: ToolSource;
}

export interface DevelopmentTools {
  readonly cmake: DiscoveredTool;
  readonly ninja: DiscoveredTool;
  readonly armGcc: DiscoveredTool;
  readonly programmer: DiscoveredTool;
  readonly detectedAt: number;
}

export interface ToolDiscoveryOptions {
  readonly configured?: Partial<Record<ToolKind, string>>;
  readonly env?: NodeJS.ProcessEnv;
  readonly searchRoots?: readonly string[];
}
