# @taylor/netbox/instance

Runs NetBox with Docker Compose. `status` only reads.

See the [legend](../../swamp-diagrams/docs/legend.md) for what the shapes and
colours mean.

<!-- swamp-diagram: state-machine-taylor-netbox-instance -->

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="diagrams/state-machine-taylor-netbox-instance-dark.svg">
  <img alt="@taylor/netbox/instance" src="diagrams/state-machine-taylor-netbox-instance-light.svg">
</picture>

<!-- /swamp-diagram -->

## Transitions

The diagram is drawn from these lines. Each `from ──[method]──> to` means
running `method` in phase `from` leaves it in phase `to`.

```text
absent ──[start]──> running
running ──[status]──> running
running ──[stop]──> stopped
stopped ──[status]──> stopped
stopped ──[start]──> running
stopped ──[remove]──> removed
running ──[remove]──> removed
```
