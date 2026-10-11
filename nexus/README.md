# nexus

A [swamp](https://swamp.club/) extension that runs a
[Sonatype Nexus Repository](https://help.sonatype.com/en/sonatype-nexus-repository.html)
instance with Docker or Apple's
[`container`](https://github.com/apple/container) CLI and configures it far
enough that the onboarding wizard is never shown: give it an admin username and
password and it replaces the generated password, accepts the Community Edition
EULA and sets anonymous access. The container keeps its data in a named volume,
so stopping or recreating it doesn't lose your repositories.

## Model

`@taylor/nexus/instance` is one Nexus container:

| Global argument   | Default                            | Description                                                                                               |
| ----------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `runtime`         | `docker`                           | `docker`, or `container` for Apple's container CLI (start it with `container system start`)               |
| `runtimePath`     |                                    | Path to the runtime CLI if it isn't `docker`/`container` on `PATH`                                        |
| `containerName`   | `nexus`                            | Container name                                                                                            |
| `image`           | `docker.io/sonatype/nexus3:3.96.4` | Nexus Repository image                                                                                    |
| `port`            | `8081`                             | Host port for the Nexus web UI and API                                                                    |
| `bindAddress`     | `127.0.0.1`                        | Host address to publish on; `0.0.0.0` exposes it on the network                                           |
| `volume`          | `nexus-data`                       | Named volume mounted at `/nexus-data`                                                                     |
| `memory`          | none on docker, `4g` on container  | Memory limit such as `4g` or `6144m`; at least `3072m`                                                    |
| `adminUsername`   | `admin`                            | Administrator to sign in as; another name is created with `nx-admin` and the built-in `admin` is disabled |
| `adminPassword`   |                                    | Administrator password (required, sensitive); use a vault expression                                      |
| `anonymousAccess` | `true`                             | Let anonymous users read repositories without signing in                                                  |

| Method   | What it does                                                                                                                     |
| -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `start`  | Create the container (or start a stopped one), wait until Nexus is ready (`timeoutSeconds`, default 300) and complete onboarding |
| `stop`   | Stop the container, keeping it and its data                                                                                      |
| `delete` | Remove the container; pass `removeVolume=true` to delete the data volume too                                                     |
| `sync`   | Read the container and Nexus as they are now and record any drift from the arguments; changes nothing                            |

The `instance` resource records the `runtime`, `url`, `containerId`,
`adminUsername` and:

- `state`: `running`, `stopped`, `removed`, or `absent` when `sync` finds no
  container
- `action`: what the run did (`created`, `started`, `stopped`, `removed`,
  `unchanged`, `synced`)
- `nexusReady`: whether Nexus answered its status endpoint
- `bootstrapped`: whether this run replaced the generated password
- `anonymousAccess`: the setting as Nexus reports it, `null` when not read
- `pendingOnboarding`: the wizard steps Nexus still lists; empty when the wizard
  won't appear, `null` when not checked or Nexus didn't answer
- `drift`: where the live instance differs from the arguments; empty after
  `start`, `null` from `stop` and `delete`

## Checking on it

`sync` only reads: it inspects the container and, if Nexus is up, signs in as
`adminUsername` and makes GET requests. It reports a changed image or port, a
password Nexus rejects, anonymous access switched in the UI, and a re-enabled
built-in `admin`, each as a `drift` entry and a warning. It never starts,
creates or configures anything, so it's safe as a workflow guard. Run `start` to
put the settings back.

## Pre-flight checks

Swamp runs these before each method; skip one with `--skip-check <name>` or a
group with `--skip-check-label <label>`.

| Check                         | Label    | Methods | Fails when                                                                      |
| ----------------------------- | -------- | ------- | ------------------------------------------------------------------------------- |
| `runtime-ready`               | `live`   | all     | the runtime CLI is missing, Docker isn't running, or `container system` is down |
| `existing-container-is-nexus` | `live`   | all     | a container named `containerName` exists but runs a non-Nexus image             |
| `existing-container-matches`  | `live`   | `start` | the existing container was created with a different `image` or `port`           |
| `port-available`              | `live`   | `start` | something else holds `bindAddress:port` (our own container is fine)             |
| `memory-sufficient`           | `policy` | `start` | `memory` is below `3072m`; Nexus's JVM heap alone is 2703 MiB                   |

`start` reuses an existing container as it is, so `existing-container-matches`
stops it from silently ignoring a changed `image` or `port`. To upgrade Nexus or
move it to another port, change the argument, then recreate the container; the
volume, and with it every repository and setting, is kept:

```sh
swamp model method run nexus delete
swamp model method run nexus start
```

A newer image migrates the Nexus database, which can't be undone, so back up the
volume first.

If the container exits while Nexus is starting, `start` fails right away and
points at `docker logs` / `container logs`, instead of waiting out
`timeoutSeconds`.

## Apple's container

With `runtime=container`, `start` differs from Docker in three ways:

- It first runs `chown 200:200 /nexus-data` as root in a throwaway container.
  Docker copies the image's ownership into a new volume, but Apple's container
  creates it owned by root, and Nexus (uid 200) can't write to it.
- It passes `--memory 4g` unless you set `memory`. Apple's default is 1 GiB, too
  little for Nexus.
- There is no restart policy, so after a reboot the container is stopped; run
  `start` again.

## Onboarding

On every `start`, once Nexus answers:

1. Sign in as `adminUsername`. If that fails and the built-in `admin` doesn't
   take `adminPassword` either, read the generated password from
   `/nexus-data/admin.password` and change `admin`'s password to
   `adminPassword`. Nexus deletes the file afterwards.
2. If `adminUsername` isn't `admin`, create it with the `nx-admin` role.
3. Accept the Community Edition EULA. Starting this model means you accept the
   [EULA](https://links.sonatype.com/products/nxrm/ce-eula).
4. Save the anonymous access setting.
5. If `adminUsername` isn't `admin`, disable the built-in `admin`.

Each step is skipped when it's already done, so `start` is safe to repeat. The
password is only set on first boot: if you change `adminPassword` later, change
it in Nexus too, or `start` fails because neither the new password nor
`admin.password` works.

## Usage

```sh
swamp extension pull @taylor/nexus
swamp vault create local_encryption nexus
swamp vault put nexus ADMIN_PASSWORD
swamp model create @taylor/nexus/instance nexus \
  --global-arg 'adminPassword=${{ vault.get(nexus, ADMIN_PASSWORD) }}'
swamp model method run nexus start
```

Open <http://127.0.0.1:8081> and sign in as `admin` with that password. For
Apple's container, add `--global-arg runtime=container`.

## What it runs

```
# Docker
docker version --format '{{.Server.Version}}'                                # runtime-ready
docker container inspect <containerName>
docker run --detach --name <containerName> --restart unless-stopped [--memory <memory>] \
  --publish <bindAddress>:<port>:8081 --volume <volume>:/nexus-data <image>   # start, no container
docker start <containerName>                                                 # start, stopped container
docker exec <containerName> cat /nexus-data/admin.password                   # start, first boot only
docker stop --time 120 <containerName>                                       # stop
docker rm --force <containerName>                                            # delete
docker volume inspect <volume> && docker volume rm <volume>                  # delete, removeVolume=true

# Apple's container
container system status --format json                                        # runtime-ready
container inspect <containerName>
container run --rm --user root --entrypoint chown \
  --volume <volume>:/nexus-data <image> 200:200 /nexus-data                   # start, no container
container run --detach --name <containerName> --memory <memory> \
  --publish <bindAddress>:<port>:8081 --volume <volume>:/nexus-data <image>   # start, no container
container start | exec | stop --time 120 ...                                 # as for Docker
container delete --force <containerName>                                     # delete
container volume inspect <volume> && container volume delete <volume>        # delete, removeVolume=true
```

`start` polls `GET <url>/service/rest/v1/status` until it returns 200, then
calls the Nexus REST API under `<url>/service/rest`:

```
GET  /v1/security/realms/active                     # does a login work?
PUT  /v1/security/users/admin/change-password       # first boot only
POST /v1/security/users                             # custom adminUsername, once
GET  /v1/system/eula, POST /v1/system/eula          # accept the EULA, once
GET  /v1/security/anonymous, PUT /v1/security/anonymous
GET  /v1/security/users?userId=admin, PUT /v1/security/users/admin  # disable admin, custom adminUsername only
GET  /internal/ui/onboarding                        # what the wizard would still show
```

`sync` makes only the GET requests above, plus the runtime's `inspect`.

## Development

```sh
~/.swamp/deno/deno test --no-config --allow-all extensions/
```

## License

AGPL-3.0 with the Swamp Extension and Definition Exception; see
[LICENSE](LICENSE), [COPYING](COPYING) and
[COPYING-EXCEPTION](COPYING-EXCEPTION).
