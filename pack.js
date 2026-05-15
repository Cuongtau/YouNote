// pack.js — zip dist/ → ~/younote-vX.Y.Z.zip for distribution.
// Run AFTER `node build.js` (or use `npm run pack` which chains both).

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const archiver = require("archiver");

const VERSION = require("./manifest.json").version;
const DIST = path.join(__dirname, "dist");
const OUT = path.join(os.homedir(), `younote-v${VERSION}.zip`);

if (!fs.existsSync(DIST)) {
  console.error("dist/ not found — run `npm run build` first.");
  process.exit(1);
}

if (fs.existsSync(OUT)) fs.unlinkSync(OUT);

const out = fs.createWriteStream(OUT);
const ar = archiver("zip", { zlib: { level: 9 } });

out.on("close", () => {
  const sizeMB = (ar.pointer() / 1024 / 1024).toFixed(2);
  console.log(`✓ Packed ${OUT} (${sizeMB} MB)`);
  console.log(`  Drop into Chrome Web Store DevConsole, or share for sideload.`);
});
ar.on("warning", (e) => {
  if (e.code === "ENOENT") console.warn(e);
  else throw e;
});
ar.on("error", (e) => { throw e; });

ar.pipe(out);
ar.directory(DIST, false);   // false = files at zip root, not nested under dist/
ar.finalize();
