import { cp, mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = resolve(scriptDirectory, "..");
const packageJson = JSON.parse(
  await readFile(join(projectDirectory, "package.json"), "utf8"),
);
const outputPath = resolve(
  projectDirectory,
  process.argv[2] ?? `stm32-workbench-${packageJson.version}.vsix`,
);
const stageDirectory = await mkdtemp(join(tmpdir(), "stm32-workbench-vsix-"));

function run(command, args, cwd) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
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

async function copyEntry(name) {
  await cp(join(projectDirectory, name), join(stageDirectory, name), {
    recursive: true,
  });
}

try {
  await run("pnpm", ["run", "compile"], projectDirectory);

  await Promise.all(
    ["out", "media", "LICENSE", "README.md", "pnpm-lock.yaml"].map(
      copyEntry,
    ),
  );

  // VS Code's VSIX extractor does not recreate pnpm's workspace symlinks.
  // Build an isolated, hoisted production tree so every runtime dependency is
  // stored at its real Node.js resolution path inside the archive.
  const stagedPackageJson = structuredClone(packageJson);
  stagedPackageJson.scripts = {};
  await writeFile(
    join(stageDirectory, "package.json"),
    `${JSON.stringify(stagedPackageJson, undefined, 2)}\n`,
  );
  await writeFile(
    join(stageDirectory, ".vscodeignore"),
    "pnpm-lock.yaml\n**/*.map\nnode_modules/**\n",
  );

  await run(
    "pnpm",
    [
      "install",
      "--prod",
      "--frozen-lockfile",
      "--ignore-scripts",
      "--config.node-linker=hoisted",
    ],
    stageDirectory,
  );

  await rm(join(stageDirectory, "node_modules", ".pnpm"), {
    recursive: true,
    force: true,
  });
  await Promise.all(
    [".bin", ".modules.yaml", ".package-map.json", ".pnpm-workspace-state-v1.json"].map(
      (name) => rm(join(stageDirectory, "node_modules", name), {
        recursive: true,
        force: true,
      }),
    ),
  );
  await mkdir(dirname(outputPath), { recursive: true });
  await rm(outputPath, { force: true });

  await run(
    process.execPath,
    [
      join(projectDirectory, "node_modules", "@vscode", "vsce", "vsce"),
      "package",
      "--no-dependencies",
      "--out",
      outputPath,
    ],
    stageDirectory,
  );

  // VSCE deliberately omits node_modules with --no-dependencies. Add the
  // already-flattened production tree under the VSIX extension root.
  await mkdir(join(stageDirectory, "extension"));
  await rename(
    join(stageDirectory, "node_modules"),
    join(stageDirectory, "extension", "node_modules"),
  );
  await run(
    "zip",
    ["-q", "-r", outputPath, "extension/node_modules"],
    stageDirectory,
  );

  console.log(`Packaged ${outputPath}`);
} finally {
  await rm(stageDirectory, { recursive: true, force: true });
}
