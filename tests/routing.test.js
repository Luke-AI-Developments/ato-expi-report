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
  const harness = `${pureLogic}\nmodule.exports = { decideNextStep, buildStockIndex, formatAction, buildResultRows, splitRowsByEmail };`;
  vm.runInNewContext(harness, sandbox, { filename: 'decideNextStep.sandbox.js' });

  assert.equal(typeof sandbox.module.exports.decideNextStep, 'function');
  assert.equal(typeof sandbox.module.exports.buildStockIndex, 'function');
  assert.equal(typeof sandbox.module.exports.formatAction, 'function');
  assert.equal(typeof sandbox.module.exports.buildResultRows, 'function');
  assert.equal(typeof sandbox.module.exports.splitRowsByEmail, 'function');
  return sandbox.module.exports;
}

const { decideNextStep, buildStockIndex, formatAction, buildResultRows, splitRowsByEmail } =
  loadDecideNextStep();

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

test('actions cell: "<qty> to <next step>" for every outcome, step text unchanged', () => {
  assert.equal(formatAction(20, 'Edge and drill'), '20 to Edge and drill');
  assert.equal(formatAction(25, 'Finished, no action'), '25 to Finished, no action');
  assert.equal(formatAction('7', 'Drill'), '7 to Drill');
});

test('actions cell: a blank qty leaves just the step', () => {
  assert.equal(formatAction(undefined, 'Drill'), 'Drill');
  assert.equal(formatAction(null, 'Drill'), 'Drill');
  assert.equal(formatAction('  ', 'Drill'), 'Drill');
  assert.equal(formatAction(0, 'Drill'), '0 to Drill');
});
test('finished stock below the qty asked for does not count: routes on the next level', () => {
  const index = buildStockIndex(pgStockRows({ fgQty: 42, drilledQty: 0, rawQty: 741 }));
  assert.equal(decideNextStep({ sku: FG_SKU, qty: 100 }, index, SAMPLE_RULES), 'Edge and drill');
  const empty = buildStockIndex(pgStockRows({ fgQty: 42, drilledQty: 0, rawQty: 0 }));
  assert.equal(decideNextStep({ sku: FG_SKU, qty: 100 }, empty, SAMPLE_RULES), 'Cut, edge and drill');
});

test('finished stock equal to or above the qty asked for -> "Finished, no action"', () => {
  const index = buildStockIndex(pgStockRows({ fgQty: 42, drilledQty: 3, rawQty: 0 }));
  assert.equal(decideNextStep({ sku: FG_SKU, qty: 42 }, index, SAMPLE_RULES), 'Finished, no action');
  assert.equal(decideNextStep({ sku: FG_SKU, qty: 10 }, index, SAMPLE_RULES), 'Finished, no action');
  assert.equal(decideNextStep({ sku: FG_SKU, qty: 43 }, index, SAMPLE_RULES), 'Drill');
});

// Objects built inside the vm sandbox have that realm's prototypes, which
// deepStrictEqual rejects; compare plain JSON copies instead.
const plain = (v) => JSON.parse(JSON.stringify(v));

test('result rows: rows covered by finished stock are dropped, the rest keep order', () => {
  const index = buildStockIndex([
    { sku: '30011111111', qty: 50 }, // covers 20 -> dropped
    { sku: '30022222222', qty: 30 }, // covers exactly 30 -> dropped
    { sku: '30033333333', qty: 10 }, // short for 25 -> kept, 400 stock
    { sku: '40033333333', qty: 9 },
    { sku: '31044444444', qty: 4 }, // no finished stock -> kept, drill
  ]);
  const rows = [
    { sku: '30011111111', description: 'a', qty: 20 },
    { sku: '30033333333', description: 'c', qty: 25 },
    { sku: '30022222222', description: 'b', qty: 30 },
    { sku: '30044444444', description: 'd', qty: 7 },
    { sku: '30099999999', description: 'e', qty: 1 },
  ];
  assert.deepEqual(plain(buildResultRows(rows, index, SAMPLE_RULES)), [
    { sku: '30033333333', description: 'c', actions: '25 to Edge and drill' },
    { sku: '30044444444', description: 'd', actions: '7 to Drill' },
    { sku: '30099999999', description: 'e', actions: 'SKU NOT FOUND' }, // no qty in front
  ]);
});

test('result rows: every row covered -> empty result', () => {
  const index = buildStockIndex([{ sku: FG_SKU, qty: 5 }]);
  assert.deepEqual(plain(buildResultRows([{ sku: FG_SKU, qty: 5 }], index, SAMPLE_RULES)), []);
});
test('rows are split by the email they came from (pairedItem.item)', () => {
  const rowItems = [
    { json: { sku: 'a1' }, pairedItem: { item: 0 } },
    { json: { sku: 'b1' }, pairedItem: { item: 1 } },
    { json: { sku: 'a2' }, pairedItem: [{ item: 0 }] },
    { json: { sku: 'b2' }, pairedItem: { item: 1, input: 0 } },
  ];
  assert.deepEqual(plain(splitRowsByEmail(rowItems, 2)), [
    [{ sku: 'a1' }, { sku: 'a2' }],
    [{ sku: 'b1' }, { sku: 'b2' }],
  ]);
});

test('an email with no rows gets an empty list', () => {
  const rowItems = [{ json: { sku: 'b1' }, pairedItem: { item: 1 } }];
  assert.deepEqual(plain(splitRowsByEmail(rowItems, 2)), [[], [{ sku: 'b1' }]]);
});

test('missing email link: fine with one email, refuses to guess with several', () => {
  const rowItems = [{ json: { sku: 'x' } }];
  assert.deepEqual(plain(splitRowsByEmail(rowItems, 1)), [[{ sku: 'x' }]]);
  assert.throws(() => splitRowsByEmail(rowItems, 2), /refusing to mix senders/);
  assert.throws(() => splitRowsByEmail([{ json: {}, pairedItem: { item: 5 } }], 2), /refusing to mix senders/);
});
