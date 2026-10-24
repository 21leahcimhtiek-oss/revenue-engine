// ─────────────────────────────────────────────────────────────────────────────
// Standalone catalog verification.
//
//   node src/seed/verify-catalog.mjs
//
// Proves the fail-closed behaviour for unknown / duplicate / disabled /
// unconfigured price references, and that catalog/products.json holds no price
// ids and no secrets (env var NAMES only).
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadCatalog,
  listProducts,
  getProduct,
  resolveProductByPrice,
  assertProductEnabled,
  CatalogError,
  CATALOG_PATH,
} from '../catalog.js';

const results = [];
function check(label, ok, detail = '') {
  results.push({ label, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}
function expectCode(label, fn, code) {
  try {
    fn();
    check(label, false, `expected CatalogError(${code}), got no error`);
  } catch (err) {
    const ok = err instanceof CatalogError && err.code === code;
    check(label, ok, `code=${err.code}`);
  }
}

console.log('=== CATALOG VERIFICATION ===\n');

// FAKE price ids used only for this check. No real price id is ever referenced.
const ENV = {
  PRICE_STARTER: 'price_TEST_starter',
  PRICE_SKILL_PACK_LITE: 'price_TEST_lite',
  PRICE_SKILL_PACK_STD: 'price_TEST_std',
  PRICE_SKILL_PACK_ELITE: 'price_TEST_elite',
  PRICE_PRO_ANNUAL: 'price_TEST_pro',
  PRICE_MCP_SUITE: 'price_TEST_mcp',
};

console.log('--- 1. catalog file hygiene ---');
const raw = fs.readFileSync(CATALOG_PATH, 'utf8');
const strings = [];
(function walk(n) {
  if (typeof n === 'string') strings.push(n);
  else if (Array.isArray(n)) n.forEach(walk);
  else if (n && typeof n === 'object') Object.values(n).forEach(walk);
})(JSON.parse(raw));
check(
  'no literal price id in any catalog value',
  strings.every((s) => !/^price_[A-Za-z0-9]{6,}$/.test(s)),
);
check(
  'no price_ token anywhere (excluding the field name price_reference)',
  !/price_[A-Za-z0-9]/.test(raw.replace(/price_reference/g, '')),
);
check(
  'no secret-like literal in catalog file',
  !['sk_live', 'sk_test', 'whsec_', 'RESEND_API_KEY=', 'STRIPE_SECRET_KEY=', 'SMTP_PASS=']
    .some((t) => raw.includes(t)),
);
for (const p of loadCatalog({ env: ENV }).products) {
  check(`price_reference is an env var NAME: ${p.price_reference}`, /^[A-Z][A-Z0-9_]*$/.test(p.price_reference));
}

console.log('\n--- 2. products ---');
const products = listProducts({ env: ENV });
check('six baseline products present', products.length === 6, products.map((p) => p.product_id).join(','));
for (const id of ['starter', 'skill_pack_lite', 'skill_pack_std', 'skill_pack_elite', 'pro_annual', 'mcp_suite']) {
  check(`product present: ${id}`, products.some((p) => p.product_id === id));
}

console.log('\n--- 3. unknown price -> null (BLOCKED) ---');
const unknown = resolveProductByPrice('price_TEST_unknown', { env: ENV });
check('resolveProductByPrice(unknown) === null', unknown === null, String(unknown));
check('resolveProductByPrice("") === null', resolveProductByPrice('', { env: ENV }) === null);

console.log('\n--- 4. duplicate price mapping -> throws catalog.duplicate_price_mapping ---');
const dupEnv = { ...ENV, PRICE_SKILL_PACK_STD: 'price_TEST_lite' };
expectCode(
  'two products -> same price id throws',
  () => resolveProductByPrice('price_TEST_lite', { env: dupEnv }),
  'catalog.duplicate_price_mapping',
);
expectCode(
  'loadCatalog() itself throws on duplicate mapping',
  () => loadCatalog({ env: dupEnv }),
  'catalog.duplicate_price_mapping',
);
// duplicate price_reference (same env var name on two products)
const dupRefDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-cat-'));
const dupRefFile = path.join(dupRefDir, 'dup-ref.json');
const dupRaw = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
dupRaw.products.find((p) => p.product_id === 'skill_pack_std').price_reference = 'PRICE_SKILL_PACK_LITE';
fs.writeFileSync(dupRefFile, JSON.stringify(dupRaw));
expectCode(
  'two products sharing a price_reference throws',
  () => loadCatalog({ filePath: dupRefFile, env: ENV }),
  'catalog.duplicate_price_mapping',
);

console.log('\n--- 5. disabled product -> throws catalog.product_disabled ---');
const disDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-cat-'));
const disFile = path.join(disDir, 'disabled.json');
const disRaw = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
disRaw.products.find((p) => p.product_id === 'skill_pack_std').status = 'disabled';
fs.writeFileSync(disFile, JSON.stringify(disRaw));
check(
  'disabled product does NOT resolve to an entitlement',
  resolveProductByPrice('price_TEST_std', { filePath: disFile, env: ENV }) === null,
);
expectCode(
  'assertProductEnabled(disabled) throws catalog.product_disabled',
  () => assertProductEnabled(getProduct('skill_pack_std', { filePath: disFile, env: ENV }), { filePath: disFile, env: ENV }),
  'catalog.product_disabled',
);

console.log('\n--- 6. unconfigured price fails closed PER PRODUCT ---');
const partialEnv = { ...ENV };
delete partialEnv.PRICE_SKILL_PACK_STD;
check(
  'catalog still loads with one unconfigured product',
  listProducts({ env: partialEnv }).length === 6,
);
check(
  'other products still resolve',
  resolveProductByPrice('price_TEST_lite', { env: partialEnv })?.product_id === 'skill_pack_lite',
);
check(
  'unconfigured product does NOT resolve',
  resolveProductByPrice('price_TEST_std', { env: partialEnv }) === null,
);
expectCode(
  'assertProductEnabled(unconfigured) throws catalog.missing_price_configuration',
  () => assertProductEnabled(getProduct('skill_pack_std', { env: partialEnv }), { env: partialEnv }),
  'catalog.missing_price_configuration',
);

console.log('\n--- 7. missing product ---');
expectCode(
  'assertProductEnabled(null) throws catalog.product_not_found',
  () => assertProductEnabled(null, { env: ENV }),
  'catalog.product_not_found',
);

const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`);
if (failed.length) {
  console.log('FAILURES:');
  for (const f of failed) console.log(` - ${f.label} ${f.detail}`);
  process.exit(1);
}
console.log('CATALOG VERIFICATION: OK');
