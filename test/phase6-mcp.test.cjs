const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const {
  createStm32McpServer,
  resolveMcpWorkspace,
} = require('../out/mcp/server.js');
const { STM32_MCP_TOOL_NAMES } = require('../out/mcp/tools.js');

const stdioServerPath = process.env.STM32_MCP_SERVER_PATH
  ? path.resolve(process.env.STM32_MCP_SERVER_PATH)
  : path.join(__dirname, '..', 'out', 'mcp', 'server.js');

async function makeExecutable(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, { mode: 0o755 });
}

async function createWorkspace(root, buildFails = false) {
  const workspace = path.join(root, buildFails ? 'Broken_F407' : 'F407_Project');
  const tools = path.join(root, 'tools');
  const cmake = path.join(tools, 'cmake');
  const programmer = path.join(tools, 'STM32_Programmer_CLI');
  const ninja = path.join(tools, 'ninja');
  const gcc = path.join(tools, 'arm-none-eabi-gcc');
  await fs.mkdir(path.join(workspace, '.vscode'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.22)\n');
  await fs.writeFile(
    path.join(workspace, `${path.basename(workspace)}.ioc`),
    'Mcu.CPN=STM32F407VGT6\nMcu.Family=STM32F4\n',
  );
  const cmakeScript = `#!${process.execPath}\n` +
    `'use strict';\n` +
    `const fs = require('node:fs'); const path = require('node:path');\n` +
    `const args = process.argv.slice(2);\n` +
    `if (args[0] === '-S') { const build = args[3]; fs.mkdirSync(build, { recursive: true }); fs.writeFileSync(path.join(build, 'CMakeCache.txt'), 'cache'); process.exit(0); }\n` +
    `if (args[0] === '--build') { ${buildFails ? `process.stderr.write("Core/Src/main.c:42:10: error: 'xxx' undeclared\\n"); process.exit(2);` : `const build = args[1]; fs.mkdirSync(build, { recursive: true }); fs.writeFileSync(path.join(build, '${path.basename(workspace)}.elf'), 'ELF'); process.stdout.write('Built target\\n'); process.exit(0);`} }\n` +
    `process.exit(3);\n`;
  const programmerScript = `#!${process.execPath}\n` +
    `'use strict'; const args = process.argv.slice(2);\n` +
    `if (args[0] === '-l') { process.stdout.write('Device Index : 0\\nSerial number : MCPSTLINK1\\nFirmware version : V2J45S7\\nBoard : STLINK-V3SET\\n'); process.exit(0); }\n` +
    `if (args.includes('-w')) { process.stdout.write('Device name : STM32F407VG\\nDownload verified successfully\\n'); process.exit(0); }\n` +
    `if (args.includes('-rst')) { process.stdout.write('Device name : STM32F407VG\\nReset mode : Software reset\\n'); process.exit(0); }\n` +
    `process.exit(4);\n`;
  await Promise.all([
    makeExecutable(cmake, cmakeScript),
    makeExecutable(programmer, programmerScript),
    makeExecutable(ninja, '#!/bin/sh\nexit 0\n'),
    makeExecutable(gcc, '#!/bin/sh\nexit 0\n'),
  ]);
  await fs.writeFile(
    path.join(workspace, '.vscode', 'settings.json'),
    JSON.stringify({
      'dockyard32.tools.cmakePath': cmake,
      'dockyard32.tools.ninjaPath': ninja,
      'dockyard32.tools.armGccPath': gcc,
      'dockyard32.tools.programmerPath': programmer,
    }),
  );
  return workspace;
}

async function connectStdio(workspace) {
  const client = new Client({ name: 'phase6-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [stdioServerPath, '--workspace', workspace],
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
  await client.connect(transport);
  return { client, transport, getStderr: () => stderr };
}

function structured(result) {
  assert.ok(result.structuredContent, 'tool should return structuredContent');
  return result.structuredContent;
}

test('MCP workspace resolver accepts the legacy environment variable', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dockyard32-legacy-env-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  assert.equal(
    await resolveMcpWorkspace([], { STM32_WORKBENCH_WORKSPACE: root }),
    await fs.realpath(root),
  );
});

test('stdio MCP starts, lists only expected tools, and keeps logs off stdout', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stm32-mcp-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = await createWorkspace(root);
  const connection = await connectStdio(workspace);
  t.after(() => connection.client.close());

  const listed = await connection.client.listTools();
  assert.deepEqual(
    listed.tools.map((tool) => tool.name).sort(),
    [...STM32_MCP_TOOL_NAMES].sort(),
  );
  assert.ok(listed.tools.every((tool) => typeof tool.description === 'string'));
  assert.ok(listed.tools.every((tool) => !/shell|exec|command/i.test(tool.name)));

  const project = structured(await connection.client.callTool({
    name: 'stm32_get_project_info', arguments: {},
  }));
  assert.equal(project.success, true);
  assert.equal(project.data.mcu, 'STM32F407VGT6');
  assert.match(connection.getStderr(), /Workspace:/u);

  const serial = structured(await connection.client.callTool({
    name: 'stm32_get_serial_status', arguments: {},
  }));
  assert.equal(serial.success, false);
  assert.equal(serial.error.code, 'SERIAL_OWNED_BY_EXTENSION');
});

test('stdio MCP completes Build, Flash, Reset, Build & Run, and Last Run', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stm32-mcp-actions-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = await createWorkspace(root);
  const { client } = await connectStdio(workspace);
  t.after(() => client.close());

  const build = structured(await client.callTool({ name: 'stm32_build', arguments: {} }));
  assert.equal(build.success, true);
  const flash = structured(await client.callTool({ name: 'stm32_flash', arguments: {} }));
  assert.equal(flash.success, true);
  assert.equal(flash.data.verify, true);
  const reset = structured(await client.callTool({ name: 'stm32_reset', arguments: {} }));
  assert.equal(reset.success, true);
  const run = structured(await client.callTool({ name: 'stm32_build_and_run', arguments: {} }));
  assert.equal(run.success, true);
  assert.equal(run.data.build.success, true);
  assert.equal(run.data.flash.success, true);
  assert.equal(run.data.reset.success, true);
  const lastRun = structured(await client.callTool({ name: 'stm32_get_last_run', arguments: {} }));
  assert.equal(lastRun.success, true);
  assert.equal(lastRun.data.runId, run.data.runId);
});

test('stdio MCP returns structured Build diagnostics and remains alive', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stm32-mcp-build-fail-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = await createWorkspace(root, true);
  const { client } = await connectStdio(workspace);
  t.after(() => client.close());

  const result = structured(await client.callTool({ name: 'stm32_build', arguments: {} }));
  assert.equal(result.success, false);
  assert.equal(result.error.code, 'BUILD_FAILED');
  assert.equal(result.data.errors[0].line, 42);
  const project = structured(await client.callTool({
    name: 'stm32_get_project_info', arguments: {},
  }));
  assert.equal(project.success, true, 'server should survive a failed action tool');
});

test('MCP schemas reject invalid arguments without crashing the server', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stm32-mcp-schema-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = await createWorkspace(root);
  const { client } = await connectStdio(workspace);
  t.after(() => client.close());

  const invalid = await client.callTool({
    name: 'stm32_get_serial_log', arguments: { maxLines: 5000, extra: true },
  });
  assert.equal(invalid.isError, true);
  assert.match(invalid.content[0].text, /validation|invalid/i);
  const listed = await client.listTools();
  assert.equal(listed.tools.length, STM32_MCP_TOOL_NAMES.length);
});

test('MCP maps busy and Tool exceptions while keeping protocol alive', async (t) => {
  const baseResult = { success: true, data: { value: true } };
  const api = {
    getProjectInfo: async () => { throw new Error('tool exploded'); },
    getToolStatus: async () => baseResult,
    getProbeInfo: async () => baseResult,
    getSerialStatus: async () => baseResult,
    getSerialLog: async () => baseResult,
    getLastRun: async () => baseResult,
    build: async () => ({ success: false, error: { code: 'OPERATION_BUSY', message: 'busy', stage: 'build' } }),
    flash: async () => baseResult,
    reset: async () => baseResult,
    buildAndRun: async () => baseResult,
    sendSerial: async () => baseResult,
    waitSerial: async () => baseResult,
  };
  const server = createStm32McpServer(api);
  const client = new Client({ name: 'in-memory-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });

  const exception = structured(await client.callTool({
    name: 'stm32_get_project_info', arguments: {},
  }));
  assert.equal(exception.error.code, 'INTERNAL_ERROR');
  const busy = structured(await client.callTool({ name: 'stm32_build', arguments: {} }));
  assert.equal(busy.error.code, 'OPERATION_BUSY');
  assert.equal((await client.listTools()).tools.length, STM32_MCP_TOOL_NAMES.length);
});
