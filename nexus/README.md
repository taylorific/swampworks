# nexus

A [swamp](https://swamp.club/) extension that runs a
[Sonatype Nexus Repository](https://help.sonatype.com/en/sonatype-nexus-repository.html)
instance with Docker or Apple's
[`container`](https://github.com/apple/container) CLI and configures it far
enough that the onboarding wizard is never shown: give it an admin username and
password and it replaces the generated password, accepts the Community Edition
EULA and sets anonymous access. The container keeps its data in a named volume,
so stopping or recreating it doesn't lose your repositories.

A second model, `@taylor/nexus/config`, declares what's inside Nexus (realms,
blob stores, roles, users, and apt, docker, npm, pypi and raw repositories) and
applies it, the way the `boxcutter_sonatype` Chef cookbook does.

## `@taylor/nexus/instance`

One Nexus container:

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
| `ports`           | `[]`                               | Extra container ports to publish on the same host port, e.g. `[10080, 10443]` for docker connectors       |
| `properties`      | `{}`                               | Settings for `/nexus-data/etc/nexus.properties`, e.g. `nexus.skipDefaultRepositories: true`               |

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
  --global-arg "adminPassword=\${{ vault.get('nexus', 'ADMIN_PASSWORD') }}"
swamp model method run nexus start
```

Quote the vault and key names in `vault.get`; `swamp model validate` warns about
the unquoted form.

Open <http://127.0.0.1:8081> and sign in as `admin` with that password. For
Apple's container, add `--global-arg runtime=container`.

## nexus.properties

`properties` is written to `/nexus-data/etc/nexus.properties` as a whole file,
sorted, under a "managed by" comment. When the container is created, a throwaway
root container writes it before Nexus first boots, which is what settings such
as `nexus.skipDefaultRepositories: true` (no maven and nuget repositories) need.
On a stopped container `start` rewrites it before starting; on a running one it
compares the file and, if it differs, rewrites it and restarts Nexus
(`action: restarted`). `sync` reports a difference as drift. Empty `properties`
leaves the file alone.

## `@taylor/nexus/config`

The configuration of a running Nexus, declared as data:

| Global argument | Default                 | Description                                                                                   |
| --------------- | ----------------------- | --------------------------------------------------------------------------------------------- |
| `url`           | `http://127.0.0.1:8081` | Nexus base URL; `${{ data.latest("nexus", "instance").attributes.url }}` follows the instance |
| `adminUsername` | `admin`                 | Administrator to sign in as                                                                   |
| `adminPassword` |                         | Administrator password (required, sensitive); use a vault expression                          |
| `realms`        |                         | Active security realms in order; omit to leave them alone                                     |
| `blobStores`    | `[]`                    | `{ name, type: file, path }` or `{ name, type: s3, bucket, region, prefix, endpoint }`        |
| `roles`         | `[]`                    | `{ id, name, description, privileges, roles }`                                                |
| `users`         | `[]`                    | `{ userId, firstName, lastName, emailAddress, password, status, roles }`                      |
| `repositories`  | `[]`                    | See below                                                                                     |

| Method  | What it does                                                                                                                             |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `apply` | Create and update everything declared, in dependency order, then check that Nexus matches; `prune=true` also deletes what isn't declared |
| `sync`  | Compare Nexus with the declaration and record what `apply` would change; changes nothing                                                 |

Both write a `config` resource: the `changes` (made by `apply`, or pending for
`sync`, each with the fields that differ but never their values), the
`undeclared` items, `conflicts`, how many items were `unchanged`, and `inSync`.

### Repositories

Every repository has `name`, `format` (`apt`, `docker`, `npm`, `pypi`, `raw`)
and `type` (`hosted`, `proxy`, `group`; apt has no groups). The rest is optional
unless noted:

| Field                                                                   | Applies to   | Default                                        |
| ----------------------------------------------------------------------- | ------------ | ---------------------------------------------- |
| `online`                                                                | all          | `true`                                         |
| `blobStore`                                                             | all          | `default`                                      |
| `strictContentTypeValidation`                                           | all          | `true` for hosted and group, `false` for proxy |
| `writePolicy`                                                           | hosted       | `allow` (or `allow_once`, `deny`)              |
| `cleanupPolicies`                                                       | hosted/proxy | `[]`                                           |
| `remoteUrl`                                                             | proxy        | required                                       |
| `contentMaxAge`, `metadataMaxAge`                                       | proxy        | `1440` minutes                                 |
| `negativeCache: { enabled, timeToLive }`                                | proxy        | `true`, `1440`                                 |
| `blocked`, `autoBlock`                                                  | proxy        | `false`, `true`                                |
| `authentication: { username, password }`                                | proxy        | none; `password` is sensitive                  |
| `routingRule`                                                           | proxy        | none                                           |
| `members`                                                               | group        | required, in resolution order                  |
| `writableMember`                                                        | docker group | none                                           |
| `distribution`                                                          | apt          | required                                       |
| `flat`                                                                  | apt proxy    | `false`                                        |
| `signing: { keypair, passphrase }`                                      | apt hosted   | required; both sensitive                       |
| `docker: { v1Enabled, forceBasicAuth, httpPort, httpsPort, subdomain }` | docker       | `false`, `true`, none                          |
| `dockerProxy: { indexType, indexUrl, cacheForeignLayers }`              | docker proxy | `REGISTRY`                                     |
| `settings`                                                              | all          | extra Nexus API fields, deep-merged            |

A docker connector port (`httpPort`, `httpsPort`) is only reachable from the
host if the instance publishes it too: add it to the instance's `ports`.

### Applying

`apply` works out a plan first and changes nothing if the plan has a conflict it
can't fix: a repository whose format or type changed, a read-only built-in role,
a connector port held by an undeclared repository, or (with prune) a group
member that isn't declared. Otherwise it applies the realms, then blob stores,
roles, users, and repositories with groups after their members. It then plans
again and fails if anything still differs.

Without `prune`, items Nexus has that aren't declared are only listed as
`undeclared`. With `--input prune=true`, `apply` deletes them like the cookbook
does: undeclared repositories first (groups before members, so their names and
ports can be reused), and users, roles and blob stores after the rest. Deleting
a repository deletes its content. It never deletes `admin`, `anonymous`,
`adminUsername`, read-only roles, users or roles from other sources such as
LDAP, or a blob store that a declared repository uses.

Users' passwords are checked by signing in as each active user, and set when
Nexus rejects them. Secrets (user and remote passwords, the apt signing key) are
sent but never compared or recorded; Nexus doesn't return most of them.

Swamp refuses a literal value for a top-level sensitive argument such as
`adminPassword`, but not for one nested in a list, such as a user's `password`.
Always write those as `${{ vault.get('vault', 'KEY') }}` expressions; they are
resolved at run time and redacted in stored data.

### Pre-flight checks

| Check                | Methods | Fails when                                                                                                 |
| -------------------- | ------- | ---------------------------------------------------------------------------------------------------------- |
| `nexus-reachable`    | all     | Nexus doesn't answer at `url`                                                                              |
| `admin-signs-in`     | all     | the admin password is wrong, or the user isn't an administrator                                            |
| `references-resolve` | `apply` | a realm, privilege, role, blob store or group member the declaration names doesn't exist or isn't declared |

### Example

The `boxcutter_sonatype` cookbook's test recipe as a definition, with the
instance publishing the docker connector ports and skipping the default
repositories:

```yaml
# models/@taylor/nexus/instance/nexus.yaml (globalArguments)
adminPassword: "${{ vault.get('nexus', 'ADMIN_PASSWORD') }}"
ports: [10080, 10443]
properties:
  nexus.skipDefaultRepositories: true
```

```yaml
# models/@taylor/nexus/config/nexus-config.yaml (globalArguments)
url: '${{ data.latest("nexus", "instance").attributes.url }}'
adminPassword: "${{ vault.get('nexus', 'ADMIN_PASSWORD') }}"
realms: [NexusAuthenticatingRealm, DockerToken]
roles:
  - id: engineering-read-only
    description: Read-only access to engineering repositories
    privileges: [
      nx-healthcheck-read,
      nx-search-read,
      nx-repository-view-*-*-read,
      nx-repository-view-*-*-browse,
    ]
users:
  - userId: chef
    firstName: Chef
    lastName: User
    emailAddress: chef@example.com
    password: "${{ vault.get('nexus', 'CHEF_PASSWORD') }}"
    roles: [nx-admin]
blobStores:
  - { name: default, type: file, path: default }
repositories:
  - { name: testy-hosted, format: raw, type: hosted }
  - {
      name: ubuntu-archive-proxy,
      format: apt,
      type: proxy,
      remoteUrl: "http://archive.ubuntu.com/ubuntu/",
      distribution: jammy,
    }
  - {
      name: ubuntu-releases-proxy,
      format: raw,
      type: proxy,
      remoteUrl: "https://releases.ubuntu.com",
    }
  - {
      name: cinc-proxy,
      format: raw,
      type: proxy,
      remoteUrl: "https://ftp.osuosl.org/pub/cinc",
      online: false,
    }
  - name: docker-proxy
    format: docker
    type: proxy
    remoteUrl: https://registry-1.docker.io
    docker: {
      v1Enabled: true,
      forceBasicAuth: true,
      httpPort: 10080,
      httpsPort: 10443,
    }
    dockerProxy: { indexType: HUB }
  - {
      name: npm-proxy,
      format: npm,
      type: proxy,
      remoteUrl: "https://registry.npmjs.org",
    }
  - { name: npm-hosted, format: npm, type: hosted }
  - {
      name: python-proxy,
      format: pypi,
      type: proxy,
      remoteUrl: "https://pypi.org/",
    }
  - { name: python-hosted, format: pypi, type: hosted }
```

```sh
swamp model method run nexus start
swamp model method run nexus-config apply --input prune=true
swamp model method run nexus-config sync
```

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

`sync` makes only the GET requests above, plus the runtime's `inspect` (and
`exec cat` of nexus.properties when `properties` is set).

`@taylor/nexus/config` calls, under `<url>/service/rest`:

```
GET    /v1/security/realms/active, /v1/security/realms/available   PUT /v1/security/realms/active
GET    /v1/blobstores, /v1/blobstores/{file,s3}/<name>             POST/PUT .../{file,s3}[/<name>]   DELETE /v1/blobstores/<name>
GET    /v1/security/roles, /v1/security/privileges                 POST /v1/security/roles   PUT/DELETE .../<id>
GET    /v1/security/users?source=default                           POST /v1/security/users   PUT/DELETE .../<id>
PUT    /v1/security/users/<id>/change-password                     # when Nexus rejects the declared password
GET    /v1/repositories, /v1/repositories/<format>/<type>/<name>   POST/PUT .../<format>/<type>[/<name>]   DELETE /v1/repositories/<name>
GET    /v1/security/realms/active as each active user              # does the declared password work?
```

`sync` and the pre-flight checks make only the GET requests.

## Development

```sh
~/.swamp/deno/deno test --no-config --allow-all extensions/
```

## License

AGPL-3.0-or-later with the Swamp Extension and Definition Exception; see
[LICENSE](LICENSE), [COPYING](COPYING) and
[COPYING-EXCEPTION](COPYING-EXCEPTION).
