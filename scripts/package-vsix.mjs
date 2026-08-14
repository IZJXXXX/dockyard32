import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectDirectory = resolve(scriptDirectory, "..");
const packageJson = JSON.parse(
  await readFile(join(projectDirectory, "package.json"), "utf8"),
);
const supportedTarget = "darwin-arm64";
const commandLine = parseArguments(process.argv.slice(2));
if (commandLine.target !== supportedTarget) {
  throw new Error(
    `Unsupported VSIX target '${commandLine.target}'. Dockyard32 currently publishes only ${supportedTarget}.`,
  );
}
const outputPath = resolve(
  projectDirectory,
  commandLine.output ??
    `dockyard32-${packageJson.version}-${commandLine.target}.vsix`,
);
const stageDirectory = await mkdtemp(join(tmpdir(), "dockyard32-vsix-"));

function parseArguments(args) {
  let target = supportedTarget;
  let output;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") {
      continue;
    } else if (argument === "--target") {
      target = args[index + 1];
      index += 1;
    } else if (argument === "--out") {
      output = args[index + 1];
      index += 1;
    } else if (argument.startsWith("--")) {
      throw new Error(`Unknown argument: ${argument}`);
    } else if (output === undefined) {
      // Preserve the original positional output-path interface.
      output = argument;
    } else {
      throw new Error(`Unexpected argument: ${argument}`);
    }
  }
  if (typeof target !== "string" || target.length === 0) {
    throw new Error("--target requires a value");
  }
  if (args.includes("--out") && (typeof output !== "string" || output.length === 0)) {
    throw new Error("--out requires a value");
  }
  return { target, output };
}

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
  const bindingsDirectory = join(
    stageDirectory,
    "node_modules",
    "@serialport",
    "bindings-cpp",
  );
  const prebuildsDirectory = join(bindingsDirectory, "prebuilds");
  const prebuildDirectories = await readdir(prebuildsDirectory);
  await Promise.all(
    prebuildDirectories
      .filter((name) => name !== "darwin-x64+arm64")
      .map((name) => rm(join(prebuildsDirectory, name), {
        recursive: true,
        force: true,
      })),
  );
  await Promise.all(
    ["build", "src", "binding.gyp"].map(
      (name) => rm(join(bindingsDirectory, name), {
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
      "--target",
      commandLine.target,
      "--ignore-other-target-folders",
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
