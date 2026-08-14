import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = resolve(scriptDirectory, '..');
const packageJson = JSON.parse(
  await readFile(join(projectDirectory, 'package.json'), 'utf8'),
);
const archive = resolve(
  projectDirectory,
  process.argv[2] ??
    `stm32-workbench-${packageJson.version}-darwin-arm64.vsix`,
);
const extractionDirectory = await mkdtemp(
  join(tmpdir(), 'stm32-workbench-installed-vsix-'),
);

function run(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: projectDirectory,
      stdio: 'inherit',
      ...options,
    });
    child.once('error', rejectPromise);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(
        new Error(`${command} exited with ${code ?? `signal ${signal}`}`),
      );
    });
  });
}

try {
  await run('unzip', ['-q', archive, '-d', extractionDirectory]);
  await run(
    process.execPath,
    [join(projectDirectory, 'test', 'integration', 'run.cjs')],
    {
      env: {
        ...process.env,
        EXTENSION_DEVELOPMENT_PATH: join(extractionDirectory, 'extension'),
      },
    },
  );
  console.log(`Unpacked VSIX Extension Host test passed: ${archive}`);
} finally {
  await rm(extractionDirectory, { recursive: true, force: true });
}
