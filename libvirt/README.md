# libvirt

A [swamp](https://swamp.club/) extension that sets up an Ubuntu host to run
KVM/QEMU virtual machines with [libvirt](https://libvirt.org/), following the
[kvm-training](https://github.com/taylorific/kvm-training) deck.

Each type manages one kind of resource with the same two methods as
[`@adam/cfgmgmt`](https://swamp-club.com/extensions/@adam/cfgmgmt): `check`
saves what would change without touching anything, and `apply` makes the
changes, then reads the host again to prove it converged. Both save `state` data
named after the host, with a `status` of `compliant`, `non_compliant`, `applied`
or `failed`. A failure is saved too, then fails the step, so the steps that
depend on it don't run.

## Types

| Type                      | Methods                                                  | Manages                                                                         |
| ------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `@taylor/libvirt/uplink`  | `check`                                                  | Which ways of connecting guests can work on the host's uplink; netplan mistakes |
| `@taylor/libvirt/host`    | `check`, `apply`                                         | The QEMU, libvirt and virtinst packages; the user in `libvirt` and `kvm`        |
| `@taylor/libvirt/pool`    | `check`, `apply`                                         | A directory storage pool, started and autostarted                               |
| `@taylor/libvirt/network` | `check`, `apply`                                         | A libvirt network: `nat`, `bridge`, `macvtap` or `routed`                       |
| `@taylor/libvirt/vm`      | `check`, `apply`, `snapshot`, `revert`, `deleteSnapshot` | An Ubuntu Server guest from the release's cloud image, configured by cloud-init |

### Reaching the host

Every type takes the same connection arguments, named as `@adam/cfgmgmt` names
them:

| Argument           | Default | Description                                                                         |
| ------------------ | ------- | ----------------------------------------------------------------------------------- |
| `nodeHost`         |         | A hostname, `user@host` or `~/.ssh/config` name to reach over SSH; unset means here |
| `nodeUser`         |         | SSH user; otherwise ssh's own configuration decides                                 |
| `nodePort`         |         | SSH port                                                                            |
| `nodeIdentityFile` |         | Private key for SSH                                                                 |
| `sshOptions`       | `[]`    | More ssh arguments, e.g. `["-J", "bastion"]`                                        |
| `become`           | `true`  | Run commands that need root with `sudo -n` (passwordless sudo)                      |

Leave `nodeHost` unset when the step runs on the KVM host itself, as it does
when it's placed on a [swamp worker](#agent-swamp-serve-and-a-worker) there. Set
it to reach the host over SSH from wherever swamp runs. Over SSH the commands
share one connection; if it drops, the step fails and saves nothing rather than
reporting tools as missing.

### `@taylor/libvirt/host`

| Argument   | Default             | Description                                      |
| ---------- | ------------------- | ------------------------------------------------ |
| `packages` | the release's       | Packages to install                              |
| `user`     | the connecting user | User to add to the groups                        |
| `groups`   | `[libvirt, kvm]`    | Groups the user should be in; only ever added to |

| Release | Packages                                                                                  |
| ------- | ----------------------------------------------------------------------------------------- |
| 24.04   | `qemu-kvm`, `libvirt-daemon-system`, `virtinst`, `ca-certificates`, `curl`, `genisoimage` |
| 26.04   | `qemu-system-hwe`, `libvirt-daemon-system-hwe`, `virtinst`, `ca-certificates`, `curl`     |

`curl` fetches cloud images for `vm`. On 24.04, `genisoimage` builds the
cloud-init seed, since virt-install 4.1.0 can't.

Groups are added with `usermod -aG` and never removed. `@adam/cfgmgmt/user`'s
`groups` is the user's whole list, so giving it `[libvirt, kvm]` would take the
user out of `sudo`. A missing `/dev/kvm` fails `apply`: turn on VT-x or AMD-V in
the firmware.

### `@taylor/libvirt/pool`

| Argument    | Default                                                                 |
| ----------- | ----------------------------------------------------------------------- |
| `name`      | required                                                                |
| `target`    | `/var/lib/libvirt/images` for `default`, else `/var/lib/libvirt/<name>` |
| `ensure`    | `present`; `absent` stops and undefines it, keeping the files           |
| `autostart` | `true`                                                                  |
| `uri`       | `qemu:///system`                                                        |

Ubuntu 26.04's `-hwe` packages create `/var/lib/libvirt/images` but no pool, so
the deck defines `default` there and `iso` beside it.

### `@taylor/libvirt/network`

| Argument    | Used by     | Description                                                            |
| ----------- | ----------- | ---------------------------------------------------------------------- |
| `name`      | all         | Network name                                                           |
| `mode`      | all         | `nat`, `bridge`, `macvtap` or `routed`                                 |
| `bridge`    | bridge, nat | The host's Linux bridge (bridge); libvirt's own bridge (nat, optional) |
| `interface` | macvtap     | The wired interface guests share                                       |
| `address`   | nat, routed | The host's address on the guest subnet, e.g. `192.168.123.1/24`        |
| `ensure`    | all         | `present` or `absent`                                                  |
| `autostart` | all         | `true`                                                                 |

Before defining a `bridge` or `macvtap` network it reads the host's uplink and
fails, with the reason, when the mode can't work there. It never changes the
host's own network: a bridge has to exist before a bridge network can use it.

### `@taylor/libvirt/vm`

| Argument            | Default                 | Description                                                                      |
| ------------------- | ----------------------- | -------------------------------------------------------------------------------- |
| `name`              | required                | VM name, also its hostname                                                       |
| `ensure`            | `present`               | `absent` shuts it down and undefines it with its NVRAM and storage               |
| `running`           | `true`                  | Keep it running                                                                  |
| `release`           | `26.04`                 | `24.04` or `26.04`                                                               |
| `imageUrl`          | cloud-images.ubuntu.com | A mirror's copy; its directory needs `SHA256SUMS` unless `imageSha256` is set    |
| `imageSha256`       |                         | Pin the image instead of reading `SHA256SUMS`                                    |
| `pool`              | `default`               | Pool the disk goes in, as `<name>.qcow2`                                         |
| `diskSize`          | `32G`                   |                                                                                  |
| `memory`, `vcpus`   | `2048` MiB, `2`         |                                                                                  |
| `network`           | `default`               | libvirt network to attach to                                                     |
| `osVariant`         | `ubuntu-lts-latest`     |                                                                                  |
| `sshAuthorizedKeys` | `[]`                    | Public keys for the `ubuntu` user                                                |
| `password`          |                         | Password for `ubuntu`, with SSH password logins on; better from a vault          |
| `packages`          | `[]`                    | More packages; `qemu-guest-agent` is always added                                |
| `cloudInit`         | `auto`                  | `virt-install` (`--cloud-init`, newer than 4.1.0) or `seed-iso` (a `cidata` ISO) |
| `waitForIp`         | `true`                  | Wait for the guest agent to report an address                                    |
| `timeoutSeconds`    | `900`                   | How long to wait                                                                 |

`apply` follows the deck's "Spin up your first VM":

1. Fetch the release's cloud image into `/var/lib/libvirt/cloud-images`, checked
   against Ubuntu's `SHA256SUMS`; a verified copy is reused.
2. `qemu-img convert` it into the pool and `qemu-img resize` it.
3. Write meta-data and user-data: the SSH keys, the optional password, and
   `qemu-guest-agent`, which the deck installs by hand.
4. `virt-install --import --boot uefi` with `--cloud-init …,disable=on`, or on
   24.04 with a `cidata` seed ISO attached as a CD-ROM.
5. Wait for `virsh domifaddr --source agent` to report an address, which works
   on a bridged network where libvirt's DHCP leases can't help.

The `state` data has the VM's `state`, `memory`, `vcpus`, `network`, `mac` and
`ip`. An existing VM is started if it's stopped but never rebuilt: different
`memory`, `vcpus` or `network` make `check` `non_compliant` and `apply` fail
with the reason. `snapshot`, `revert` and `deleteSnapshot` take `snapshot`
(default `clean`) and save the VM's snapshot list.

### `@taylor/libvirt/uplink`

`check` reads the host's interfaces, the uplink (the interface holding the
default route, and its ports when it's a bridge), the netplan renderer, whether
the host is itself a VM, Docker and `br_netfilter`, and saves `advice`: for each
mode a `status` (`recommended`, `ok`, `caution` or `unavailable`) and the
reasons. Given `mode`, it fails when that mode is `unavailable`. Netplan
mistakes, such as a Wi-Fi interface under `ethernets:`, make it `non_compliant`.

| Uplink                 | NAT         | Bridge                         | macvtap                       | Routed                   |
| ---------------------- | ----------- | ------------------------------ | ----------------------------- | ------------------------ |
| Wired, already bridged | ok          | recommended                    | unavailable: port of a bridge | ok                       |
| Wired, not bridged     | ok          | recommended; moves the address | ok; host can't reach guests   | ok                       |
| Wi-Fi                  | recommended | unavailable                    | unavailable                   | ok, router needs a route |
| Host is itself a VM    | recommended | caution                        | caution                       | ok                       |

Wi-Fi can't carry guests on the LAN: an access point only accepts frames from
the MAC address that associated with it, and the kernel won't add a Wi-Fi
interface in managed mode to a bridge. macvtap on Wi-Fi starts without error,
but the guests never get an address. VirtualBox gets around this by rewriting
MAC addresses in its kernel driver, which libvirt doesn't do. On Wi-Fi use NAT,
with port forwards or a VPN such as Tailscale in the guest for inbound access,
or a routed network with a static route on the router.

Turning a wired uplink into a bridge moves the host's address, so over SSH a
mistake cuts you off. `netplan try` would roll it back, but it refuses a bridge
with `parameters:` such as `stp` or `forward-delay`; apply the change behind a
timer that restores the old config, and stop the timer once you can log in
again.

## Two ways to run it

The repository has the same workflow two ways. Both check or converge a host in
five steps: `uplink`, then `host`, then the two pools and the network.

### Agent: `swamp serve` and a worker

`@taylor/kvm-host-check` and `@taylor/kvm-host-apply` place their steps on a
worker labelled `role=kvm-host`, so the method code runs on the KVM host itself,
while data, vaults and guards stay with `swamp serve`.

```bash
# On the orchestrator: a worker enrollment token, then serve (TLS is required
# off loopback)
swamp worker token create kvm1 --duration 7d
swamp serve --host 10.0.0.5 --cert-file serve.crt --key-file serve.key \
  --auth-mode token --admins user:<your id>

# On the KVM host, with swamp installed and `swamp auth login` done
swamp worker connect wss://10.0.0.5:4000 --token-file enroll.token \
  --server-token-file conn.token --ca-cert ca.crt \
  --label role=kvm-host --cache-dir ~/.config/swamp-worker/cache

# From anywhere
swamp workflow run @taylor/kvm-host-apply --server wss://10.0.0.5:4000 \
  --input mode=bridge --input bridge=br0
```

### Agentless: SSH

`@taylor/kvm-host-check-ssh` and `@taylor/kvm-host-apply-ssh` run where swamp
runs and set `nodeHost` on every step. The host needs only `sshd` and
passwordless sudo.

```bash
swamp workflow run @taylor/kvm-host-apply-ssh --input host=taylor@10.63.45.217
```

They use their own behavior names (`ssh-kvm-*`). A virtual behavior keeps the
arguments a step gave it, so if both workflows shared names, the agent workflow
would inherit `nodeHost` and its worker would SSH to itself.

### VMs

`@taylor/kvm-vm` (on the worker) and `@taylor/kvm-vm-ssh` create, start or
remove one VM. Each VM gets its own behavior, `kvm-vm-<name>`.

```bash
swamp workflow run @taylor/kvm-vm --server wss://10.0.0.5:4000 \
  --input-file vm.json   # {"name": "ubuntu-server-2604", "network": "host-network",
                         #  "sshAuthorizedKeys": ["ssh-ed25519 AAAA… me"]}
swamp data query 'modelName == "kvm-vm-ubuntu-server-2604"' --select content.ip
```

## What it runs

On the host, through `ssh` when `nodeHost` is set, and with `sudo -n` where
noted:

- `host`: `hostname`, `cat /etc/os-release`, `test -c /dev/kvm`,
  `dpkg-query -W`, `id -un`, `id -nG`; apply adds `sudo apt-get update`,
  `sudo apt-get install -y` and `sudo usermod -aG`.
- `pool`: `sudo virsh` `pool-list`, `pool-info`, `pool-dumpxml`; apply adds
  `pool-define-as`, `pool-build`, `pool-start`, `pool-autostart`, and
  `pool-destroy`/`pool-undefine` to redefine or remove.
- `network`: `sudo virsh` `net-list`, `net-info`, `net-dumpxml`; apply writes
  the XML to a `mktemp` file and runs `net-define`, `net-start`,
  `net-autostart`, and `net-destroy`/`net-undefine` to redefine or remove.
  bridge and macvtap also read the uplink, as below.
- `uplink`: `ip -j` for links, addresses and the default route, a `sh -c` loop
  listing `/sys/class/net/*/wireless`, `sudo -n netplan get all`, `nmcli` or
  `networkctl` when netplan can't be read, `systemd-detect-virt`,
  `systemctl is-active docker` and
  `cat /proc/sys/net/bridge/bridge-nf-call-iptables`.
- `vm`: `sudo virsh` `list`, `dominfo`, `domiflist`, `domifaddr --source agent`;
  apply adds `uname -m`, `curl` for `SHA256SUMS` and the image,
  `sudo sha256sum`, `sudo qemu-img convert` and `resize`, `pool-dumpxml`,
  `pool-refresh`, `mktemp` files for user-data and meta-data,
  `virt-install --version`, `genisoimage` or `xorriso -as mkisofs` for a seed
  ISO, `sudo virt-install`, and `start`, `shutdown`, `destroy` and
  `undefine --nvram --remove-all-storage`. The snapshot methods run
  `snapshot-create-as`, `snapshot-revert`, `snapshot-delete`, `snapshot-list`
  and `snapshot-current`.

## Development

```bash
~/.swamp/deno/deno check extensions/models/*.ts extensions/models/_lib/*.ts
~/.swamp/deno/deno test --no-config --allow-all extensions/
```

## License

AGPL-3.0-or-later with the Swamp Extension and Definition Exception; see
[LICENSE](LICENSE), [COPYING](COPYING) and
[COPYING-EXCEPTION](COPYING-EXCEPTION).
