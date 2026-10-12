'use strict';

/**
 * These tests do NOT reimplement the routing logic. They load the exact
 * `jsCode` string shipped inside the "Decide next step" Code node of
 * workflows/ato-expiry-automation.json and evaluate it, so a change to the
 * shipped node is exercised by these tests automatically — there is no
 * separate copy of the function that can drift out of sync.
 */

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const GLUE_MARKER = '/* ---- n8n glue below: not unit-tested here, see README ---- */';

function loadDecideNextStep() {
  const workflowPath = path.join(__dirname, '..', 'workflows', 'ato-expiry-automation.json');
  const workflow = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));
  const codeNode = workflow.nodes.find((n) => n.name === 'Decide next step');
  assert.ok(codeNode, 'Expected a node named "Decide next step" in the workflow');
  const jsCode = codeNode.parameters && codeNode.parameters.jsCode;
  assert.ok(typeof jsCode === 'string' && jsCode.length > 0, 'Code node has no jsCode');
  assert.ok(
    jsCode.includes(GLUE_MARKER),
    'Expected the Code node to separate pure logic from n8n glue with the marker comment'
  );

  // The node's jsCode is: pure function declarations, then a marker, then
  // n8n-specific glue that calls $('Node Name').all() and ends with a
  // top-level `return` (valid inside n8n's own function wrapper, but not
  // valid as a standalone script). We only need the pure functions, so we
  // evaluate everything BEFORE the marker — this is exactly what ships,
  // just without the plumbing that only makes sense inside n8n itself.
  const pureLogic = jsCode.split(GLUE_MARKER)[0];
  const sandbox = { module: { exports: {} }, console };
  const harness = `${pureLogic}\nmodule.exports = { decideNextStep, buildStockIndex };`;
  vm.runInNewContext(harness, sandbox, { filename: 'decideNextStep.sandbox.js' });

  assert.equal(typeof sandbox.module.exports.decideNextStep, 'function');
  assert.equal(typeof sandbox.module.exports.buildStockIndex, 'function');
  return sandbox.module.exports;
}

const { decideNextStep, buildStockIndex } = loadDecideNextStep();

const SAMPLE_RULES = [
  { prefix: '300', stage: 'Finished good', nextStep: 'Finished, no action', checkOrder: 1 },
  { prefix: '310', stage: 'Drilled blank', nextStep: 'Drill', checkOrder: 2 },
  { prefix: '400', stage: 'Raw panel', nextStep: 'Edge and drill', checkOrder: 3 },
  { prefix: 'none', stage: '', nextStep: 'Cut, edge and drill', checkOrder: 4 },
];

// Shared body "26196225" for all fixtures below.
const BODY = '26196225';
const FG_SKU = `300${BODY}`;
const DRILLED_SKU = `310${BODY}`;
const RAW_SKU = `400${BODY}`;

function pgStockRows({ fgQty, drilledQty, rawQty }) {
  // Mirrors what the "Look up stock" Postgres node returns for one SKU's
  // query: flat { sku, qty } rows, one per 300/310/400 code sharing that
  // product's 8-digit body (every product has all three rows seeded, qty
  // possibly 0).
  return [
    { sku: FG_SKU, qty: fgQty },
    { sku: DRILLED_SKU, qty: drilledQty },
    { sku: RAW_SKU, qty: rawQty },
  ];
}

test('outcome 1: finished-good stock > 0 -> "Finished, no action"', () => {
  const index = buildStockIndex(pgStockRows({ fgQty: 5, drilledQty: 0, rawQty: 0 }));
  const result = decideNextStep({ sku: FG_SKU }, index, SAMPLE_RULES);
  assert.equal(result, 'Finished, no action');
});

test('outcome 2: no finished stock, drilled (310) stock > 0 -> "Drill"', () => {
  const index = buildStockIndex(pgStockRows({ fgQty: 0, drilledQty: 3, rawQty: 0 }));
  const result = decideNextStep({ sku: FG_SKU }, index, SAMPLE_RULES);
  assert.equal(result, 'Drill');
});

test('outcome 3: no finished/drilled stock, raw (400) stock > 0 -> "Edge and drill"', () => {
  const index = buildStockIndex(pgStockRows({ fgQty: 0, drilledQty: 0, rawQty: 7 }));
  const result = decideNextStep({ sku: FG_SKU }, index, SAMPLE_RULES);
  assert.equal(result, 'Edge and drill');
});

test('outcome 4: no stock anywhere -> "Cut, edge and drill"', () => {
  const index = buildStockIndex(pgStockRows({ fgQty: 0, drilledQty: 0, rawQty: 0 }));
  const result = decideNextStep({ sku: FG_SKU }, index, SAMPLE_RULES);
  assert.equal(result, 'Cut, edge and drill');
});

test('outcome 5: sku not present in database -> "SKU NOT FOUND"', () => {
  const index = buildStockIndex(pgStockRows({ fgQty: 10, drilledQty: 10, rawQty: 10 }));
  const result = decideNextStep({ sku: '30099999999' }, index, SAMPLE_RULES);
  assert.equal(result, 'SKU NOT FOUND');
});

test('lookup failure: malformed/empty rules throws rather than guessing', () => {
  const index = buildStockIndex(pgStockRows({ fgQty: 5, drilledQty: 0, rawQty: 0 }));
  assert.throws(() => decideNextStep({ sku: FG_SKU }, index, []));
  assert.throws(() => decideNextStep({ sku: FG_SKU }, index, null));
});

test('sparse Postgres result (missing prefix rows) is treated as out of stock there', () => {
  // A real query only returns rows that exist in `stock`; this fixture
  // omits the 400 row entirely rather than sending qty: 0 for it.
  const index = buildStockIndex([
    { sku: FG_SKU, qty: 0 },
    { sku: DRILLED_SKU, qty: 0 },
  ]);
  const result = decideNextStep({ sku: FG_SKU }, index, SAMPLE_RULES);
  assert.equal(result, 'Cut, edge and drill');
});

test('check order from the rules sheet is honoured even when reordered', () => {
  // If the Routing tab says to check 400 before 310, a SKU with both
  // in stock should route on whichever the sheet checks first.
  const reordered = [
    { prefix: '300', stage: 'Finished good', nextStep: 'Finished, no action', checkOrder: 1 },
    { prefix: '400', stage: 'Raw panel', nextStep: 'Edge and drill', checkOrder: 2 },
    { prefix: '310', stage: 'Drilled blank', nextStep: 'Drill', checkOrder: 3 },
    { prefix: 'none', stage: '', nextStep: 'Cut, edge and drill', checkOrder: 4 },
  ];
  const index = buildStockIndex(pgStockRows({ fgQty: 0, drilledQty: 4, rawQty: 9 }));
  const result = decideNextStep({ sku: FG_SKU }, index, reordered);
  assert.equal(result, 'Edge and drill');
});
