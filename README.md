# seafile stack module

- Module id: `seafile`
- Module repo: `seafile-stack-module`
- Source repo: none declared
- Lifecycle: `active`

## Owned overlays
- `stack.runtime.yaml`
- `stack.config/seafile`

## Dependencies
- `stack-foundation`

## Validation

```sh
./tests/validate.sh
```

## Vendor schema reconciliation

The wrapper invokes the image's `upgrade.check_upgrade()` after upstream bootstrap,
as its standard `start.py` does. Fresh setup installs the vendor SQL baseline and
version stamp; replaying Django's independent migration history on that baseline
can try to recreate `org_last_active_time` (base.0002). No generic `manage.py migrate`,
`--fake` or fabricated migration rows are used. Existing path/schema/marker gates
remain, and vendor failures stop readiness. Protocol fixtures are not installed
schema/upgrade proof; those require the pinned image and real database lifecycle.

## Lifecycle

`active` modules are expected to keep `stack.module.json`, owned overlays, and `tests/validate.sh` in sync.
