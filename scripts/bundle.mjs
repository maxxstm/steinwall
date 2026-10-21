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
