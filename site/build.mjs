import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "dist");

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

for (const name of ["index.html", "styles.css", "main.js", "mascot.svg"]) {
  cpSync(join(root, name), join(dist, name));
}
cpSync(join(root, "fonts"), join(dist, "fonts"), { recursive: true });

// Project site on zeetree11/Tree-Agent is served from /Tree-Agent/.
// Asset URLs in index.html are relative, so this directory is the base path
// both locally and on GitHub Pages. .nojekyll keeps the fonts and SVG.
writeFileSync(join(dist, ".nojekyll"), "");
console.log("site/dist ready (base path: the directory of index.html, /Tree-Agent/ on GitHub Pages)");
