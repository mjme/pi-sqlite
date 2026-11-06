/**
 * Build examples/sample.db: a small, deterministic music-store database for trying pi-sqlite.
 *   node examples/make-sample-db.ts [output-path]
 */
import { rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const out = process.argv[2] ?? new URL("./sample.db", import.meta.url).pathname;
rmSync(out, { force: true });
const db = new DatabaseSync(out);

db.exec(`
PRAGMA foreign_keys = ON;
CREATE TABLE genres (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);
CREATE TABLE artists (
  id      INTEGER PRIMARY KEY,
  name    TEXT NOT NULL,
  country TEXT
);
CREATE TABLE albums (
  id           INTEGER PRIMARY KEY,
  artist_id    INTEGER NOT NULL REFERENCES artists(id),
  title        TEXT NOT NULL,
  release_year INTEGER
);
CREATE TABLE tracks (
  id           INTEGER PRIMARY KEY,
  album_id     INTEGER NOT NULL REFERENCES albums(id),
  genre_id     INTEGER REFERENCES genres(id),
  title        TEXT NOT NULL,
  milliseconds INTEGER NOT NULL,
  unit_price   REAL NOT NULL DEFAULT 0.99
);
CREATE INDEX ix_tracks_album ON tracks(album_id);
CREATE VIEW album_summary AS
  SELECT al.id, ar.name AS artist, al.title, al.release_year,
         count(t.id) AS track_count, round(sum(t.milliseconds) / 60000.0, 1) AS minutes
  FROM albums al
  JOIN artists ar ON ar.id = al.artist_id
  LEFT JOIN tracks t ON t.album_id = al.id
  GROUP BY al.id;
`);

const genres = ["Rock", "Jazz", "Electronic", "Classical", "Hip-Hop", "Folk", "Blues", "Pop"];
const countries = ["UK", "USA", "Germany", "Japan", "Brazil", "Canada", "France", "Sweden", null];
const adjectives = ["Silver", "Midnight", "Electric", "Quiet", "Golden", "Broken", "Northern", "Velvet", "Wild", "Paper"];
const nouns = ["Harbor", "Engines", "Lanterns", "Rivers", "Signals", "Orchard", "Echoes", "Satellites", "Foxes", "Tides"];
const words = ["Night", "Light", "Road", "Fire", "Rain", "Song", "Heart", "Dream", "Stone", "Wave", "Sky", "Home"];

// Deterministic pseudo-random numbers (mulberry32) so every run builds the same database.
let seed = 42;
const rand = () => {
	seed |= 0;
	seed = (seed + 0x6d2b79f5) | 0;
	let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
	t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];

db.exec("BEGIN");
const insGenre = db.prepare("INSERT INTO genres (name) VALUES (?)");
for (const g of genres) insGenre.run(g);

const insArtist = db.prepare("INSERT INTO artists (name, country) VALUES (?, ?)");
for (let i = 0; i < 20; i++) insArtist.run(`The ${adjectives[i % 10]} ${nouns[(i * 3) % 10]}`, pick(countries));

const insAlbum = db.prepare("INSERT INTO albums (artist_id, title, release_year) VALUES (?, ?, ?)");
const insTrack = db.prepare(
	"INSERT INTO tracks (album_id, genre_id, title, milliseconds, unit_price) VALUES (?, ?, ?, ?, ?)",
);
let tracks = 0;
let albumId = 0;
while (tracks < 300) {
	const artistId = 1 + Math.floor(rand() * 20);
	insAlbum.run(artistId, `${pick(words)} ${pick(words)}`, 1965 + Math.floor(rand() * 60));
	albumId++;
	const genreId = 1 + Math.floor(rand() * genres.length);
	const count = Math.min(300 - tracks, 6 + Math.floor(rand() * 8));
	for (let t = 0; t < count; t++) {
		insTrack.run(
			albumId,
			rand() < 0.05 ? null : genreId,
			`${pick(words)} of ${pick(words)}`,
			120_000 + Math.floor(rand() * 300_000),
			rand() < 0.2 ? 1.29 : 0.99,
		);
		tracks++;
	}
}
db.exec("COMMIT");
db.close();
console.log(`Wrote ${out} (20 artists, ${albumId} albums, ${tracks} tracks)`);
