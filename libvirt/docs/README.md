# @taylor/libvirt diagrams

Each workflow comes in two forms: one runs on the KVM host itself through a
swamp worker labelled `role=kvm-host`, and an `-ssh` form runs wherever swamp
runs and reaches the host over SSH.

| Workflow      | On the host                         | Over SSH                                    |
| ------------- | ----------------------------------- | ------------------------------------------- |
| Set up a host | [kvm-host-apply](kvm-host-apply.md) | [kvm-host-apply-ssh](kvm-host-apply-ssh.md) |
| Check a host  | [kvm-host-check](kvm-host-check.md) | [kvm-host-check-ssh](kvm-host-check-ssh.md) |
| Create a VM   | [kvm-vm](kvm-vm.md)                 | [kvm-vm-ssh](kvm-vm-ssh.md)                 |

The [`@taylor/libvirt/vm`](vm.md) page shows a VM's own lifecycle; the host,
pool, network and uplink behaviors follow the same `check` / `apply` pattern.
