import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTheme, defaultTheme, themeFromPixels } from '../src/theme.ts';

const luminance = value => value.match(/\d+/g).map(Number).map(channel => {
  const s = channel / 255;
  return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4;
}).reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);

test('theme text remains readable across saturated and neutral artwork', () => {
  for (const color of [[240,20,20], [20,240,20], [20,20,240], [240,240,20], [220,20,240], [30,220,240], [0,0,0], [255,255,255], [130,130,130]]) {
    const theme = createTheme(color);
    for (const background of ['--base', '--sidebar', '--player', '--panel', '--wash', '--active-bg']) {
      for (const text of ['--text', '--secondary-text', '--muted', '--dim', '--accent', '--lyric-past']) {
        assert.ok(contrast(theme[text], theme[background]) >= 4.5, `${color}: ${text} on ${background}`);
      }
    }
    assert.ok(contrast(theme['--accent-ink'], theme['--accent']) >= 7);
  }
});

test('dominant artwork area outweighs small vivid highlights', () => {
  const pixels = [...Array(90).fill([80,105,150,255]), ...Array(10).fill([255,20,20,255])].flat();
  assert.deepEqual(themeFromPixels(pixels), createTheme([80,105,150]));
});

test('transparent pixels cannot change the palette and empty artwork has a fallback', () => {
  assert.deepEqual(themeFromPixels([255,0,0,0, 20,150,200,255]), createTheme([20,150,200]));
  assert.deepEqual(themeFromPixels([]), defaultTheme);
});

test('monochrome artwork uses a neutral palette', () => {
  assert.deepEqual(themeFromPixels([0,0,0,255, 255,255,255,255]), createTheme([128,128,128]));
  assert.notDeepEqual(createTheme([20,140,230]), createTheme([230,70,20]));
});
