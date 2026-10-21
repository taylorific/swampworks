# emudhra

A [swamp](https://swamp.club/) extension that checks Linux, macOS and Windows
machines, container images, and running containers for exposure to the
[compromised eMudhra intermediates](https://emudhra.we-have-a-problem.com/).

The private keys of eight eMudhra intermediate CAs (six for TLS, two for code
signing) can be recovered from their certificates. Each intermediate was issued
twice: once by an emSign root and once as a Sectigo cross-sign under AAA
Certificate Services. Browsers and OS vendors blocked them between 17 and 20
October 2026. Many non-browser clients don't check revocation and need a patched
CA bundle or a manual distrust.

`scan` changes nothing. For each target it records whether the target still
trusts the intermediates for TLS and for code signing, why, and what to do about
it.

## Behavior

`@taylor/emudhra/exposure` scans the machine swamp runs on and the images and
containers you list. One `scan` covers every target.

| Global argument | Default  | Description                                                           |
| --------------- | -------- | --------------------------------------------------------------------- |
| `host`          | `true`   | Scan the machine swamp runs on                                        |
| `images`        | `[]`     | Container images to scan, e.g. `["debian:bookworm"]`                  |
| `containers`    | `[]`     | Running containers to scan, by name or ID                             |
| `runtime`       | `docker` | `docker`, or `container` for Apple's container CLI                    |
| `runtimePath`   |          | Path to the runtime CLI; point it at `podman` to use Podman           |
| `bundles`       | `[]`     | More PEM CA bundles to check, on the host and in every container      |
| `toolchains`    | `true`   | On the host, also check Python certifi, pip's bundle, Node.js and Go |

| Method | What it does                                                                                     |
| ------ | ------------------------------------------------------------------------------------------------ |
| `scan` | Check every target and record the results. With `failOnExposed=true`, fail when any is exposed |

Each target gets a `target` resource, named `host`, `image-<image>` or
`container-<name>`:

| Field         | Meaning                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------ |
| `status`      | `exposed` if either usage is exposed, `protected`, or `unknown` when nothing could be checked |
| `tls`         | Exposure for TLS                                                                           |
| `codeSigning` | Exposure for code signing                                                                  |
| `bundles`     | Each PEM bundle found: the roots and intermediates it trusts, and which usages that exposes |
| `native`      | macOS and Windows: the OS verifier's verdict on each of the 16 certificates                |
| `toolchains`  | Node.js and Go versions against the patched releases                                       |
| `findings`    | What was found, one line each                                                              |
| `remediation` | What to do about it, from the disclosure page where it says                                |

A `summary` resource lists the targets by status, plus any that couldn't be
scanned. One target that fails (an image that won't pull) is recorded there and
the scan carries on; the run fails only if every target fails.

## Usage

```sh
swamp extension pull @taylor/emudhra
swamp behavior create @taylor/emudhra/exposure fleet \
  --global-arg 'images=["debian:bookworm", "python:3.12-slim", "alpine:3.22"]'
swamp behavior run fleet scan

# What's exposed, and why
swamp data query 'modelName == "fleet" && name == "summary"' --select content
swamp data query 'modelName == "fleet" && name == "host"' --select content

# In CI: fail the run when anything is exposed
swamp behavior run fleet scan --input failOnExposed=true
```

To check a fleet of machines, run the behavior on each one (swamp running
there, or a swamp worker), or point `bundles` at bundles you've collected.

## How it decides

A compromised intermediate is a risk when a client trusts it, or trusts a root
it chains to:

| Root                     | Chains                                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| AAA Certificate Services | All eight, through the Sectigo cross-signs                                               |
| emSign ECC Root CA - G3  | The six TLS intermediates, through the cross-signed emSign Root TLS CA - G3 that servers send |
| emSign Root TLS CA - G3  | The six TLS intermediates                                                                |
| emSign Root CS CA - G3   | The two code-signing intermediates                                                       |

Every check matches certificates by public key (the SHA-256 of the
SubjectPublicKeyInfo), so any copy of a root or intermediate counts, whoever
signed it.

**PEM bundles.** The scan reads the bundles OpenSSL, curl, Python and friends
use:

- Linux and containers: `/etc/ssl/certs/ca-certificates.crt`,
  `/etc/pki/tls/certs/ca-bundle.crt`,
  `/etc/pki/ca-trust/extracted/pem/{tls,objsign}-ca-bundle.pem`,
  `/etc/ssl/ca-bundle.pem`, `/var/lib/ca-certificates/ca-bundle.pem` and
  `/etc/ssl/cert.pem`.
- macOS: `/etc/ssl/cert.pem` and the Homebrew `ca-certificates` and `openssl@3`
  bundles.
- Windows: Git for Windows' bundle.
- With `toolchains`: Python's `certifi` and the copy pip vendors.

A bundle that holds one of the roots or intermediates is exposed. Distribution
and toolchain bundles count for TLS, Fedora's `objsign` bundle for code signing,
and bundles you name in `bundles` for both. A blocklist (`update-ca-trust`,
`/etc/ca-certificates.conf`) shows up here once it has rebuilt the bundle.

**macOS.** `security verify-cert` evaluates each of the 16 certificates with
the Security framework, which applies Apple's block list. `blocked` means Apple
revoked it; `trusted` means it still validates. The check uses the basic X.509
policy, because a CA certificate can't be checked against the TLS or
code-signing policy without a leaf.

**Windows.** PowerShell builds a chain for each certificate with .NET's
`X509Chain`, which is CryptoAPI: the Root, AuthRoot and Disallowed stores, plus
the automatic root and disallowed-list updates. `ExplicitDistrust` is
`blocked`, a chain that builds is `trusted`, and anything else is `untrusted`.
Revocation checking is off, so the result shows the block list, not whether a
CRL happened to be reachable.

**Toolchains.** Node.js carries its own copy of Mozilla's roots, and the page
lists patched Go releases too. A version older than the fix on its release line
(Node 22.23.4, 24.22.1, 26.12.1; Go 1.26.10, 1.27.3), or on a line with no fix,
counts as TLS exposure.

**Containers.** The scan copies the bundles and `/etc/os-release` out with
`docker cp`, so it needs nothing inside the image, not even a shell. For an
image it creates a container to copy from and removes it afterwards. Apple's
`container cp` only works on a running container, so with `runtime: container`
an image is started with `sleep` as its entrypoint, and an image without
`sleep` can't be scanned that way. Language-specific bundles inside containers
(certifi, Node) aren't found automatically; name them in `bundles`.

## Not covered

- Clients with roots compiled in that the scan can't read or version: rustls
  `webpki-roots`, Electron apps, Bun, uv, Java `cacerts`, and anything statically
  linked. Patched versions are listed on the page.
- Whether a client checks revocation. A revoked intermediate is still `trusted`
  in a bundle, because PEM bundles carry no revocation, and many clients don't
  check it.
- Firefox's and Chrome's own stores. Both blocked the intermediates on
  17 October.

## Tested

- macOS 27 host: system `/etc/ssl/cert.pem` clean, every TLS intermediate
  revoked by the Security framework. The two AAA cross-signs of the
  code-signing intermediates still verify under the basic policy, and the
  Command Line Tools pip bundle still trusts both roots.
- Docker images `debian:bookworm` (no CA bundle installed, so `unknown`),
  `python:3.12-slim` (Debian 13) and `alpine:3.22` (both exposed), and a
  running Alpine container. Exposed verdicts agree with `openssl verify` on the
  page's served chains.
- Apple container CLI 1.4.1 with an Ubuntu 26.04.1 image: protected.

The Windows check is covered by unit tests but hasn't been run on Windows.

## What it runs

```
# host
sw_vers -productVersion                                  # macOS
python3 -c '<print certifi.where() and pip._vendor.certifi.where()>'
node --version
go version
security verify-cert -c <cert> -c <cross-signed root> -l -L -p basic -v    # macOS, x16
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <script> -Data <json>   # Windows

# images (docker; podman via runtimePath)
docker create --name emudhra-scan-<id> --label emudhra-scan=1 <image> true
docker cp -L emudhra-scan-<id>:<path> <temp file>         # each bundle, os-release
docker rm --force emudhra-scan-<id>

# images (Apple container CLI)
container run --detach --rm --name emudhra-scan-<id> --entrypoint sleep <image> 600
container cp emudhra-scan-<id>:<path> <temp file>
container delete --force emudhra-scan-<id>

# running containers
docker cp -L <name>:<path> <temp file>     # or: container cp <name>:<path> <temp file>
```

Certificates and the PowerShell script go in a temporary directory that is
removed afterwards. Nothing is sent over the network except what the OS
verifiers and container runtimes do themselves (Windows may fetch roots from
Windows Update; an image that isn't local gets pulled).

## Data

The 16 intermediates, four roots, and the cross-signed emSign Root TLS CA - G3
are embedded in `extensions/models/_lib/indicators.ts`. They come from the
page's `impacted-intermediates.json`, `roots.json` and `chains/` as fetched on
21 October 2026. The tests check every embedded certificate against the page's
SHA-256 and SPKI fingerprints.

## License

AGPL-3.0-only, with the exception in [COPYING-EXCEPTION](COPYING-EXCEPTION).
See [LICENSE](LICENSE).
