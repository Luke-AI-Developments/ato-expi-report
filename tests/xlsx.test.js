'use strict';

/**
 * Loads the exact `jsCode` of the "Build xlsx" Code node from
 * workflows/ato-expiry-automation.json (everything before the glue marker)
 * and checks the workbook it writes: a valid zip, every cell bordered, and
 * each column at least as wide as its longest value.
 */

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');

const GLUE_MARKER = '/* ---- n8n glue below: not unit-tested here, see README ---- */';

function loadBuildXlsx() {
  const workflowPath = path.join(__dirname, '..', 'workflows', 'ato-expiry-automation.json');
  const workflow = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));
  const node = workflow.nodes.find((n) => n.name === 'Build xlsx');
  assert.ok(node, 'Expected a node named "Build xlsx" in the workflow');
  assert.equal(node.type, 'n8n-nodes-base.code');
  const jsCode = node.parameters.jsCode;
  assert.ok(jsCode.includes(GLUE_MARKER), 'Expected the glue marker in the Build xlsx node');
  const sandbox = { module: { exports: {} }, Buffer };
  vm.runInNewContext(`${jsCode.split(GLUE_MARKER)[0]}\nmodule.exports = { buildXlsx };`, sandbox);
  return sandbox.module.exports.buildXlsx;
}

const buildXlsx = loadBuildXlsx();

// Reads a stored (uncompressed) zip: name -> text, checking each CRC.
function unzipStored(buf) {
  const files = {};
  let at = 0;
  while (buf.readUInt32LE(at) === 0x04034b50) {
    const method = buf.readUInt16LE(at + 8);
    const crc = buf.readUInt32LE(at + 14);
    const size = buf.readUInt32LE(at + 18);
    const nameLen = buf.readUInt16LE(at + 26);
    const extraLen = buf.readUInt16LE(at + 28);
    const name = buf.subarray(at + 30, at + 30 + nameLen).toString('utf8');
    const data = buf.subarray(at + 30 + nameLen + extraLen, at + 30 + nameLen + extraLen + size);
    assert.equal(method, 0, `${name} should be stored`);
    assert.equal(zlib.crc32(data), crc, `${name} CRC mismatch`);
    files[name] = data.toString('utf8');
    at += 30 + nameLen + extraLen + size;
  }
  assert.equal(buf.readUInt32LE(buf.length - 22), 0x06054b50, 'missing end-of-central-directory record');
  return files;
}

const HEADER = ['sku', 'description', 'actions'];
const ROWS = [
  ['30040995108', '18 Anth 651x824 CAD-409951', '117 to Drill'],
  ['30099999999', 'Tiled Panel (unknown SKU test row)', 'SKU NOT FOUND'],
];

test('workbook is a valid zip with the parts Excel needs', () => {
  const files = unzipStored(buildXlsx('Results', HEADER, ROWS));
  for (const part of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml',
    'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml']) {
    assert.ok(part in files, `missing ${part}`);
  }
  assert.match(files['xl/workbook.xml'], /<sheet name="Results"/);
});

test('every cell, header included, uses the thin all-sides border style', () => {
  const files = unzipStored(buildXlsx('Results', HEADER, ROWS));
  assert.match(files['xl/styles.xml'],
    /<border><left style="thin">.*<right style="thin">.*<top style="thin">.*<bottom style="thin">/);
  assert.match(files['xl/styles.xml'], /<xf [^>]*borderId="1"[^>]*applyBorder="1"/);
  const cells = files['xl/worksheets/sheet1.xml'].match(/<c [^>]*>/g);
  assert.equal(cells.length, HEADER.length * (ROWS.length + 1));
  for (const c of cells) assert.match(c, / s="1"/);
});

test('each column is at least as wide as its longest value', () => {
  const files = unzipStored(buildXlsx('Results', HEADER, ROWS));
  const widths = [...files['xl/worksheets/sheet1.xml'].matchAll(/<col [^>]*width="([\d.]+)"/g)]
    .map((m) => Number(m[1]));
  assert.equal(widths.length, HEADER.length);
  HEADER.forEach((h, c) => {
    const longest = Math.max(h.length, ...ROWS.map((r) => String(r[c]).length));
    assert.ok(widths[c] >= longest, `column ${h}: width ${widths[c]} < ${longest}`);
  });
});

test('text is escaped and numbers stay numbers', () => {
  const files = unzipStored(buildXlsx('Results', ['a', 'b'], [['x & <y> "z"', 12.5]]));
  const sheet = files['xl/worksheets/sheet1.xml'];
  assert.match(sheet, /x &amp; &lt;y&gt; &quot;z&quot;/);
  assert.match(sheet, /<c r="B2" s="1"><v>12.5<\/v><\/c>/);
});
