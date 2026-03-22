import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path"; 

const OUT_DIR = path.resolve("dist/offline");
const NM_DIR = path.join(OUT_DIR, "node_modules");
const DEP_CACHE_DIR = path.resolve(".dep-cache");
const NODE_VERSION = "v20.19.0";

const NATIVE_MODULES: Record<string, string> = {
  "onnxruntime-node": "1.24.3",
  "onnxruntime-common": "1.24.3",
};

if (fs.existsSync(OUT_DIR)) fs.rmSync(OUT_DIR, { recursive: true });
[OUT_DIR, NM_DIR].forEach((d) => fs.mkdirSync(d, { recursive: true }));

const nativeCached =
  fs.existsSync(DEP_CACHE_DIR) &&
  Object.keys(NATIVE_MODULES).every((m) =>
    fs.existsSync(path.join(DEP_CACHE_DIR, "node_modules", m)),
  );

if (nativeCached) {
  console.log("Native module cache found — skipping npm install.");
} else {
  console.log("Installing native modules via npm...");

  if (fs.existsSync(DEP_CACHE_DIR))
    fs.rmSync(DEP_CACHE_DIR, { recursive: true });
  fs.mkdirSync(DEP_CACHE_DIR, { recursive: true });

  fs.writeFileSync(
    path.join(DEP_CACHE_DIR, "package.json"),
    JSON.stringify(
      { name: "dep-cache", private: true, dependencies: NATIVE_MODULES },
      null,
      2,
    ),
  );

  execSync("npm install --omit=dev --no-audit --no-fund", {
    cwd: DEP_CACHE_DIR,
    stdio: "inherit",
  });

  const napiDir = path.join(DEP_CACHE_DIR, "node_modules/onnxruntime-node/bin");
  if (fs.existsSync(napiDir)) {
    for (const napiVer of fs.readdirSync(napiDir)) {
      const napiPath = path.join(napiDir, napiVer);
      for (const platform of fs.readdirSync(napiPath)) {
        if (platform !== "win32") {
          fs.rmSync(path.join(napiPath, platform), { recursive: true });
        } else {
          for (const arch of fs.readdirSync(path.join(napiPath, "win32"))) {
            if (arch !== "x64") {
              fs.rmSync(path.join(napiPath, "win32", arch), {
                recursive: true,
              });
            }
          }
        }
      }
    }
  }

  const sharpVendor = path.join(DEP_CACHE_DIR, "node_modules/sharp/vendor");
  if (fs.existsSync(sharpVendor)) {
    for (const dir of fs.readdirSync(sharpVendor)) {
      if (!dir.includes("win32-x64")) {
        fs.rmSync(path.join(sharpVendor, dir), { recursive: true });
      }
    }
  }

  console.log("Native modules installed and pruned.");
}

for (const mod of Object.keys(NATIVE_MODULES)) {
  const src = path.join(DEP_CACHE_DIR, "node_modules", mod);
  if (!fs.existsSync(src)) throw new Error(`Native module not found: ${src}`);
  fs.cpSync(src, path.join(NM_DIR, mod), { recursive: true });
}

console.log("Copying @huggingface/transformers...");

const hfSrc = "node_modules/@huggingface/transformers";
const hfDest = path.join(NM_DIR, "@huggingface/transformers");

fs.cpSync(hfSrc, hfDest, {
  recursive: true,
  filter: (src) => {
    const rel = path.relative(hfSrc, src);
    return (
      !/(ort-web|onnxruntime-web|hub|__tests__|\.cache|wasm|esm|browser)/.test(
        rel,
      ) && !/\.(wasm|ort)$/.test(rel)
    );
  },
});

const nestedOrt = path.join(hfDest, "node_modules/onnxruntime-node");
if (fs.existsSync(nestedOrt)) {
  fs.rmSync(nestedOrt, { recursive: true });
  console.log(
    "Removed nested onnxruntime-node from @huggingface/transformers.",
  );
}

console.log("Bundling server with esbuild...");

const sharpStubPath = path.join(OUT_DIR, "_sharp_stub.js");
fs.writeFileSync(sharpStubPath, "module.exports = {};");

const esbuild = await import("esbuild");
await esbuild.build({
  entryPoints: ["server.node.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: path.join(OUT_DIR, "server.cjs"),
  external: Object.keys(NATIVE_MODULES),
  plugins: [
    {
      name: "stub-sharp",
      setup(build: any) {
        build.onResolve({ filter: /^sharp$/ }, () => ({ path: sharpStubPath }));
      },
    },
  ],
  minify: true,
  minifyWhitespace: true,
  minifyIdentifiers: true,
  minifySyntax: true,
  treeShaking: true,
  legalComments: "none",
  sourcemap: false,
  charset: "utf8",
});

const nodeCachePath = path.join(DEP_CACHE_DIR, "node.exe");

if (fs.existsSync(nodeCachePath)) {
  console.log("Node.js cache found — skipping download.");
  fs.copyFileSync(nodeCachePath, path.join(OUT_DIR, "node.exe"));
} else {
  console.log(`Downloading Node.js ${NODE_VERSION}...`);

  const nodeUrl = `https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-win-x64.zip`;
  const zipPath = path.join(DEP_CACHE_DIR, "node.zip");
  const response = await fetch(nodeUrl);
  if (!response.ok)
    throw new Error(`Failed to download Node.js: ${response.statusText}`);

  fs.writeFileSync(zipPath, Buffer.from(await response.arrayBuffer()));

  const extractDir = path.join(DEP_CACHE_DIR, "node-extract");
  fs.mkdirSync(extractDir, { recursive: true });
  execSync(
    `powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force"`,
    { stdio: "inherit" },
  );

  const versionedDir = fs.readdirSync(extractDir)[0]!;
  fs.copyFileSync(
    path.join(extractDir, versionedDir, "node.exe"),
    nodeCachePath,
  );
  fs.rmSync(zipPath);
  fs.rmSync(extractDir, { recursive: true });

  fs.copyFileSync(nodeCachePath, path.join(OUT_DIR, "node.exe"));
  console.log("Node.js downloaded and cached.");
}

if (fs.existsSync(sharpStubPath)) fs.rmSync(sharpStubPath);

console.log("Compiling launcher...");

const launcherSrc = /* ts */ `
import { spawn } from "node:child_process";
import path from "node:path";

// ── Hidden mode ───────────────────────────────────────────────────────────────
// When launched with --hidden, re-launch self detached + hidden then exit so
// the caller (Inno Setup, Task Scheduler) doesn't wait on this process.
if (process.argv.includes("--hidden")) {
  spawn(
    process.execPath,
    process.argv.slice(1).filter(a => a !== "--hidden"),
    { detached: true, windowsHide: true, stdio: "ignore" }
  ).unref();
  process.exit(0);
}

// process.execPath = real on-disk path to start.exe
const dir       = path.dirname(process.execPath);
const nodeExe   = path.join(dir, "node.exe");
const serverJs  = path.join(dir, "server.cjs");
const ollamaExe = path.join(dir, "ollama", "ollama.exe");
const env       = { ...process.env, OLLAMA_MODELS: path.join(dir, "ollama-models") };

console.log("[Launcher] Starting Ollama...");
const ollama = spawn(ollamaExe, ["serve"], { env, detached: false, stdio: "inherit" });

await new Promise(r => setTimeout(r, 2000));

console.log("[Launcher] Starting CiscoSolver...");
const server = spawn(nodeExe, [serverJs], { env, cwd: dir, stdio: "inherit" });

const shutdown = () => {
  try { ollama.kill(); } catch {}
  try { server.kill(); } catch {}
};

process.on("SIGINT",  shutdown);
process.on("SIGTERM", shutdown);
process.on("exit",    shutdown);
server.on("exit", (code) => { shutdown(); process.exit(code ?? 0); });
`;

const launcherPath = path.join(OUT_DIR, "launcher.ts");
fs.writeFileSync(launcherPath, launcherSrc);
execSync(
  `bun build ${launcherPath} --compile --outfile ${path.join(OUT_DIR, "start.exe")} --target bun-windows-x64`,
  { stdio: "inherit" },
);
fs.rmSync(launcherPath);

const dirSize = (dir: string): number => {
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir, { withFileTypes: true }).reduce((acc, f) => {
    const full = path.join(dir, f.name);
    return acc + (f.isDirectory() ? dirSize(full) : fs.statSync(full).size);
  }, 0);
};
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(0)} MB`;

console.log("\nBuild complete:", OUT_DIR);
console.log(
  `   start.exe      ${mb(fs.statSync(path.join(OUT_DIR, "start.exe")).size)}`,
);
console.log(
  `   server.cjs     ${mb(fs.statSync(path.join(OUT_DIR, "server.cjs")).size)}`,
);
console.log(
  `   node.exe       ${mb(fs.statSync(path.join(OUT_DIR, "node.exe")).size)}`,
);
console.log(`   node_modules/  ${mb(dirSize(NM_DIR))}`);
console.log("\n   Next: run setup.iss with Inno Setup.");
console.log(
  "   The installer will download model, vectors, Ollama, and Qwen at install time.",
);
