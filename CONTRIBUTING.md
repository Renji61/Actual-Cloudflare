# Contributing

Thanks for helping. This project runs Actual Budget's sync server (core features
only) on Cloudflare Workers and serves the official, unmodified Actual web app.

## Project layout

- `src/worker.ts`: entry point. Static files are served directly; API paths go
  to one SQLite Durable Object.
- `src/server.ts`: the sync server, ported from Actual's `packages/sync-server`.
  Logins, sessions, the file list and sync history live in the Durable Object;
  budget files live in R2.
- `src/storage.ts`: small storage interfaces, so the same logic runs against
  Node's SQLite in tests (`test/harness.ts`).
- `src/vendor/crdt/`: an unmodified copy of Actual's `packages/crdt/src`.

## Development

- `npm install`, then `npm test` (needs Node 22.13+) and `npm run typecheck`.
- `npm run dev` runs the app locally at http://localhost:8787.

## Rules for changes

- Keep request and response behaviour identical to Actual's own sync server:
  paths, status codes and plain-text errors such as `file-has-reset`. The
  unmodified web app depends on it.
- Don't edit `src/vendor/crdt/`. To update it, copy it from a new Actual release.
- Add or update tests in `test/server.test.ts` for every behaviour change.
- Bank sync, OpenID, multiple users and admin features are out of scope.

## Pull requests

- Pull requests are welcome; accepted changes are committed by the maintainer (the Contributors check only accepts the maintainer's commits).
- Keep each pull request focused, and make sure `npm test` and
  `npm run typecheck` pass.
- To follow a new Actual release, see "Updating to a new Actual release" in
  the README.
