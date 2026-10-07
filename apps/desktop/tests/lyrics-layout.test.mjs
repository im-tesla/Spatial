import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampLyricsWidth, defaultLyricsWidth, loadLyricsWidth, maxLyricsWidth } from '../src/lyricsLayout.ts';

test('lyrics width leaves space for navigation and the collection at desktop sizes', () => {
  assert.equal(maxLyricsWidth(960), 335);
  assert.equal(maxLyricsWidth(1280), 600);
  assert.equal(maxLyricsWidth(1920), 600);
  assert.equal(clampLyricsWidth(600, maxLyricsWidth(960)), 335);
  assert.equal(clampLyricsWidth(200, 600), 280);
  assert.equal(clampLyricsWidth(NaN, 600), defaultLyricsWidth);
});

test('saved lyrics width survives reload with safe fallback for unavailable or corrupt storage', () => {
  const previous = globalThis.localStorage;
  try {
    globalThis.localStorage = { getItem: () => '432' };
    assert.equal(loadLyricsWidth(), 432);
    globalThis.localStorage = { getItem: () => 'invalid' };
    assert.equal(loadLyricsWidth(), defaultLyricsWidth);
    globalThis.localStorage = { getItem: () => null };
    assert.equal(loadLyricsWidth(), defaultLyricsWidth);
    globalThis.localStorage = { getItem() { throw new Error('Unavailable'); } };
    assert.equal(loadLyricsWidth(), defaultLyricsWidth);
  } finally { globalThis.localStorage = previous; }
});
