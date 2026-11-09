import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampLyricsOffset, formatLyricsOffset, lyricSeekTime, lyricsTiming } from '../src/lyricsOffset.ts';

test('lyrics offset clamps to ten seconds and snaps to tenths', () => {
  assert.equal(clampLyricsOffset(0), 0);
  assert.equal(clampLyricsOffset(0.26), 0.3);
  assert.equal(clampLyricsOffset(-0.26), -0.3);
  assert.equal(clampLyricsOffset(9.94), 9.9);
  assert.equal(clampLyricsOffset(20), 10);
  assert.equal(clampLyricsOffset(-20), -10);
  assert.equal(clampLyricsOffset(NaN), 0);
  assert.equal(clampLyricsOffset(Infinity), 0);
});

test('lyrics offset labels keep a sign and one decimal place', () => {
  assert.equal(formatLyricsOffset(0), '0.0s');
  assert.equal(formatLyricsOffset(1.24), '+1.2s');
  assert.equal(formatLyricsOffset(-2.5), '-2.5s');
  assert.equal(formatLyricsOffset(12), '+10.0s');
});

test('positive offsets delay lyrics and line seeking lands on the shifted time', () => {
  assert.equal(lyricsTiming(10, 1), 9);
  assert.equal(lyricsTiming(10, -1), 11);
  assert.equal(lyricsTiming(10, 0), 10);
  assert.equal(lyricSeekTime(4, 1.5), 5.5);
  assert.equal(lyricSeekTime(0.2, -1), 0);
  assert.equal(lyricSeekTime(19, 5, 20), 20);
});
