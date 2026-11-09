import { test } from 'node:test';
import assert from 'node:assert/strict';
import { artistKey, artistSortName, buildArtists, filterArtists } from '../src/artists.ts';

const album = (id, title, artist, date = '2026', artwork_id = `art-${id}`) => ({
  id, title, artist, date, track_count: 1, duration: 60, atmos: true, artwork_id,
});
const track = (id, album_id, artist, album_artist, title = id) => ({
  id, album_id, title, artist, album_artist, album: album_id, date: '2026', disc_number: 1,
  track_number: 1, duration: 60, codec: 'eac3', profile: '', atmos: true,
  sample_rate: 48000, channels: 6, bitrate: 768000, artwork_id: 'art',
});
const library = {
  revision: 1,
  albums: [
    album('a1', 'Night Letters', 'Spatial'),
    album('a2', 'Sun Room', 'spatial'),
    album('a3', 'Tidal Forms', 'Lowlight', '2025'),
    album('a4', 'Guests', 'Various Artists', '2024'),
  ],
  tracks: [
    track('t1', 'a1', 'Spatial', 'Spatial'),
    track('t2', 'a2', 'Spatial', 'Spatial'),
    track('t3', 'a3', 'Lowlight', 'Lowlight'),
    track('t4', 'a4', 'Mira Vale', 'Various Artists'),
    track('t5', 'a4', 'Mira Vale', 'Various Artists'),
  ],
};

test('artist keys fold case and whitespace but keep names readable', () => {
  assert.equal(artistKey('  The   Beatles '), 'the beatles');
  assert.equal(artistSortName('The Beatles'), 'beatles');
  assert.equal(artistSortName('Spatial'), 'spatial');
});

test('artists join case-insensitive album credits and keep every album', () => {
  const artists = buildArtists(library);
  const spatial = artists.find(a => a.key === 'spatial');
  assert.equal(spatial.name, 'Spatial');
  assert.deepEqual(spatial.albums.map(a => a.id), ['a1', 'a2']);
  assert.equal(spatial.trackCount, 2);
});

test('guest performers appear with their appearances and own tracks', () => {
  const artists = buildArtists(library);
  const mira = artists.find(a => a.key === 'mira vale');
  assert.equal(mira.albums.length, 0);
  assert.deepEqual(mira.appearsOn.map(a => a.id), ['a4']);
  assert.equal(mira.trackCount, 2);
  assert.equal(mira.artworkId, 'art');
});

test('albums stay grouped with their album artist, sorted for display', () => {
  const artists = buildArtists(library);
  assert.deepEqual(artists.map(a => a.name), ['Lowlight', 'Mira Vale', 'Spatial', 'Various Artists']);
  const various = artists.find(a => a.key === 'various artists');
  assert.deepEqual(various.albums.map(a => a.id), ['a4']);
  assert.equal(various.appearsOn.length, 0);
});

test('artist search matches names and album titles', () => {
  const artists = buildArtists(library);
  assert.deepEqual(filterArtists(artists, 'tidal').map(a => a.name), ['Lowlight']);
  assert.deepEqual(filterArtists(artists, 'mira').map(a => a.name), ['Mira Vale']);
  assert.equal(filterArtists(artists, '').length, 4);
});
