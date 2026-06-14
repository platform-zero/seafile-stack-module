# Seafile Runtime Configuration

`runtime-entrypoint.sh` wraps the upstream Seafile bootstrap so the stack can safely manage persistent state.

Seafile writes both filesystem state and MariaDB schemas. The wrapper uses a marker file only after both sides are complete.

## State Handling

The entrypoint handles:

- fresh bootstrap
- existing complete marked state
- complete unmarked state adoption
- empty database schemas left by prior setup
- partial state refusal
- safe repair of incomplete marked state when core schemas are empty

Partial non-empty state is intentionally not repaired automatically. Operators should inspect or purge it explicitly.

## Overlay Handling

The rendered Seahub overlay is inserted between marker comments in `seahub_settings.py`. Re-running the entrypoint replaces the old managed block instead of appending duplicate settings.

## Editing Rules

- Keep filesystem and database completeness checks in sync.
- Do not mark initialization complete until migrations and schema verification pass.
- Treat automatic deletion of non-empty schemas as unsafe unless the safety condition is explicit and tested.

