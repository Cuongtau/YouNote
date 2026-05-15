// YouNote build script — produces dist/ with obfuscated JS, plain assets.
//
// Source folder stays load-unpacked-able for dev. Run `npm run build` (or
// `npm run pack` for build + zip) to generate dist/ which is what end users
// or the Web Store should receive.
//
// Tuning notes (CRITICAL — change with care):
//   - transformObjectKeys: false → chrome.* APIs use string-key reflection
//     (e.g. {type: "CONTENT_START"}), renaming keys would break message
//     dispatch silently.
//   - renameGlobals: false → keep top-level binding names stable so the
//     content-script IIFE wiring + chrome.runtime.onMessage listeners work.
//   - controlFlowFlattening: false → 30-50% perf hit unacceptable for the
//     real-time audio dub pipeline.
//   - selfDefending / debugProtection: false → break in extension context
//     and Chrome Web Store reviewers flag them.

"use strict";

const fs = require("fs");
const path = require("path");
const terser = require("terser");
const Obfuscator = require("javascript-obfuscator");

const ROOT = __dirname;
const DIST = path.join(ROOT, "dist");

// Files copied verbatim — manifest, HTML/CSS, locale JSON, image assets.
const COPY_PATHS = [
  "manifest.json",
  "popup.html",
  "popup.css",
  "content.css",
  "_locales",
  "icons",
];

// JS files run through the terser → obfuscator pipeline.
const JS_FILES = ["content.js", "popup.js", "background.js"];

const OBF_OPTS = {
  compact: true,
  identifierNamesGenerator: "mangled-shuffled",
  renameGlobals: false,
  stringArray: true,
  stringArrayThreshold: 0.75,
  stringArrayEncoding: ["base64"],
  stringArrayIndexShift: true,
  stringArrayWrappersCount: 2,
  stringArrayWrappersChainedCalls: true,
  stringArrayWrappersParametersMaxCount: 4,
  stringArrayWrappersType: "function",
  splitStrings: true,
  splitStringsChunkLength: 8,
  numbersToExpressions: true,
  simplify: true,
  unicodeEscapeSequence: false,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  selfDefending: false,
  debugProtection: false,
  transformObjectKeys: false,
  target: "browser",
};

async function buildJs(file) {
  const srcPath = path.join(ROOT, file);
  const dstPath = path.join(DIST, file);
  const src = fs.readFileSync(srcPath, "utf8");

  // Terser: strip comments, dead-code elim, minify
  const min = await terser.minify(src, {
    compress: { passes: 2, drop_debugger: true },
    mangle: { toplevel: false },
    format: { comments: false },
    ecma: 2022,
  });
  if (!min.code) throw new Error("Terser failed for " + file);

  // Obfuscator: string array, identifier rename
  const obf = Obfuscator.obfuscate(min.code, OBF_OPTS).getObfuscatedCode();
  fs.writeFileSync(dstPath, obf);
  const ratio = ((obf.length / src.length) * 100).toFixed(0);
  console.log(`  ✓ ${file.padEnd(15)} ${formatBytes(src.length).padStart(8)} → ${formatBytes(obf.length).padStart(8)}  (${ratio}%)`);
}

function copyRecursive(src, dst) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dst, entry));
    }
  } else {
    fs.copyFileSync(src, dst);
  }
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

(async () => {
  const t0 = Date.now();
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST);

  console.log("Copying assets…");
  for (const p of COPY_PATHS) {
    const src = path.join(ROOT, p);
    if (!fs.existsSync(src)) {
      console.warn(`  ⚠ skipped (missing): ${p}`);
      continue;
    }
    copyRecursive(src, path.join(DIST, p));
    console.log(`  ✓ ${p}`);
  }

  console.log("\nObfuscating JS…");
  for (const f of JS_FILES) await buildJs(f);

  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n✓ Build complete in ${dt}s → ${DIST}`);
  console.log(`  Load via chrome://extensions/ → Developer mode → Load unpacked → select dist/`);
})().catch((e) => {
  console.error("Build failed:", e);
  process.exit(1);
});
