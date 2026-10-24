/**
 * Revenue Engine typecheck.
 *
 * The product is plain ESM JavaScript, so "typecheck" means:
 *   1. every source file parses as valid ESM (via `node --check`, which does
 *      NOT execute the module - importing would start the HTTP listener);
 *   2. every LOCAL relative import resolves to a file that exists;
 *   3. every bare import names an installed package;
 *   4. every IDENTIFIER used in a module is either imported, declared locally,
 *      a global, or a property access - so a missing import is caught at build
 *      time rather than at request time.
 *
 * (4) exists because a real defect shipped through this product: `reconcile`
 * was used in server.js without ever being imported. The request-time failure
 * was a 500 on a live admin route. A missing import must fail the gate.
 *
 * It performs NO network call, NO database write, NO secret read, and it
 * starts NO server.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");
const EXTS = [".js", ".mjs"];

const KEYWORDS = new Set([`if`,`for`,`while`,`switch`,`catch`,`return`,`typeof`,`await`,`async`,`function`,`super`,`constructor`,`new`,`delete`,`void`,`in`,`of`,`do`,`else`,`try`,`throw`,`case`,`class`,`const`,`let`,`var`,`import`,`export`,`from`,`as`,`yield`,`with`,`debugger`,`this`,`get`,`set`,`static`,`extends`,`finally`,`switch`]);

const GLOBALS = new Set([
  "console","process","Buffer","global","globalThis","setTimeout","clearTimeout","setInterval",
  "clearInterval","setImmediate","clearImmediate","queueMicrotask","structuredClone","fetch",
  "URL","URLSearchParams","TextEncoder","TextDecoder","AbortController","AbortSignal",
  "Array","Object","String","Number","Boolean","Symbol","BigInt","Math","JSON","Date","RegExp",
  "Error","TypeError","RangeError","SyntaxError","ReferenceError","EvalError","URIError",
  "Map","Set","WeakMap","WeakSet","Promise","Proxy","Reflect","Intl","ArrayBuffer",
  "Uint8Array","Int8Array","Uint8ClampedArray","Uint16Array","Int16Array","Uint32Array",
  "Int32Array","Float32Array","Float64Array","BigInt64Array","BigUint64Array","DataView",
  "parseInt","parseFloat","isNaN","isFinite","encodeURIComponent","decodeURIComponent",
  "encodeURI","decodeURI","escape","unescape","eval","undefined","NaN","Infinity",
  "window","document","navigator","location","history","localStorage","sessionStorage",
  "crypto","performance","WebSocket","Worker","Event","EventTarget","CustomEvent",
]);

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== "node_modules") walk(p, out); }
    else if (EXTS.includes(path.extname(e.name))) out.push(p);
  }
  return out;
}

function stripStringsAndComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") { i += 2; while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; continue; }
    if (c === '"' || c === "'" || c === "`") {
      const q = c; i++;
      while (i < n) { if (src[i] === "\\") { i += 2; continue; } if (src[i] === q) { i++; break; } i++; }
      out += '""'; continue;
    }
    out += c; i++;
  }
  return out;
}

const files = walk(SRC);
const errors = [];
let importCount = 0;
let pkgCount = 0;
let identChecks = 0;

for (const file of files) {
  const rel = path.relative(ROOT, file);

  // 1. parse check - `node --check` parses without executing.
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    const detail = (e.stderr ? e.stderr.toString() : String(e.message)).split("\n").slice(0, 4).join(" | ");
    errors.push(`${rel}: SYNTAX ERROR: ${detail}`);
  }

  const src = fs.readFileSync(file, "utf8");
  const code = stripStringsAndComments(src);

  // 2. relative import resolution
  const re = /(?:^|\n)\s*(?:import|export)[^'"\n]*from\s*["'](\.[^"']+)["']/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    importCount += 1;
    const spec = m[1];
    const base = path.resolve(path.dirname(file), spec);
    const candidates = [base, base + ".js", base + ".mjs", base + ".cjs", path.join(base, "index.js")];
    if (!candidates.some((c) => fs.existsSync(c))) {
      errors.push(`${rel}: UNRESOLVED RELATIVE IMPORT "${spec}"`);
    }
  }

  // 3. bare import availability
  const bare = /(?:^|\n)\s*import[^'"\n]*from\s*["']([^."'][^"']*)["']/g;
  let b;
  while ((b = bare.exec(src)) !== null) {
    pkgCount += 1;
    const pkgName = b[1].startsWith("@") ? b[1].split("/").slice(0, 2).join("/") : b[1].split("/")[0];
    try { import.meta.resolve(pkgName); }
    catch { errors.push(`${rel}: MISSING PACKAGE "${pkgName}"`); }
  }

  // 4. undefined-identifier check.
  // Collect the names this module brings into scope.
  const declared = new Set();
  let im;
  // Default import:  import Database from "better-sqlite3"
  const defImpRe = /^\s*import\s+([A-Za-z_$][\w$]*)\s+from\s+["'][^"']+["']/gm;
  while ((im = defImpRe.exec(src)) !== null) declared.add(im[1]);
  // Namespace import: import * as ns from "..."
  const nsImpRe = /^\s*import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from/gm;
  while ((im = nsImpRe.exec(src)) !== null) declared.add(im[1]);
  // Named imports: import { a, b as c } from "..."
  const namedImpRe = /^\s*import\s*\{([^}]*)\}\s*from/gm;
  while ((im = namedImpRe.exec(src)) !== null) {
    for (const part of im[1].split(",")) {
      const t = part.trim();
      if (!t) continue;
      const as = t.split(/\s+as\s+/);
      const name = (as[1] ?? as[0]).trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name);
    }
  }
  // Mixed: import Default, { named } from "..."
  const mixedImpRe = /^\s*import\s+([A-Za-z_$][\w$]*)\s*,\s*\{([^}]*)\}\s*from/gm;
  while ((im = mixedImpRe.exec(src)) !== null) {
    declared.add(im[1]);
    for (const part of im[2].split(",")) {
      const t = part.trim();
      if (!t) continue;
      const as = t.split(/\s+as\s+/);
      const name = (as[1] ?? as[0]).trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name);
    }
  }
  // Object-literal / class method shorthand:  async send(message) { ... }
  const methodRe = /(?:^|[\s{,])(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{/gm;
  while ((im = methodRe.exec(code)) !== null) declared.add(im[1]);
  // import "x"; (side-effect) contributes nothing.
  // Local declarations.
  const declRe = /\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g;
  while ((im = declRe.exec(code)) !== null) declared.add(im[1]);
  // Destructuring: const { a, b: c } = ...  /  const [a] = ...
  const destrRe = /\b(?:const|let|var)\s*\{([^}]*)\}\s*=/g;
  while ((im = destrRe.exec(code)) !== null) {
    for (const part of im[1].split(",")) {
      const t = part.trim().split(":");
      const name = (t[1] ?? t[0]).trim().replace(/=.*$/, "").trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name);
    }
  }
  const destrArrRe = /\b(?:const|let|var)\s*\[([^\]]*)\]\s*=/g;
  while ((im = destrArrRe.exec(code)) !== null) {
    for (const part of im[1].split(",")) {
      const name = part.trim().split("=")[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name);
    }
  }
  // Function parameters and catch bindings.
  const paramRe = /\bfunction\s*[A-Za-z_$]*\s*\(([^)]*)\)/g;
  while ((im = paramRe.exec(code)) !== null) {
    for (const part of im[1].split(",")) {
      const name = part.trim().split("=")[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name);
    }
  }
  const arrowParamRe = /\(([^()]*)\)\s*=>/g;
  while ((im = arrowParamRe.exec(code)) !== null) {
    for (const part of im[1].split(",")) {
      const name = part.trim().split("=")[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) { declared.add(name); continue; }
      // Destructured parameter: { validator } or { a: b }
      const dm = /^\{([^}]*)\}$/.exec(name);
      if (dm) {
        for (const inner of dm[1].split(",")) {
          const seg = inner.trim().split(":");
          const n2 = (seg[1] ?? seg[0]).trim().split("=")[0].trim();
          if (/^[A-Za-z_$][\w$]*$/.test(n2)) declared.add(n2);
        }
      }
    }
  }
  const catchRe = /\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g;
  while ((im = catchRe.exec(code)) !== null) declared.add(im[1]);
  // for (const x of ...) / for (let i = 0 ...)
  const forRe = /\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  while ((im = forRe.exec(code)) !== null) declared.add(im[1]);
  // for (const [a, b] of ...) - array destructuring in a loop head
  const forArrRe = /\bfor\s*\(\s*(?:const|let|var)\s*\[([^\]]*)\]/g;
  while ((im = forArrRe.exec(code)) !== null) {
    for (const part of im[1].split(",")) {
      const name = part.trim().split("=")[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name);
    }
  }

  // Now look for bare identifier REFERENCES that were never declared.
  // Only consider identifiers in call/argument position to cut noise.
  const useRe = /(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g;
  const seen = new Set();
  while ((im = useRe.exec(code)) !== null) {
    const name = im[1];
    identChecks += 1;
    if (declared.has(name) || GLOBALS.has(name) || KEYWORDS.has(name) || seen.has(name)) continue;
    seen.add(name);
    const line = code.slice(0, im.index).split("\n").length;
    errors.push(`${rel}:${line}: UNDEFINED IDENTIFIER "${name}" (used as a function but never imported or declared)`);
  }
}

console.log(`typecheck: ${files.length} files, ${importCount} relative imports, ${pkgCount} package imports, ${identChecks} identifier uses`);
if (errors.length > 0) {
  console.error(`TYPECHECK FAILED (${errors.length}):`);
  for (const e of errors) console.error("  " + e);
  process.exit(1);
}
console.log("TYPECHECK OK");