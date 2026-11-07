# @taylor/kvm-vm-ssh

Creates, starts or removes an Ubuntu Server VM from the release's cloud image
and waits until it has an address. Runs wherever swamp runs and reaches the KVM
host over SSH, with nothing installed on the host.

Source:
[`workflows/workflow-kvm-vm-ssh.yaml`](../workflows/workflow-kvm-vm-ssh.yaml).
See the [legend](../../swamp-diagrams/docs/legend.md) for what the shapes and
colours mean.

<!-- swamp-diagram: workflow-taylor-kvm-vm-ssh -->

```mermaid
---
title: "@taylor/kvm-vm-ssh"
config:
  flowchart:
    padding: 20
    curve: linear
    nodeSpacing: 40
    rankSpacing: 45
    wrappingWidth: 320
    subGraphTitleMargin:
      top: 4
      bottom: 12
---
flowchart TD
  subgraph job_vm["vm"]
    direction TB
    s_vm_vm("vm<br/><small>ssh-kvm-vm-${{ inputs.name }} · apply</small>"):::state
  end
  style job_vm fill:transparent,stroke:#9ca3af,stroke-width:1px,stroke-dasharray:4 3
  classDef state fill:transparent,stroke:#14b8a6,stroke-width:1.5px
  classDef highlight fill:#22c55e33,stroke:#22c55e,stroke-width:1.5px,stroke-width:3px
  classDef failure fill:#ef444426,stroke:#ef4444,stroke-width:1.5px
  classDef dot fill:#3b82f6,stroke:#3b82f6,color:#3b82f6
  classDef dashed fill:transparent,stroke:#14b8a6,stroke-width:1.5px,stroke-dasharray:5 3
```

<!-- /swamp-diagram -->
