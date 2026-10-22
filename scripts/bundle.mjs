// Bundles the per-tool-call entry points into single files: one module to load instead of ~15
// keeps hook startup minimal. Runs after tsc and overwrites its thin dist/bin/*.js wrappers.
import { build } from "esbuild";

await build({
  entryPoints: { hook: "src/bin/hook.ts", "codex-hook": "src/bin/codex-hook.ts", statusline: "src/bin/statusline.ts" },
  outdir: "dist/bin",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: true,
  legalComments: "none",
  logLevel: "warning",
});

// SteinWall Lite for Codex: one self-contained script inside the skill folder of the hook-free plugin.
await build({
  entryPoints: { "steinwall-lite": "src/bin/codex-lite.ts" },
  outdir: "lite/codex/skills/steinwall-lite/scripts",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  minify: true,
  legalComments: "none",
  logLevel: "warning",
});
