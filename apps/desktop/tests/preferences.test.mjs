import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultPreferences, loadPreferences, sanitizePreferences, savePreferences } from '../src/preferences.ts';

function storage(initial) {
  const values = new Map(initial ? [['spatial-preferences:v1', initial]] : []);
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    value: () => values.get('spatial-preferences:v1'),
  };
}

test('preferences default safely without storage', () => {
  assert.deepEqual(loadPreferences(undefined), defaultPreferences);
  assert.deepEqual(loadPreferences({ getItem() { throw new Error('unavailable'); } }), defaultPreferences);
  assert.deepEqual(loadPreferences(storage('not json')), defaultPreferences);
});

test('saved preferences round-trip and invalid fields fall back individually', () => {
  const saved = sanitizePreferences({
    allowStereo: true, exclusiveMode: false, volume: 140, artworkColors: false, reduceMotion: true,
    density: 'compact', trackArtwork: false, albumSort: 'title', lyricsSize: 'large',
    lyricsFollow: false, lyricsBackdrop: false,
  });
  assert.deepEqual(saved, {
    allowStereo: true, exclusiveMode: false, volume: 100, artworkColors: false, reduceMotion: true,
    density: 'compact', trackArtwork: false, albumSort: 'title', lyricsSize: 'large',
    lyricsFollow: false, lyricsBackdrop: false,
  });
  const store = storage();
  savePreferences(saved, store);
  assert.deepEqual(loadPreferences(store), saved);
  const partial = sanitizePreferences({ artworkColors: 'yes', density: 'huge', albumSort: 'artist', lyricsSize: 8 });
  assert.equal(partial.artworkColors, true);
  assert.equal(partial.density, 'comfortable');
  assert.equal(partial.albumSort, 'artist');
  assert.equal(partial.lyricsSize, 'standard');
});
