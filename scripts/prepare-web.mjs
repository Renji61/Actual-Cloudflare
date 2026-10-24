// Copies the official Actual web app into ./public so Cloudflare can serve it,
// and records its version for the /info endpoint.
//
// By default it uses the @actual-app/web package installed by `npm install`.
// To use a web app you built yourself, set ACTUAL_WEB_BUILD to its build folder:
//   ACTUAL_WEB_BUILD=../actual/packages/desktop-client/build npm run prepare-web

import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = join(root, 'public');
const require = createRequire(import.meta.url);

let buildDir = process.env.ACTUAL_WEB_BUILD && resolve(process.env.ACTUAL_WEB_BUILD);
let version = null;

if (!buildDir) {
  let pkgPath;
  try {
    pkgPath = require.resolve('@actual-app/web/package.json', { paths: [root] });
  } catch {
    console.error('Could not find @actual-app/web. Run `npm install` first.');
    process.exit(1);
  }
  buildDir = join(dirname(pkgPath), 'build');
  version = JSON.parse(readFileSync(pkgPath, 'utf8')).version;
} else {
  const pkgPath = join(buildDir, '..', 'package.json');
  if (existsSync(pkgPath)) version = JSON.parse(readFileSync(pkgPath, 'utf8')).version;
}

if (!existsSync(join(buildDir, 'index.html'))) {
  console.error(`No web app build found at ${buildDir}`);
  process.exit(1);
}

rmSync(publicDir, { recursive: true, force: true });
cpSync(buildDir, publicDir, { recursive: true });

// Unknown paths fall back to index.html via "not_found_handling" in
// wrangler.jsonc, so the Netlify-style redirect file is not needed.
rmSync(join(publicDir, '_redirects'), { force: true });

// The app needs these headers for SharedArrayBuffer (cross-origin isolation). The
// official build ships its own _headers; only write ours if the build has none.
if (!existsSync(join(publicDir, '_headers'))) {
  const csp =
    "default-src 'self' blob:; img-src 'self' blob: data:; script-src 'self' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src http: https:;";
  writeFileSync(
    join(publicDir, '_headers'),
    `/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  Content-Security-Policy: ${csp}

/*.wasm
  Content-Type: application/wasm
`,
  );
}

// Cloudflare rejects single static files larger than 25 MiB.
const LIMIT = 25 * 1024 * 1024;
let count = 0;
const tooBig = [];
(function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else {
      count++;
      if (statSync(full).size > LIMIT) tooBig.push(relative(publicDir, full));
    }
  }
})(publicDir);

if (tooBig.length) {
  console.error(`These files are over Cloudflare's 25 MiB limit: ${tooBig.join(', ')}`);
  process.exit(1);
}

if (version) {
  writeFileSync(
    join(root, 'src', 'version.ts'),
    `// Written by scripts/prepare-web.mjs from the installed @actual-app/web package.\nexport const WEB_VERSION = '${version}';\n`,
  );
}

console.log(`Web app ${version ?? '(unknown version)'} copied to public/ (${count} files).`);
