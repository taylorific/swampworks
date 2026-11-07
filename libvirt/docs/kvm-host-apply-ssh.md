# @taylor/kvm-host-apply-ssh

Checks first that guests can connect the chosen way (the `uplink` step fails on,
for example, Wi-Fi that can't be bridged), then installs the packages and
groups, and creates the image and ISO pools and the libvirt network. Runs
wherever swamp runs and reaches the KVM host over SSH, with nothing installed on
the host.

Source:
[`workflows/workflow-kvm-host-apply-ssh.yaml`](../workflows/workflow-kvm-host-apply-ssh.yaml).
See the [legend](../../swamp-diagrams/docs/legend.md) for what the shapes and
colours mean.

<!-- swamp-diagram: workflow-taylor-kvm-host-apply-ssh -->

```mermaid
---
title: "@taylor/kvm-host-apply-ssh"
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
    s_kvm_host_host("host<br/><small>ssh-kvm-host · apply</small>"):::state
    s_kvm_host_pool_default("pool-default<br/><small>ssh-kvm-pool-default · apply</small>"):::state
    s_kvm_host_pool_iso("pool-iso<br/><small>ssh-kvm-pool-iso · apply</small>"):::state
    s_kvm_host_network("network<br/><small>ssh-kvm-network · apply</small>"):::state
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
