# TC Hunter

*Get hired. Rise like Tim Cook.*

A household job-hunting workspace for two people, each with their own private workspace. Tell it who you are once; it finds fitting jobs, prepares an honest tailored application for each, and tracks everything. Nothing is ever submitted without your approval of that specific application.

TC Hunter is an independent personal project and is not affiliated with, endorsed by, or connected to Tim Cook or Apple.

- **Design of record:** [docs/design.md](docs/design.md)
- **Home server setup:** [docs/deploy.md](docs/deploy.md)
- **Status:** Phase 0 (foundations) built, awaiting review.

## Develop

Needs Node 22 and PostgreSQL 16.

```sh
npm install
cp .env.example .env                       # fill in; see comments
set -a; . ./.env; set +a                   # load it into this shell
npm run db:migrate                         # as the owner role
cp .env apps/web/.env.local                # the web app reads its own copy
npm run dev                                # http://localhost:3000
```

## Test

```sh
TEST_ADMIN_URL=postgres://postgres:postgres@localhost:5432/postgres npm test
npm run typecheck
```

The tests create a throwaway database (`tc_hunter_test`) and run every query as the same restricted role the app uses, so the isolation and guard-rail tests exercise the real database rules.
