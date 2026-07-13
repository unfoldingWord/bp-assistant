// Registry + generic TSV codec: round-trip tn and tq fixtures byte-identically,
// and confirm the registry column schemas match the real published files.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const { makeTsvCodec } = require('../src/lib/tsv-resource');
const { RESOURCE_TYPES, getResourceType, isTsvResource, isArticleResource, ROUTE_RESOURCE_TYPE, articleScopeBook } = require('../src/lib/resource-types');
const { parseTnTsv, serializeTnTsv } = require('../src/lib/tn-tsv');

const FIX = path.join(__dirname, 'fixtures');

test('registry families are classified correctly', () => {
  assert.ok(isTsvResource('tn') && isTsvResource('tq'));
  assert.ok(isArticleResource('tw') && isArticleResource('ta'));
  assert.ok(!isTsvResource('tw') && !isArticleResource('tn'));
  assert.throws(() => getResourceType('xx'), /unknown resourceType/);
});

test('route names map to resource types; article scope book is 3 alnum chars', () => {
  assert.strictEqual(ROUTE_RESOURCE_TYPE['translate-notes'], 'tn');
  assert.strictEqual(ROUTE_RESOURCE_TYPE['translate-questions'], 'tq');
  assert.strictEqual(ROUTE_RESOURCE_TYPE['translate-tw'], 'tw');
  assert.strictEqual(ROUTE_RESOURCE_TYPE['translate-ta'], 'ta');
  assert.match(articleScopeBook('tw'), /^[A-Za-z0-9]{3}$/);
  assert.match(articleScopeBook('ta'), /^[A-Za-z0-9]{3}$/);
});

test('tn codec (via generic makeTsvCodec) matches tn-tsv.js exactly', () => {
  const raw = fs.readFileSync(path.join(FIX, 'tn_OBA.tsv'), 'utf8').replace(/\r\n/g, '\n');
  const codec = makeTsvCodec(RESOURCE_TYPES.tn.columns);
  const rows = codec.parse(raw);
  assert.deepStrictEqual(rows, parseTnTsv(raw));               // same parse
  assert.strictEqual(codec.serialize(rows), serializeTnTsv(rows)); // same serialize
  assert.strictEqual(codec.serialize(rows), raw.endsWith('\n') ? raw : raw + '\n');
});

test('tq codec round-trips the real tq_OBA.tsv byte-identically', () => {
  const raw = fs.readFileSync(path.join(FIX, 'tq_OBA.tsv'), 'utf8').replace(/\r\n/g, '\n');
  const codec = makeTsvCodec(RESOURCE_TYPES.tq.columns);
  const rows = codec.parse(raw);
  assert.ok(rows.length > 5);
  // header is exactly the published TQ column order
  assert.strictEqual(codec.HEADER, 'Reference\tID\tTags\tQuote\tOccurrence\tQuestion\tResponse');
  assert.strictEqual(codec.serialize(rows), raw.endsWith('\n') ? raw : raw + '\n');
  // pass-through vs translate column sets are disjoint and cover all columns
  const rt = RESOURCE_TYPES.tq;
  assert.deepStrictEqual([...rt.passThroughColumns, ...rt.translateColumns].sort(), [...rt.columns].sort());
});

test('tq parser rejects a row with the wrong column count', () => {
  const codec = makeTsvCodec(RESOURCE_TYPES.tq.columns);
  const bad = codec.HEADER + '\n1:1\tab12\t\t\t0\tonly six columns here\n';
  assert.throws(() => codec.parse(bad), /expected 7 columns/);
});
