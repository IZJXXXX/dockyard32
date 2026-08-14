import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { AgentApi, AgentResult } from '../types/agent';
import {
  emptyInputSchema,
  sendSerialInputSchema,
  serialLogInputSchema,
  waitSerialInputSchema,
} from './schemas';

export const STM32_MCP_TOOL_NAMES = [
  'stm32_get_project_info',
  'stm32_get_tool_status',
  'stm32_get_probe_info',
  'stm32_get_serial_status',
  'stm32_get_serial_log',
  'stm32_get_last_run',
  'stm32_build',
  'stm32_flash',
  'stm32_reset',
  'stm32_build_and_run',
  'stm32_send_serial',
  'stm32_wait_serial',
] as const;

export function registerStm32Tools(server: McpServer, api: AgentApi): void {
  server.registerTool(
    'stm32_get_project_info',
    {
      title: 'Get STM32 Project Info',
      description:
        'Return structured information for the explicitly configured STM32 workspace and CMake project. This tool is read-only.',
      inputSchema: emptyInputSchema,
      annotations: readOnlyAnnotations(),
    },
    async () => toolResult(await safeCall(() => api.getProjectInfo())),
  );
  server.registerTool(
    'stm32_get_tool_status',
    {
      title: 'Get STM32 Tool Status',
      description:
        'Discover CMake, Ninja, ARM GCC, and STM32CubeProgrammer using the Workbench Core and return structured availability and paths. This tool is read-only.',
      inputSchema: emptyInputSchema,
      annotations: readOnlyAnnotations(),
    },
    async () => toolResult(await safeCall(() => api.getToolStatus())),
  );
  server.registerTool(
    'stm32_get_probe_info',
    {
      title: 'Get ST-LINK Probe Info',
      description:
        'Query configured ST-LINK probes through the existing Workbench Device Core. Returns an error if no probe or multiple probes are present.',
      inputSchema: emptyInputSchema,
      annotations: readOnlyAnnotations(),
    },
    async () => toolResult(await safeCall(() => api.getProbeInfo())),
  );
  server.registerTool(
    'stm32_get_serial_status',
    {
      title: 'Get STM32 Serial Status',
      description:
        'Return the current Workbench serial connection status. The independent stdio server never opens or steals a serial port owned by VS Code.',
      inputSchema: emptyInputSchema,
      annotations: readOnlyAnnotations(),
    },
    async () => toolResult(await safeCall(() => api.getSerialStatus())),
  );
  server.registerTool(
    'stm32_get_serial_log',
    {
      title: 'Get STM32 Serial Log',
      description:
        'Return a bounded tail of the raw MCU serial log without Serial Panel Run Marker presentation text.',
      inputSchema: serialLogInputSchema,
      annotations: readOnlyAnnotations(),
    },
    async ({ maxLines }) =>
      toolResult(await safeCall(() => api.getSerialLog(maxLines))),
  );
  server.registerTool(
    'stm32_get_last_run',
    {
      title: 'Get Last STM32 Run',
      description:
        'Return the most recently persisted structured Build & Run result for the configured workspace. This tool is read-only.',
      inputSchema: emptyInputSchema,
      annotations: readOnlyAnnotations(),
    },
    async () => toolResult(await safeCall(() => api.getLastRun())),
  );
  server.registerTool(
    'stm32_build',
    {
      title: 'Build STM32 Project',
      description:
        'Build the currently configured STM32 CMake project with the existing Build Core. Returns structured compiler errors and warnings. Does not flash or reset.',
      inputSchema: emptyInputSchema,
      annotations: actionAnnotations(true),
    },
    async () => toolResult(await safeCall(() => api.build())),
  );
  server.registerTool(
    'stm32_flash',
    {
      title: 'Flash STM32 Firmware',
      description:
        'Flash and verify only the current firmware artifact validated by a successful stm32_build in this MCP server session. Does not accept arbitrary firmware paths and does not reset.',
      inputSchema: emptyInputSchema,
      annotations: actionAnnotations(false),
    },
    async () => toolResult(await safeCall(() => api.flash())),
  );
  server.registerTool(
    'stm32_reset',
    {
      title: 'Reset STM32 Target',
      description:
        'Reset the single configured STM32 target through ST-LINK using the existing Reset Core. Does not build or flash.',
      inputSchema: emptyInputSchema,
      annotations: actionAnnotations(false),
    },
    async () => toolResult(await safeCall(() => api.reset())),
  );
  server.registerTool(
    'stm32_build_and_run',
    {
      title: 'Build and Run STM32 Firmware',
      description:
        'Call the existing Phase 5 Build & Run Core to build, validate, flash, verify, prepare runtime serial verification when owned by the caller, reset, and return the complete structured RunResult.',
      inputSchema: emptyInputSchema,
      annotations: actionAnnotations(false),
    },
    async () => toolResult(await safeCall(() => api.buildAndRun())),
  );
  server.registerTool(
    'stm32_send_serial',
    {
      title: 'Send STM32 Serial Text',
      description:
        'Send bounded text through the serial connection already owned by Workbench. Cannot select or open an arbitrary device file.',
      inputSchema: sendSerialInputSchema,
      annotations: actionAnnotations(false),
    },
    async (input) =>
      toolResult(await safeCall(() => api.sendSerial(input))),
  );
  server.registerTool(
    'stm32_wait_serial',
    {
      title: 'Wait for STM32 Serial Text',
      description:
        'Wait up to 60 seconds for a literal pattern on the serial connection already owned by Workbench. Does not open or reconfigure ports.',
      inputSchema: waitSerialInputSchema,
      annotations: readOnlyAnnotations(),
    },
    async (input) =>
      toolResult(await safeCall(() => api.waitSerial(input))),
  );
}

function toolResult<T>(result: AgentResult<T>): CallToolResult {
  const structured = serializableRecord(result);
  return {
    content: [{ type: 'text', text: JSON.stringify(result, undefined, 2) }],
    structuredContent: structured,
    isError: !result.success,
  };
}

async function safeCall<T>(
  call: () => Promise<AgentResult<T>>,
): Promise<AgentResult<T>> {
  try {
    return await call();
  } catch (error: unknown) {
    return {
      success: false,
      error: {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : String(error),
        stage: 'mcp',
      },
    };
  }
}

function serializableRecord<T>(result: AgentResult<T>): Record<string, unknown> {
  const value: unknown = JSON.parse(JSON.stringify(result));
  return isRecord(value) ? value : { success: false };
}

function readOnlyAnnotations(): {
  readonly readOnlyHint: true;
  readonly destructiveHint: false;
  readonly idempotentHint: true;
  readonly openWorldHint: false;
} {
  return {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };
}

function actionAnnotations(idempotent: boolean): {
  readonly readOnlyHint: false;
  readonly destructiveHint: false;
  readonly idempotentHint: boolean;
  readonly openWorldHint: false;
} {
  return {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: idempotent,
    openWorldHint: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
