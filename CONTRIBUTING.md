# Contributing to ShipCheck

Thanks for taking the time to contribute. This document covers the local setup, the checks
CI runs, and what a good pull request looks like.

## Quick start

```bash
git clone https://github.com/shivang-jindal/ShipCheck.git
cd ShipCheck
npm install
npm run dev
```

`npm run dev` starts the API on <http://localhost:4000> and the Vite client on
<http://localhost:5173>. Both hot-reload.

## Before you open a pull request

```bash
npm run verify
```

`verify` runs typecheck, lint, the test suite and a production build, in that order — the
same sequence CI runs. A pull request is not ready while any step fails.

The suite covers the domain engine and the HTTP API (including cross-tenant isolation). Add a test with every behaviour change: domain rules belong in
`server/tests/engine.test.ts`, HTTP contracts in `server/tests/api.test.ts`.

## Style

- TypeScript is strict; `noUncheckedIndexedAccess` is on for `server/` and `shared/`.
- ESLint and Prettier decide formatting — run `npm run format` rather than hand-wrapping.
- Commits follow Conventional Commits: `feat:`, `fix:`, `docs:`, `test:`, `chore:`.
- Keep the diff focused. Unrelated refactors belong in their own pull request.

## Pull requests

1. Fork the repository and branch from `main`.
2. Describe the problem and the approach, not just the change.
3. Link the issue the pull request closes, if there is one.
4. Make sure `npm run verify` passes locally.
5. Keep the pull request small enough to review in one sitting.

## Issues

Use the issue templates for bug reports and feature requests. Include the version or commit
you tested, what you expected, and what happened.

## Security

Do not report vulnerabilities in a public issue. Follow [SECURITY.md](SECURITY.md).

## Code of conduct

Participation is covered by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
