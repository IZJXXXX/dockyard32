#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createAgentApi } from '../agent/api';
import type { AgentApi } from '../types/agent';
import { registerStm32Tools } from './tools';

const SERVER_NAME = 'stm32-workbench';
const SERVER_VERSION = '0.1.1';

export function createStm32McpServer(api: AgentApi): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        'Operate only the explicitly configured STM32 workspace. Build before Flash. Use Build & Run for the safest complete deployment. No arbitrary shell, firmware path, memory write, option-byte, or serial-open capability is exposed.',
    },
  );
  registerStm32Tools(server, api);
  return server;
}

export async function resolveMcpWorkspace(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const argumentIndex = args.indexOf('--workspace');
  const argument =
    argumentIndex >= 0 ? args[argumentIndex + 1] : undefined;
  if (argumentIndex >= 0 && argument === undefined) {
    throw new Error('--workspace requires an absolute directory path');
  }
  const configured = argument ?? env.STM32_WORKBENCH_WORKSPACE;
  if (configured === undefined || configured.trim().length === 0) {
    throw new Error(
      'STM32 workspace is required. Pass --workspace <absolute-path> or set STM32_WORKBENCH_WORKSPACE.',
    );
  }
  if (!path.isAbsolute(configured)) {
    throw new Error('STM32 workspace path must be absolute');
  }
  const realWorkspace = await fs.realpath(configured);
  if (!(await fs.stat(realWorkspace)).isDirectory()) {
    throw new Error('STM32 workspace path is not a directory');
  }
  return realWorkspace;
}

export async function runStdioServer(
  args = process.argv.slice(2),
  env = process.env,
): Promise<void> {
  const workspacePath = await resolveMcpWorkspace(args, env);
  const api = createAgentApi({
    workspacePath,
    serialOwnedByExtension: true,
  });
  const server = createStm32McpServer(api);
  const transport = new StdioServerTransport();
  transport.onerror = (error): void => {
    process.stderr.write(`[STM32 MCP] ${error.message}\n`);
  };
  await server.connect(transport);
  process.stderr.write(`[STM32 MCP] Workspace: ${workspacePath}\n`);
}

if (require.main === module) {
  runStdioServer().catch((error: unknown): void => {
    process.stderr.write(
      `[STM32 MCP] Startup failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
