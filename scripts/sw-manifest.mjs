// The service worker's precache list, after `expo export`: node scripts/sw-manifest.mjs <distDir>
//
// Writes <distDir>/sw-files.json — the app page ("/"), the manifest, icons and favicon, and every
// file under _expo/static/ and assets/ — and stamps a build id (a hash of those files' names and
// contents) into <distDir>/sw.js as its VERSION, so each build installs a new worker that precaches
// it and drops the old one. See public/sw.js. Run by `npm run build:web`, `verify`, `verify:api`
// and the Vercel build.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const dist = process.argv[2];
if (!dist || !fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('usage: node scripts/sw-manifest.mjs <distDir>  (the output of `expo export --platform web`)');
  process.exit(2);
}
const swFile = path.join(dist, 'sw.js');
if (!fs.existsSync(swFile)) {
  console.error(`${swFile} is missing: public/sw.js is copied there by expo export.`);
  process.exit(2);
}

/** Every file under `dir` (relative to dist, with forward slashes), sorted. */
const walk = (dir) => {
  const abs = path.join(dist, dir);
  if (!fs.existsSync(abs)) return [];
  return fs
    .readdirSync(abs, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile())
    .map((e) => path.relative(dist, path.join(e.parentPath ?? e.path, e.name)).split(path.sep).join('/'))
    .sort();
};

const top = ['manifest.json', 'favicon.ico', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png'].filter((f) => fs.existsSync(path.join(dist, f)));
const files = [...top, ...walk('_expo/static'), ...walk('assets')];

// The page is cached as "/" (what every route serves); its content counts in the build id.
const hash = createHash('sha256');
for (const f of ['index.html', ...files]) hash.update(f).update('\0').update(fs.readFileSync(path.join(dist, f)));
const version = `kalo-${hash.digest('hex').slice(0, 16)}`;

fs.writeFileSync(path.join(dist, 'sw-files.json'), JSON.stringify(['/', ...files.map((f) => '/' + encodeURI(f))]));
const sw = fs.readFileSync(swFile, 'utf8');
const stamped = sw.replace(/^const VERSION = '[^']*';/m, `const VERSION = '${version}';`);
if (stamped === sw && !sw.includes(`const VERSION = '${version}';`)) {
  console.error(`${swFile} has no "const VERSION = '...';" line to stamp.`);
  process.exit(1);
}
fs.writeFileSync(swFile, stamped);
console.log(`sw-manifest: ${files.length + 1} files, ${version}`);
