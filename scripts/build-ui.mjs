// Bundles the Lattice UI (React + TypeScript) into dist/ui for packaging.
// esbuild only; type errors are caught separately by tsconfig.ui.json.
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const outdir = path.join(root, "dist", "ui");
fs.mkdirSync(outdir, { recursive: true });

await build({
  entryPoints: [path.join(root, "src", "ui", "main.tsx")],
  bundle: true,
  minify: true,
  format: "iife",
  platform: "browser",
  target: ["chrome110", "firefox115"],
  jsx: "automatic",
  outfile: path.join(outdir, "app.js"),
  logLevel: "warning",
});
for (const file of ["index.html", "app.css", "favicon.svg"]) {
  fs.copyFileSync(path.join(root, "src", "ui", file), path.join(outdir, file));
}
process.stdout.write("ui: bundled to dist/ui\n");
