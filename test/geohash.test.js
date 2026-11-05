import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeGeohash } from '../src/geohash.js';

test('Seam 1: encodeGeohash encodes coordinates to valid precision-9 geohash', () => {
  // Perth CBD
  const perthCbdHash = encodeGeohash(-31.9505, 115.8605, 9);
  assert.equal(perthCbdHash, 'qd66hrx4c');
  assert.equal(perthCbdHash.length, 9);

  // Fremantle
  const freoHash = encodeGeohash(-32.0569, 115.7439, 9);
  assert.equal(freoHash, 'qd639u4ph');
  assert.equal(freoHash.length, 9);

  // Default precision is 9
  assert.equal(encodeGeohash(-31.9505, 115.8605), 'qd66hrx4c');

  // Prefix checks for lower precision
  assert.equal(encodeGeohash(-31.9505, 115.8605, 5), 'qd66h');
});

test('Seam 1: encodeGeohash handles invalid or boundary inputs gracefully', () => {
  assert.throws(() => encodeGeohash(null, 115.8605), /Invalid coordinates/);
  assert.throws(() => encodeGeohash(-95, 115.8605), /Latitude must be between -90 and 90/);
  assert.throws(() => encodeGeohash(-31.95, 190), /Longitude must be between -180 and 180/);
});
