import test from 'node:test';
import assert from 'node:assert/strict';
import { getSavedLocation, saveLocation } from '../src/app.js';

test('App Storage: saveLocation and getSavedLocation persist and retrieve valid coordinates', () => {
  // Mock localStorage in Node
  const storage = new Map();
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) || null,
    setItem: (key, val) => storage.set(key, String(val)),
    removeItem: (key) => storage.delete(key),
    clear: () => storage.clear()
  };

  assert.equal(getSavedLocation(), null);

  const loc = { name: 'Scarborough', postcode: '6019', lat: -31.8942, lng: 115.7571 };
  saveLocation(loc);

  const retrieved = getSavedLocation();
  assert.ok(retrieved);
  assert.equal(retrieved.name, 'Scarborough');
  assert.equal(retrieved.lat, -31.8942);
  assert.equal(retrieved.lng, 115.7571);

  // Clean up
  storage.clear();
});
