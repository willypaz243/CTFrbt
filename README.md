# CTFrbt

> Retro terminal-themed CTF platform — orbital-ctf aesthetic meets macOS terminal.

## Stack

| Layer     | Technology                |
| --------- | ------------------------- |
| Framework | Next.js 15 (App Router)   |
| Runtime   | Node.js                   |
| Database  | PostgreSQL + Prisma ORM   |
| Auth      | NextAuth.js (Credentials) |
| Styles    | Vanilla CSS (CRT effects) |
| UI        | React 19                  |

## Development

```bash
# Install dependencies
pnpm install

# Set up environment
cp .env.example .env

# Generate Prisma client
pnpm prisma:generate

# Run database migrations
pnpm prisma:migrate

# Start dev server
pnpm dev
```

## Testing

Vitest, split into two projects: **unit** (no database) and **integration**
(runs against an ephemeral Postgres). Integration tests need the `postgres-test`
container up and a `.env.test` file.

```bash
# One-time: create the test env file
cp .env.test.example .env.test

# Start the ephemeral test database (tmpfs, port 5434)
docker compose up -d postgres-test

# Run everything (migrations are applied automatically)
pnpm test

# Or target one project
pnpm test:unit
pnpm test:integration

# Watch mode
pnpm test:watch
```

| Script                  | What it runs                         |
| ----------------------- | ------------------------------------ |
| `pnpm test`             | All tests once (unit + integration)  |
| `pnpm test:unit`        | Unit only — fast, no database        |
| `pnpm test:integration` | Integration only — needs the test DB |
| `pnpm test:watch`       | Re-run on change                     |

Tests live in `tests/` (`unit/`, `integration/`, plus shared `helpers/` and
`setup/`). The test database is disposable — the suite truncates every table
between tests, so never point `DATABASE_URL` at real data.

## Dynamic challenges

Dynamic challenges ship a Docker image; each team gets a private container
with a unique flag and its own random port (and SSH credentials for SSH
challenges). Authoring guide — Dockerfile rules, uploaded files, runtime
env vars in `.sh` entrypoints, lifecycle:
[docs/dynamic-challenges.md](./docs/dynamic-challenges.md).

## Deployment

CI/CD via GitHub Actions (Docker Hub → SSH → Docker Swarm on the server),
environments per branch, orchestrator setup, env vars and the pre-event
checklist: [docs/deployment.md](./docs/deployment.md).

## Event pause

Administrators can open **Admin → Game Configuration → Event pause**, choose
1–1440 minutes and select **Pause event**. **Resume event** ends the break early.
The event must already be active. The deadline is capped at the competition end;
pausing never extends the schedule. Saving schedule settings preserves the pause.

Participants see a pause screen instead of event views. During the break the
server rejects flag submissions and hint purchases, and blocks challenge content,
files, scoreboard, teams, announcements, rules and notifications. Administrators
retain read access, but cannot submit flags or buy hints during the break either.
Authentication remains available. Rejected submissions are not queued.

In this fork, participant instance status, start and stop requests are also
blocked during the pause; administrators retain instance read access and Fleet
controls. By default, existing containers keep running. To suspend them too,
select **Also suspend participant instances** before pausing. This is optional:
the event pause does not depend on Docker when the option is off.

The independent instance controller freezes managed participant containers using
Docker pause/unpause, without recreating them. Their flags, ports and filesystem
state remain intact. Remaining TTL is preserved by adding the suspension window
(including queue/retry time) once on successful resume; the competition end time
never changes. Admin test instances, downloaded files and external services are
excluded. Frozen containers retain their allocated memory; this does not free RAM.
Existing client connections may time out and require reconnecting.

Suspension is gradual, not instantaneous. The admin panel reports the controller
heartbeat, suspended/pending counts and errors. The controller handles four
operations per batch, with 250 ms between full successful batches and 2 seconds
when idle or retrying. Requests have a 3-second timeout. A start admitted just
before the pause can finish afterwards and is caught by the next batch. Do not
claim all services are suspended until the pending/running counts reach zero.

State is persisted before calling the engine. Idempotent retries recover from a
controller restart or an uncertain network response; automatic resume needs no
open browser. If the controller is offline, containers may remain suspended past
the deadline until it recovers, while the platform resumes on schedule. Failed
operations remain visible and retry; missing containers are marked stopped.
This requires a Docker-compatible engine supporting pause/unpause. Local Docker
is verified; the production rootless Podman environment still needs verification.

For local development, start the orchestrator and controller in separate terminals
from the repository root (the app remains `pnpm dev --port 3001`):

```bash
HOST=127.0.0.1 PORT=7474 node --env-file=.env --import tsx apps/orchestrator/src/index.ts
pnpm instances:pause-worker
```

Both Compose files include the controller service using the app image, with no
Docker socket. Apply migrations and restart the app/orchestrator after updating.
The legacy Swarm manifest does not include the orchestrator or controller: wire
both services and their environment into that deployment before enabling the
option. No production deployment is performed by these changes.

The policy lives in `src/lib/instance-pause-controller.ts`, the process entry in
`scripts/instance-pause-worker.ts`, and the engine adapter in `src/lib/orchestrator.ts`
plus the authenticated `/instances/:id/pause` and `/resume` orchestrator endpoints.
Willy can replace the engine adapter without changing the event pause controls.

`GameConfig.pausedUntil` persists the deadline in PostgreSQL. Resume is determined
from server time, with no cron job or per-player server timer. Enforcement reads
the database rather than a process-local cache, so workers share the same state.
Scoring transactions take a shared database lock; pause/resume takes its exclusive
counterpart. Already admitted transactions finish before pause confirmation; new
transactions recheck the state before recording submissions or spending points.
Reads already in flight may finish. Existing scores and purchased hints survive.

`EventStateProvider` shares one status poll every 10 seconds per visible browser
tab between timers, the pause screen and admin controls. It also refreshes on
focus and at the resume deadline. Thus an open screen can take up to one polling
interval plus network time to hide; server enforcement does not wait for the UI.
Transient connection errors retain the last known state. No load benchmark is
claimed by the functional tests.

Implementation locations:

- `src/lib/game-window.ts` and `src/lib/event-pause.ts`: state and enforcement.
- `src/app/api/admin/game/route.ts`: admin pause/resume (`PATCH`).
- `src/components/admin/EventPauseControls.tsx`: controls beside event timing.
- `src/components/event/`: shared browser state and pause screen.
- `tests/integration/event-pause.test.ts`: permissions, boundaries, content gates,
  concurrency, preserved points and reactivation.

Apply migrations and regenerate the Prisma client before starting the updated
server; restart an already running dev server after changing the Prisma schema:

```bash
pnpm exec prisma migrate deploy
pnpm prisma:generate
pnpm dev
```

Legacy `/uploads/...` URLs now pass through middleware to authenticated download
handlers, with `private, no-store` responses. Deployments must forward these paths
to Next.js; do not serve that directory directly through a proxy/CDN. Previously
cached or downloaded files cannot be recalled. Independent challenge services are
not stopped by hiding their links and need separate access controls if required.

To check the UI locally, use separate admin and participant browser sessions,
pause for one minute and keep the participant dashboard open. Confirm its content
hides, then returns automatically; also test early resume. Check a known file URL
and direct API submissions during the break. Automated checks:

```bash
pnpm exec vitest run --project integration tests/integration/event-pause.test.ts tests/integration/instance-pause.test.ts
```

Pause controls also support **+5 / −5 minutes** while paused. Adjustments apply
atomically to the existing resume deadline, including concurrent admin actions;
they never change the competition end time. Shortening cannot end the pause:
use **Resume event** when five minutes or less remain. Extensions are capped at
the event end and 24 hours from the current server time.

On the participant pause screen, **Check status** shows a pending indicator and
reports whether the event remains paused or the request failed. Background
refreshes stay silent and retain the last known state if the connection fails.

## License

See [LICENSE](./LICENSE).
