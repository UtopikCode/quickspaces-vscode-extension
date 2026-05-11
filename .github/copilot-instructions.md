# QuickSpaces Global AI Instructions

These instructions are global QuickSpaces invariants. They apply to every repository in the ecosystem and must not be violated.

## Architecture Truths

- QuickSpaces is strictly **edge-triggered**.
  - No background polling.
  - No reconciliation loops.
  - No scheduled controllers.
  - No agents.

- QuickSpaces uses a strict separation of concerns:
  - **Control Plane** decides *when* execution happens.
  - **Runner** executes *how* execution happens.
  - **Execution Adapter** implements *what* happens.
  - **Execution Contracts** define capability boundaries only.

- If code does not fit into one of those roles, it is in the wrong repository.

## Security Boundaries

- **User authentication ends at the Control Plane.**
- **Control Plane ↔ Runner uses service-to-service authentication.**
- **Infrastructure credentials belong only to the Runner or execution adapters.**
- No user-facing repo may hold cloud provider credentials or long-lived infrastructure secrets.
- No repo may persist user auth tokens beyond the current session unless explicitly required by the platform and documented.

## Service Model

- The Control Plane is the only component authorized to make decisions about desired state and lifecycle.
- The Runner owns execution and the environment that actually performs it.
- Execution adapters are passive implementations that the Runner can invoke.
- Execution contracts must remain provider-agnostic and cannot contain runtime logic.

## Never Do

- Never add polling, background jobs, reconciliation loops, or autonomous state repair.
- Never let the UI, extension, or control surface execute infrastructure.
- Never move Runner or adapter credentials into the Control Plane, UI, or any other repo.
- Never infer state drift or auto-heal after a failed operation.
- Never weaken `.github/workflows` quality gates; preserve them as authoritative.
- Never introduce agents into the execution model.

## Guiding Question

When in doubt, ask: **Does this repository decide WHEN, execute HOW, implement WHAT, or define capability boundaries?** If not, do not implement it here.
