# `@elizaos/synthetic-world`

SW-1 provides a durable SQLite command journal bound to the existing synthetic
environment lease generation. Callers supply the lease store and execute domain
mutations on the guarded SQLite transaction.

SW-2 adds a bounded controller that grants one production boot attempt per
namespace generation through SW-1 before booting the canonical agent runtime
from explicit public identity and storage inputs. The deterministic grant binds
those inputs, so replay cannot boot again and changed inputs conflict. A
successful boot reads its identity back through the runtime's real PGlite
repository before the controller becomes available, while recovery preserves
same-generation journal ownership.

Production runtime repositories use PGlite/Postgres, so production repository
mutation cannot yet share SW-1's `bun:sqlite` transaction. Cross-store atomic
mutation, full manifests, virtual clocks, fault injection, observation ledgers,
subprocess orchestration, a Cloud journal adapter, and production deployment
qualification remain explicitly unavailable through
`SYNTHETIC_WORLD_CAPABILITIES`.
