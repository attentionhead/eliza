# Synthetic world production controller authority

This package owns the durable, generation-fenced command journal used by
synthetic-environment control callers and the bounded production-runtime
controller composed over it. It does not own leases, domain world state, an
HTTP control plane, or a simulator.

## Invariants

- Every command write runs through `withActiveGeneration` on the supplied lease
  store and uses its transaction context.
- A command ID is unique for a namespace across generations. Reuse requires the
  same command type and canonical payload hash.
- A rolled-back `EXECUTING` mutation is `FAILED` with `KNOWN_FAILURE`. Only a
  `COMMITTED` mutation whose response was lost becomes `DIRTY`/`UNKNOWN`.
- Domain mutations are synchronous and use the supplied SQLite transaction so
  their commit is atomic with the journal's `COMMITTED` checkpoint.
- SW-2 boots through `@elizaos/agent`'s canonical `buildInitializedRuntime`
  path from explicit public identity and storage inputs. It never imports a
  deterministic runtime or test service override.
- Before boot, SW-2 executes one deterministic journal grant for the namespace
  generation. Its payload binds every explicit public boot input; replay never
  starts a second runtime, including after teardown or a failed first boot.
- An available controller has read its runtime identity back through the real
  production PGlite adapter. Controller snapshots expose that repository
  identity rather than fabricating parallel world state.
- Production runtime repositories use PGlite/Postgres and cannot be enlisted in
  SW-1's `bun:sqlite` transaction. Do not claim a production repository
  mutation until a shared production transaction adapter exists; never add a
  controller-owned domain table as a substitute.
- Capability reporting must list unavailable surfaces explicitly. This package
  does not claim manifests, virtual time, fault injection, observation ledgers,
  subprocess orchestration, a Cloud adapter, or deployment qualification.

## Verification

Run `bun run --cwd packages/synthetic-world test`, `typecheck`, `lint:check`,
and `build`. Process-crash tests are required for transaction rollback and
commit-before-response recovery.
