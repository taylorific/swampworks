# @taylor/kvm-host-check-ssh

Runs the same steps as `kvm-host-apply` with `check` instead of `apply`, and
changes nothing. Runs wherever swamp runs and reaches the KVM host over SSH,
with nothing installed on the host.

Source:
[`workflows/workflow-kvm-host-check-ssh.yaml`](../workflows/workflow-kvm-host-check-ssh.yaml).
See the [legend](../../swamp-diagrams/docs/legend.md) for what the shapes and
colours mean.

<!-- swamp-diagram: workflow-taylor-kvm-host-check-ssh -->

```mermaid
---
title: "@taylor/kvm-host-check-ssh"
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
  subgraph job_kvm_host["kvm-host"]
    direction TB
    s_kvm_host_uplink("uplink<br/><small>ssh-kvm-uplink · check</small>"):::state
    s_kvm_host_host("host<br/><small>ssh-kvm-host · check</small>"):::state
    s_kvm_host_pool_default("pool-default<br/><small>ssh-kvm-pool-default · check</small>"):::state
    s_kvm_host_pool_iso("pool-iso<br/><small>ssh-kvm-pool-iso · check</small>"):::state
    s_kvm_host_network("network<br/><small>ssh-kvm-network · check</small>"):::state
  end
  style job_kvm_host fill:transparent,stroke:#9ca3af,stroke-width:1px,stroke-dasharray:4 3
  s_kvm_host_uplink --> s_kvm_host_host
  s_kvm_host_host --> s_kvm_host_pool_default
  s_kvm_host_host --> s_kvm_host_pool_iso
  s_kvm_host_host --> s_kvm_host_network
  classDef state fill:transparent,stroke:#14b8a6,stroke-width:1.5px
  classDef highlight fill:#22c55e33,stroke:#22c55e,stroke-width:1.5px,stroke-width:3px
  classDef failure fill:#ef444426,stroke:#ef4444,stroke-width:1.5px
  classDef dot fill:#3b82f6,stroke:#3b82f6,color:#3b82f6
  classDef dashed fill:transparent,stroke:#14b8a6,stroke-width:1.5px,stroke-dasharray:5 3
  linkStyle 0 stroke:#3b82f6,stroke-width:1.5px
  linkStyle 1 stroke:#3b82f6,stroke-width:1.5px
  linkStyle 2 stroke:#3b82f6,stroke-width:1.5px
  linkStyle 3 stroke:#3b82f6,stroke-width:1.5px
```

<!-- /swamp-diagram -->
