# @taylor/libvirt workflows

The [libvirt](../../libvirt/) extension sets up a KVM host and its VMs the way
the kvm-training deck does. Each workflow comes in two forms: one runs on the
KVM host itself through a swamp worker labelled `role=kvm-host`, and an `-ssh`
form runs wherever swamp runs and reaches the host over SSH, with nothing
installed on it. See the [legend](legend.md) for what the shapes and colours
mean.

## Set up a host

`@taylor/kvm-host-apply` checks first that guests can connect the chosen way
(the `uplink` step fails on, for example, Wi-Fi that can't be bridged), then
installs the packages and groups, and creates the image and ISO pools and the
libvirt network.

<!-- swamp-diagram: workflow-taylor-kvm-host-apply -->

```mermaid
---
title: "@taylor/kvm-host-apply"
config:
  themeVariables:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
  flowchart:
    curve: linear
    nodeSpacing: 40
    rankSpacing: 45
    wrappingWidth: 320
    subGraphTitleMargin:
      top: 4
      bottom: 12
---
flowchart TD
  subgraph job_kvm_host["kvm-host · on worker role=kvm-host"]
    direction TB
    s_kvm_host_uplink("uplink<br/><small>kvm-uplink · check</small>"):::state
    s_kvm_host_host("host<br/><small>kvm-host · apply</small>"):::state
    s_kvm_host_pool_default("pool-default<br/><small>kvm-pool-default · apply</small>"):::state
    s_kvm_host_pool_iso("pool-iso<br/><small>kvm-pool-iso · apply</small>"):::state
    s_kvm_host_network("network<br/><small>kvm-network · apply</small>"):::state
  end
  style job_kvm_host fill:transparent,stroke:#9ca3af,stroke-width:1px,stroke-dasharray:4 3
  s_kvm_host_uplink --> s_kvm_host_host
  s_kvm_host_host --> s_kvm_host_pool_default
  s_kvm_host_host --> s_kvm_host_pool_iso
  s_kvm_host_host --> s_kvm_host_network
  classDef state fill:transparent,stroke:#14b8a6,stroke-width:1.5px
  classDef highlight fill:#22c55e33,stroke:#22c55e,stroke-width:1.5px,stroke-width:3px,font-weight:bold
  classDef failure fill:#ef444426,stroke:#ef4444,stroke-width:1.5px
  classDef dot fill:#3b82f6,stroke:#3b82f6,color:#3b82f6
  classDef dashed fill:transparent,stroke:#14b8a6,stroke-width:1.5px,stroke-dasharray:5 3
  linkStyle 0 stroke:#3b82f6,stroke-width:1.5px
  linkStyle 1 stroke:#3b82f6,stroke-width:1.5px
  linkStyle 2 stroke:#3b82f6,stroke-width:1.5px
  linkStyle 3 stroke:#3b82f6,stroke-width:1.5px
```

<!-- /swamp-diagram -->

<!-- swamp-diagram: workflow-taylor-kvm-host-apply-ssh -->

```mermaid
---
title: "@taylor/kvm-host-apply-ssh"
config:
  themeVariables:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
  flowchart:
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
  classDef highlight fill:#22c55e33,stroke:#22c55e,stroke-width:1.5px,stroke-width:3px,font-weight:bold
  classDef failure fill:#ef444426,stroke:#ef4444,stroke-width:1.5px
  classDef dot fill:#3b82f6,stroke:#3b82f6,color:#3b82f6
  classDef dashed fill:transparent,stroke:#14b8a6,stroke-width:1.5px,stroke-dasharray:5 3
  linkStyle 0 stroke:#3b82f6,stroke-width:1.5px
  linkStyle 1 stroke:#3b82f6,stroke-width:1.5px
  linkStyle 2 stroke:#3b82f6,stroke-width:1.5px
  linkStyle 3 stroke:#3b82f6,stroke-width:1.5px
```

<!-- /swamp-diagram -->

## Check a host

`@taylor/kvm-host-check` runs the same steps with `check` instead of `apply`,
and changes nothing.

<!-- swamp-diagram: workflow-taylor-kvm-host-check -->

```mermaid
---
title: "@taylor/kvm-host-check"
config:
  themeVariables:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
  flowchart:
    curve: linear
    nodeSpacing: 40
    rankSpacing: 45
    wrappingWidth: 320
    subGraphTitleMargin:
      top: 4
      bottom: 12
---
flowchart TD
  subgraph job_kvm_host["kvm-host · on worker role=kvm-host"]
    direction TB
    s_kvm_host_uplink("uplink<br/><small>kvm-uplink · check</small>"):::state
    s_kvm_host_host("host<br/><small>kvm-host · check</small>"):::state
    s_kvm_host_pool_default("pool-default<br/><small>kvm-pool-default · check</small>"):::state
    s_kvm_host_pool_iso("pool-iso<br/><small>kvm-pool-iso · check</small>"):::state
    s_kvm_host_network("network<br/><small>kvm-network · check</small>"):::state
  end
  style job_kvm_host fill:transparent,stroke:#9ca3af,stroke-width:1px,stroke-dasharray:4 3
  s_kvm_host_uplink --> s_kvm_host_host
  s_kvm_host_host --> s_kvm_host_pool_default
  s_kvm_host_host --> s_kvm_host_pool_iso
  s_kvm_host_host --> s_kvm_host_network
  classDef state fill:transparent,stroke:#14b8a6,stroke-width:1.5px
  classDef highlight fill:#22c55e33,stroke:#22c55e,stroke-width:1.5px,stroke-width:3px,font-weight:bold
  classDef failure fill:#ef444426,stroke:#ef4444,stroke-width:1.5px
  classDef dot fill:#3b82f6,stroke:#3b82f6,color:#3b82f6
  classDef dashed fill:transparent,stroke:#14b8a6,stroke-width:1.5px,stroke-dasharray:5 3
  linkStyle 0 stroke:#3b82f6,stroke-width:1.5px
  linkStyle 1 stroke:#3b82f6,stroke-width:1.5px
  linkStyle 2 stroke:#3b82f6,stroke-width:1.5px
  linkStyle 3 stroke:#3b82f6,stroke-width:1.5px
```

<!-- /swamp-diagram -->

<!-- swamp-diagram: workflow-taylor-kvm-host-check-ssh -->

```mermaid
---
title: "@taylor/kvm-host-check-ssh"
config:
  themeVariables:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
  flowchart:
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
  classDef highlight fill:#22c55e33,stroke:#22c55e,stroke-width:1.5px,stroke-width:3px,font-weight:bold
  classDef failure fill:#ef444426,stroke:#ef4444,stroke-width:1.5px
  classDef dot fill:#3b82f6,stroke:#3b82f6,color:#3b82f6
  classDef dashed fill:transparent,stroke:#14b8a6,stroke-width:1.5px,stroke-dasharray:5 3
  linkStyle 0 stroke:#3b82f6,stroke-width:1.5px
  linkStyle 1 stroke:#3b82f6,stroke-width:1.5px
  linkStyle 2 stroke:#3b82f6,stroke-width:1.5px
  linkStyle 3 stroke:#3b82f6,stroke-width:1.5px
```

<!-- /swamp-diagram -->

## Create a VM

`@taylor/kvm-vm` creates, starts or removes an Ubuntu Server VM from the
release's cloud image and waits until it has an address.

<!-- swamp-diagram: workflow-taylor-kvm-vm -->

```mermaid
---
title: "@taylor/kvm-vm"
config:
  themeVariables:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
  flowchart:
    curve: linear
    nodeSpacing: 40
    rankSpacing: 45
    wrappingWidth: 320
    subGraphTitleMargin:
      top: 4
      bottom: 12
---
flowchart TD
  subgraph job_vm["vm · on worker role=kvm-host"]
    direction TB
    s_vm_vm("vm<br/><small>kvm-vm-${{ inputs.name }} · apply</small>"):::state
  end
  style job_vm fill:transparent,stroke:#9ca3af,stroke-width:1px,stroke-dasharray:4 3
  classDef state fill:transparent,stroke:#14b8a6,stroke-width:1.5px
  classDef highlight fill:#22c55e33,stroke:#22c55e,stroke-width:1.5px,stroke-width:3px,font-weight:bold
  classDef failure fill:#ef444426,stroke:#ef4444,stroke-width:1.5px
  classDef dot fill:#3b82f6,stroke:#3b82f6,color:#3b82f6
  classDef dashed fill:transparent,stroke:#14b8a6,stroke-width:1.5px,stroke-dasharray:5 3
```

<!-- /swamp-diagram -->

<!-- swamp-diagram: workflow-taylor-kvm-vm-ssh -->

```mermaid
---
title: "@taylor/kvm-vm-ssh"
config:
  themeVariables:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
  flowchart:
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
  classDef highlight fill:#22c55e33,stroke:#22c55e,stroke-width:1.5px,stroke-width:3px,font-weight:bold
  classDef failure fill:#ef444426,stroke:#ef4444,stroke-width:1.5px
  classDef dot fill:#3b82f6,stroke:#3b82f6,color:#3b82f6
  classDef dashed fill:transparent,stroke:#14b8a6,stroke-width:1.5px,stroke-dasharray:5 3
```

<!-- /swamp-diagram -->
