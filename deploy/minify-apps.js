#!/usr/bin/env node
/*
 * minify-apps.js — produce a minified + obfuscated copy of the lionscript library
 * (baja-apps) for a faster-downloading production deploy.
 *
 *   node minify-apps.js <srcDir> <outDir>
 *
 * Lionscript modules are NOT standalone programs: each file is either a function
 * EXPRESSION (`function (graph) { ... }`) or a BARE BODY (`return ...;`) that the
 * engine wraps and exec()s. So we wrap each file into a valid program, minify with
 * terser (whitespace/comments stripped + LOCAL identifier mangling for obfuscation —
 * never property mangling, which would rename engine globals' members), then unwrap.
 *
 * FAIL-SAFE: any file that does not minify AND re-parse identically-shaped is copied
 * through VERBATIM. Non-.js files are always copied as-is. So a bad transform can
 * only ever fall back to the original — it can never ship broken output.
 */
const fs = require('fs');
const path = require('path');

let terser;
try { terser = require('terser'); }
catch (e) {
    console.error('[minify-apps] terser not installed in ' + __dirname + ' — run: npm i terser');
    process.exit(3);
}

const srcDir = process.argv[2];
const outDir = process.argv[3];
if (!srcDir || !outDir) { console.error('usage: node minify-apps.js <srcDir> <outDir>'); process.exit(2); }

// Directories skipped entirely (never descended, never copied): deps, vcs, and the
// huge data/ tree (synced separately by deploy.sh, excluded from the lionscript rsync).
const SKIP_DIRS = new Set(['.git', 'node_modules', 'data', '.vscode', '.devcontainer']);

// MINIFY + OBFUSCATE. Strip comments/whitespace and mangle LOCAL identifiers.
// The lionscript engine loads a module by TEXTUALLY parsing `function (args) {body}`
// (see io-engine.ts preProcessScriptForFunctionalParams, now `/^function\b/`), so:
//   • the outer wrapper must stay a plain `function` — NEVER an arrow (arrows:false;
//     asExpr also rejects any non-`function` output and falls back to verbatim);
//   • do NOT mangle the loader's injected params (lion_engine / resolveScript / map)
//     or the wrapper name (__lsmod) — reserved below;
//   • property names are NEVER mangled (would rename engine-global members).
const TERSER_OPTS = {
    compress: { defaults: true, arrows: false, keep_fnames: true, drop_console: false },
    mangle: { keep_fnames: true, reserved: ['lion_engine', 'resolveScript', 'map', '__lsmod'] },
    format: { comments: false },
};

// Try to minify one lionscript module. Returns the transformed source in the SAME
// shape as the input (function-expression or bare-body), or null to fall back.
async function minifyModule(src) {
    const trimmed = src.replace(/^﻿/, '').trimStart();
    // Shape 1: function expression  →  wrap as an assignment, strip it back off.
    const asExpr = async () => {
        const wrapped = 'var __lsmod = (' + src + '\n);';
        const r = await terser.minify(wrapped, TERSER_OPTS);
        if (r.error || !r.code) return null;
        let out = r.code.trim();
        const pre = 'var __lsmod=';
        if (!out.startsWith(pre)) return null;
        out = out.slice(pre.length).replace(/;$/, '').trim();
        // Must still be a plain function expression — the engine's textual loader
        // requires `function (...) {...}`. Reject anything else (e.g. an arrow) so
        // it falls back to the verbatim original.
        if (!/^\(?function\b/.test(out)) return null;
        // verify it re-parses when wrapped the same way
        const check = await terser.minify('var __v=(' + out + '\n);', { compress: false, mangle: false });
        if (check.error) return null;
        return out;
    };
    // Shape 2: bare body (starts with `return`/statements) → wrap in a function.
    const asBody = async () => {
        const wrapped = 'function __lsmod(){\n' + src + '\n}';
        const r = await terser.minify(wrapped, TERSER_OPTS);
        if (r.error || !r.code) return null;
        let out = r.code.trim();
        const m = out.match(/^function __lsmod\(\)\{([\s\S]*)\}$/);
        if (!m) return null;
        const body = m[1];
        const check = await terser.minify('function __v(){\n' + body + '\n}', { compress: false, mangle: false });
        if (check.error) return null;
        return body;
    };

    try {
        // Pick the shape from the first meaningful token, but try the other as a backup.
        if (/^function\b/.test(trimmed) || /^\(/.test(trimmed)) {
            return (await asExpr()) ?? (await asBody());
        }
        return (await asBody()) ?? (await asExpr());
    } catch (e) {
        return null;
    }
}

let total = 0, minified = 0, copied = 0, fallback = 0;

async function walk(rel) {
    const absSrc = path.join(srcDir, rel);
    const entries = fs.readdirSync(absSrc, { withFileTypes: true });
    for (const ent of entries) {
        const childRel = path.join(rel, ent.name);
        if (ent.isDirectory()) {
            if (SKIP_DIRS.has(ent.name)) continue;   // skip entirely (see SKIP_DIRS)
            fs.mkdirSync(path.join(outDir, childRel), { recursive: true });
            await walk(childRel);
        } else if (ent.isFile()) {
            const absOut = path.join(outDir, childRel);
            fs.mkdirSync(path.dirname(absOut), { recursive: true });
            if (ent.name.endsWith('.js')) {
                total++;
                const src = fs.readFileSync(path.join(srcDir, childRel), 'utf8');
                const out = await minifyModule(src);
                if (out != null && out.length > 0) { fs.writeFileSync(absOut, out); minified++; }
                else { fs.writeFileSync(absOut, src); fallback++; }
            } else {
                fs.copyFileSync(path.join(srcDir, childRel), absOut);
                copied++;
            }
        }
    }
}

(async () => {
    fs.mkdirSync(outDir, { recursive: true });
    await walk('.');
    console.log(`[minify-apps] ${minified}/${total} .js minified, ${fallback} shipped verbatim (fallback), ${copied} non-js copied → ${outDir}`);
})();
