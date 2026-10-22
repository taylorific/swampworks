# emudhra

**Find where the leaked eMudhra certificate authority keys can still be used
against you.** This [swamp](https://swamp.club/) extension checks Linux, macOS
and Windows machines, container images and running containers for trust in
eight eMudhra intermediate certificate authorities (CAs) whose private keys
are public. The keys were
[disclosed on 20 October 2026](https://emudhra.we-have-a-problem.com/).

## What happened

A certificate authority's private key is what makes its certificates
trustworthy: anything signed with it is accepted by every client that trusts
the CA. The keys of eight eMudhra intermediate CAs were generated incorrectly,
so **anyone can recover them from the CA certificates themselves**. No breach
or insider is needed. Six of the intermediates issue TLS certificates (DV, OV
and EV); two issue code-signing certificates.

Each key is a P-384 key whose private number is a single byte (4, 56, 66, 115,
155, 156, 230 or 237) instead of a random 384-bit one. The public key is that
number times the curve's base point, so trying 1, 2, 3, ... up to 255 finds it
in milliseconds
([Scott Helme](https://scotthelme.co.uk/eight-bits-of-trust-emudhras-ca-keys-cracked-in-milliseconds/)).
eMudhra puts it down to a ceremony script that made a second, weak key pair on
the HSM, and the wrong one was used for the CSRs.

The intermediates chain to roots in the Mozilla, Microsoft, Apple and Chrome
root programs: each was issued once by an emSign root and once as a Sectigo
cross-sign under AAA Certificate Services. So until a client stops trusting
them, it accepts anything signed with these keys.

## Why it's bad

Whoever recovers a key becomes a trusted CA:

- **Impersonate any website or service.** They can issue a valid certificate
  for any domain (your bank, your company's SSO, a package registry, an API
  your servers call). A client that trusts the intermediate can't tell the
  attacker's server from the real one, so anyone positioned on the network
  (public Wi-Fi, a compromised router, a malicious proxy or DNS) can read and
  change "encrypted" traffic, including passwords, tokens and downloads.
- **Sign software that passes as legitimate.** The two code-signing
  intermediates let them sign programs, scripts and updates that verify as
  properly signed wherever those intermediates are trusted.
- **It isn't one site's key, it's a CA's.** A leaked server key exposes one
  domain. A leaked CA key exposes every domain at once, until the CA itself is
  distrusted.

The intermediates were created in April 2025 and never appeared in Certificate
Transparency logs. CT-enforcing browsers (Chrome, Edge, Firefox, Safari) would
have rejected a certificate from them, so browsers couldn't have been attacked.
Clients that don't enforce CT could have been, and nobody knows whether anyone
did.

## Why you still need to check

The intermediates were revoked, and Firefox, Chrome, Apple and Microsoft
blocked them between 17 and 20 October 2026. That protects browsers and
up-to-date OS trust stores. It doesn't protect most other software:

- Most non-browser clients (curl, wget, Python, Java, Go, Node.js, Ruby, Deno,
  package managers, Electron apps) **don't check revocation and don't enforce
  CT**. They trust whatever is in their own CA bundle, which still includes
  the roots these intermediates chain to.
- **Container images keep the CA bundle they were built with.** Every image
  built before the fixes trusts these roots until it's rebuilt, however
  up to date the host is.
- Some fixes aren't released, and some releases will never get one (end-of-life
  distributions), so the roots have to be distrusted by hand.

`scan` finds those places. For each target it records whether it still trusts
the intermediates for TLS and for code signing (`exposed`, `protected` or
`unknown`), which file or verifier says so, and what to do about it: upgrade
the CA package, rebuild the image, update the toolchain, or distrust the roots
AAA Certificate Services and emSign ECC Root CA - G3 as the disclosure page
describes. `scan` reads only; it changes nothing.

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
| `keystores`     | `[]`     | More Java keystores (JKS or PKCS#12) to check, on the host and in every container |
| `toolchains`    | `true`   | On the host, also check Python certifi, pip's bundle, Perl's Mozilla::CA, Java runtimes, Node.js, Go, Deno (swamp's own and any on PATH), Bun, uv, pixi, rustup, mise, Claude Code, Docker Desktop and Electron apps |

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
| `bundles`     | Each PEM bundle and Java keystore found: the roots and intermediates it trusts, those its runtime's `blocked.certs` refuses, any other certificates whose keys can be recovered (`recoverable`), and which usages that exposes |
| `native`      | macOS and Windows: the OS verifier's verdict on each of the 16 certificates                |
| `toolchains`  | Versions of the tools and Electron apps that carry their own roots, against the patched releases, with where each is installed |
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
  `/etc/pki/ca-trust/extracted/openssl/ca-bundle.trust.crt`,
  `/etc/ssl/ca-bundle.pem`, `/var/lib/ca-certificates/ca-bundle.pem` and
  `/etc/ssl/cert.pem`.
- macOS: `/etc/ssl/cert.pem`, the Homebrew `ca-certificates` and `openssl@3`
  bundles, and MacPorts' `curl-ca-bundle` (which its curl, git and OpenSSL
  use, and which has no fixed release yet).
- Windows: Git for Windows' bundle.
- With `toolchains`: Python's `certifi`, the copy pip vendors, and Perl's
  `Mozilla::CA`. The pip of macOS's own `python3` gets the page's `PIP_CERT`
  workaround rather than an upgrade.

A bundle that holds one of the roots or intermediates is exposed. Distribution
and toolchain bundles count for TLS, Fedora's `objsign` bundle for code signing,
and bundles you name in `bundles` for both. A blocklist (`update-ca-trust`,
`/etc/ca-certificates.conf`) shows up here once it has rebuilt the bundle.

OpenSSL's `TRUSTED CERTIFICATE` blocks carry trust settings. One rejected for
any use (`-addreject anyExtendedKeyUsage`) doesn't count. One rejected only for
named uses still does: `update-ca-trust` writes blocklisted roots into
`ca-bundle.trust.crt` that way, and OpenSSL trusts them when a caller names no
purpose
([galadran/we-have-a-problem.com#78](https://github.com/galadran/we-have-a-problem.com/pull/78)).
The Fedora-family remediation includes the extra `-addreject` step.

**Recoverable keys.** Every bundle and keystore is also checked for the flaw
itself. For each P-256, P-384 or P-521 certificate, the scan compares its
public key with 1×G to 255×G. A match means anyone can work out the private
key, so the bundle is exposed for everything it verifies, whether or not the
certificate is on the disclosure page. It finds all eight eMudhra keys this
way, with the private numbers Scott Helme published, and the tests check that.

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

**Java keystores.** Java checks TLS servers and signed JARs against its
runtime's `cacerts`, so a keystore that holds one of the roots or intermediates
is exposed for every usage they cover. The JDK also refuses any path through a
certificate whose SHA-256 is in its `lib/security/blocked.certs`
(`blacklisted.certs` in older JDKs such as 8), so a usage is exposed only while
some copy of an intermediate for it is reachable from the store and not
blocked. The page lists fixed releases (27.0.1.0.2, 25.0.5.0.2, 21.0.13.0.2,
17.0.21.0.2, 11.0.33.0.2, 8u511), and the
[OpenJDK advisory](https://openjdk.org/groups/vulnerability/advisories/2026-10-21)'s
workaround for older ones is to replace that file with an updated one, so the
scan checks the file, not the version. A JDK packaged by the distribution usually uses the
distribution's store instead. The scan reads JKS and PKCS#12
keystores itself, with no `keytool` and no password (Java leaves a trust
store's certificates unencrypted), so it works in containers too. It looks at:

- The runtime `java` on PATH reports (`java.home`), and `JAVA_HOME`.
- Every Java home up to two levels under the usual install roots, including
  runtimes that apps bundle in `jbr` or `jre` (JetBrains IDEs):
  - Windows: `Program Files`, `Program Files (x86)` and `%LOCALAPPDATA%\Programs`.
  - macOS: `/Library/Java/JavaVirtualMachines`,
    `~/Library/Java/JavaVirtualMachines` and `/Applications`.
  - Linux: `/usr/lib/jvm`, `/opt` and `/usr/local`.
- The distribution's Java store: `/etc/ssl/certs/java/cacerts`,
  `/etc/pki/ca-trust/extracted/java/cacerts`, `/etc/pki/java/cacerts` and
  `/var/lib/ca-certificates/java-cacerts`.
- In containers, the image's `JAVA_HOME` (from `inspect`; the official images
  set it) and the distribution's store.
- Any keystore you name in `keystores`.

**Toolchains.** These carry their own roots (mostly `webpki-roots`) or their
own verifier, so the OS store doesn't cover them. A version on PATH older than
the patched release on the page counts as TLS exposure:

| Tool           | Patched                   | Asked with                                         |
| -------------- | ------------------------- | -------------------------------------------------- |
| Node.js        | 22.23.4, 24.22.1, 26.12.1 | `node --version`                                   |
| Go             | 1.26.10, 1.27.3           | `go version`                                       |
| Deno           | 2.9.8                     | `deno --version`                                   |
| Bun            | none yet                  | `bun --version`                                    |
| uv             | 0.13.4                    | `uv --version`                                     |
| pixi           | 0.82.1                    | `pixi --version`                                   |
| rustup         | 1.29.2                    | `rustup --version`                                 |
| mise           | 2026.10.17                | `mise --version`                                   |
| Claude Code    | 2.1.303                   | `claude --version`                                 |
| Docker Desktop | 4.96.2                    | `docker version` while it runs; on Windows, else its `componentsVersion.json` |

Node.js and Go have a fix per release line: a version on an older line with no
fix counts as exposed, and one on a newer line counts as patched. Bun has no
fixed release, so any Bun counts as exposed.

**Electron apps.** Electron bundles Chromium's verifier and roots and doesn't
get Chrome's CRLSet updates, so an app is exposed until it ships on a patched
Electron (42.11.16, 43.8.1, 44.9.1, from the page). On macOS the version is the
`Electron Framework` bundle version of each app in `/Applications` and
`~/Applications`. On Windows and Linux an app is a directory with
`resources/app.asar` or `resources/app`, in an install directory or one level
below it (VS Code keeps it in a versioned folder, Squirrel apps in
`app-<version>`), under `%LOCALAPPDATA%\Programs`, `%LOCALAPPDATA%`,
`Program Files` and `Program Files (x86)`, or `/opt`, `/usr/lib` and
`/usr/share`. The version is the `Electron/<version>` its main executable
builds into its user agent.

**Deno and swamp.** Swamp is a compiled Deno program, and the extension runs
inside it, so it reports swamp's own Deno (and any `deno` on PATH). Deno
verifies with rustls and `webpki-roots`, fixed in Deno 2.9.8 (rustls-webpki
0.103.16, webpki-roots 1.0.10). A swamp built on an older Deno is exposed for
TLS. `DENO_TLS_CA_STORE=system` doesn't help: rustls then loads the OS roots,
which still include AAA Certificate Services, but not the OS block lists.

**Containers.** The scan copies the bundles, Java keystores and
`/etc/os-release` out with `docker cp`, so it needs nothing inside the image,
not even a shell. For an image it creates a container to copy from and removes
it afterwards. Apple's `container cp` only works on a running container, so
with `runtime: container` an image is started with `sleep` as its entrypoint,
and an image without `sleep` can't be scanned that way. Language-specific
bundles inside containers (certifi, Node) aren't found automatically; name them
in `bundles` or `keystores`.

## Not covered

- Clients with roots compiled in that the scan can't read or version: Rust
  programs using `webpki-roots` other than the tools above, and anything
  statically linked. Patched versions are listed on the page.
- Per-project bundles: Composer's `ca-bundle` (fixed in 1.4.16 and 1.6.0),
  Elixir's `castore` (1.0.22), Erlang's `certifi` (no fix yet). Name them in
  `bundles`.
- NSS databases, such as `~/.pki/nssdb`, which QtWebEngine browsers use.
- FreeBSD, NetBSD, OmniOS and Solaris hosts, and Bottlerocket nodes, which
  swamp doesn't run on. A Bottlerocket image gets Bottlerocket's advice.
- Electron apps outside the install roots above (portable apps, Snap and
  Flatpak), and Java runtimes deeper than two levels under them; name their
  keystores in `keystores`.
- Java keystores whose certificates are password-protected; the scan notes them.
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
- Windows 11 host (swamp 20261019.162501.0, Deno 2.9.7): CryptoAPI blocks all
  16 certificates. Git for Windows' bundle and the PKCS#12 `cacerts` of eight
  JetBrains IDE runtimes trust AAA Certificate Services and emSign ECC Root CA -
  G3, with nothing in their `blocked.certs`. Swamp's Deno is exposed, and so are
  five Electron apps, on Electron 20.3.5 to 43.6.0.
- Docker image `eclipse-temurin:21-jre`: `/opt/java/openjdk/lib/security/cacerts`
  (found through `JAVA_HOME`) trusts emSign ECC Root CA - G3, so it is exposed
  for TLS.

- macOS 27 host, 22 October 2026 (swamp 20261022.021804.0, Deno 2.9.8):
  `/etc/ssl/cert.pem` clean after the page's workaround, the Command Line
  Tools pip bundle and seven JetBrains runtimes exposed, Docker Desktop 4.90.0
  and ten Electron apps outdated, Claude Code 2.1.308 and swamp's Deno
  patched. The whole host scan, including the recoverable-key check, took
  0.4 seconds.
- Windows 11 Pro host, 22 October 2026 (swamp 20261022.021804.0, Deno 2.9.8):
  CryptoAPI blocks all 16 certificates (the Disallowed store). Git for
  Windows' per-user bundle and eight JetBrains runtimes trust AAA Certificate
  Services and emSign ECC Root CA - G3, so the host is exposed for TLS and code
  signing. Docker Desktop 4.95.0 (not running) and four Electron apps
  (20.3.5 to 43.6.0) outdated, Claude Code 2.1.308 and swamp's Deno patched.
  The test suite passes on Windows too. The host scan took about 5 seconds,
  most of it PowerShell and the Electron executables.

## What it runs

```
# host
sw_vers -productVersion                                  # macOS
python3 -c '<print certifi.where() and pip._vendor.certifi.where()>'
perl -MMozilla::CA -e 'print Mozilla::CA::SSL_ca_file()'
node --version
go version
deno --version
bun --version
uv --version
pixi --version
rustup --version
mise --version
claude --version
docker version --format '{{.Server.Platform.Name}}'
java -XshowSettings:properties -version
security verify-cert -c <cert> -c <cross-signed root> -l -L -p basic -v    # macOS, x16
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <script> -Data <json>   # Windows

# images (docker; podman via runtimePath)
docker create --name emudhra-scan-<id> --label emudhra-scan=1 <image> true
docker inspect emudhra-scan-<id>                          # JAVA_HOME
docker cp -L emudhra-scan-<id>:<path> <temp file>         # each bundle, keystore, os-release
docker rm --force emudhra-scan-<id>

# images (Apple container CLI)
container run --detach --rm --name emudhra-scan-<id> --entrypoint sleep <image> 600
container cp emudhra-scan-<id>:<path> <temp file>
container delete --force emudhra-scan-<id>

# running containers
docker inspect <name>                      # or: container inspect <name>
docker cp -L <name>:<path> <temp file>     # or: container cp <name>:<path> <temp file>
```

Everything else is read in place: bundles, keystores and `blocked.certs`,
Docker Desktop's `componentsVersion.json` on Windows, and each Electron app's
main executable, which is streamed in 4 MB chunks to find its version.
Certificates and the PowerShell script go in a temporary directory
that is removed afterwards. Nothing is sent over the network except what the OS
verifiers and container runtimes do themselves (Windows may fetch roots from
Windows Update; an image that isn't local gets pulled).

## Data

The 16 intermediates, four roots, and the cross-signed emSign Root TLS CA - G3
are embedded in `extensions/models/_lib/indicators.ts`. They come from the
page's `impacted-intermediates.json`, `roots.json` and `chains/` as fetched on
21 October 2026, and still match on 22 October. The tests check every embedded
certificate against the page's SHA-256 and SPKI fingerprints. The patched
releases come from the page's table and the OpenJDK advisory, as of
22 October.

## License

AGPL-3.0-only, with the exception in [COPYING-EXCEPTION](COPYING-EXCEPTION).
See [LICENSE](LICENSE).
