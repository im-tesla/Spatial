import { test } from 'node:test';
import assert from 'node:assert/strict';
import { softenPixels } from '../src/backdropPixels.ts';

test('background softening preserves flat colors and does not mutate artwork pixels', () => {
  const pixels = new Uint8ClampedArray(16 * 16 * 4);
  for (let i = 0; i < pixels.length; i += 4) pixels.set([220, 125, 75, 255], i);
  const original = pixels.slice();
  assert.deepEqual(softenPixels(pixels, 16, 16), original);
  assert.deepEqual(pixels, original);
  assert.deepEqual(softenPixels(new Uint8ClampedArray([30, 60, 90, 255]), 1, 1), new Uint8ClampedArray([30, 60, 90, 255]));
});

test('small cached backgrounds soften sharp boundaries without dark alpha halos', () => {
  const pixels = new Uint8ClampedArray(32 * 16 * 4);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 32; x++) pixels.set(x < 16 ? [255, 80, 40, 255] : [0, 0, 0, 0], (y * 32 + x) * 4);
  const result = softenPixels(pixels, 32, 16);
  const edge = (8 * 32 + 16) * 4;
  assert.ok(result[edge + 3] > 0 && result[edge + 3] < 255);
  assert.equal(result[edge], 255);
  assert.equal(result[edge + 1], 80);
  assert.equal(result[edge + 2], 40);
  assert.ok(result[3] > result[edge + 3]);
  assert.throws(() => softenPixels(new Uint8ClampedArray(8), 2, 2), RangeError);
});
