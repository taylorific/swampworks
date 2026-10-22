# netbox

A [swamp](https://swamp.club/) extension that runs a
[NetBox](https://netboxlabs.com/oss/netbox/) instance for development and
testing with Docker Compose, using the
[netbox-docker](https://github.com/netbox-community/netbox-docker) images:
NetBox, its background worker, PostgreSQL and Valkey (Redis).

## Model

`@taylor/netbox/instance` points at one compose project:

| Global argument | Default                                       | Description                                                                            |
| --------------- | --------------------------------------------- | -------------------------------------------------------------------------------------- |
| `name`          | `netbox`                                      | Compose project name, and the prefix for its volumes                                   |
| `image`         | `docker.io/netboxcommunity/netbox:v4.7-5.1.1` | NetBox image for NetBox and its worker; see below                                      |
| `port`          | `8000`                                        | Host port for the web UI and API                                                       |
| `bindAddress`   | `127.0.0.1`                                   | Host address the port is published on; `0.0.0.0` exposes it to the network             |
| `adminUsername` | `admin`                                       | Superuser                                                                              |
| `adminEmail`    | `admin@example.com`                           | Superuser's email address                                                              |
| `adminPassword` |                                               | Superuser's password, set on every `start`; use a vault reference                      |
| `apiToken`      |                                               | Optional v2 API token for the superuser, `nbt_<12 letters/digits>.<40 letters/digits>` |
| `dockerPath`    | `docker`                                      | Docker CLI binary                                                                      |

| Method   | What it does                                                                                                           |
| -------- | ---------------------------------------------------------------------------------------------------------------------- |
| `start`  | Bring the project up, wait until every service is healthy, set the superuser's password and make sure it has the token |
| `status` | Report whether NetBox and each service is running                                                                      |
| `stop`   | Stop every container, keeping them and their volumes                                                                   |
| `remove` | Remove the containers and network; `deleteVolumes=true` also deletes the data                                          |

Before `start`, pre-flight checks make sure Docker is running with the compose
plugin (`docker-ready`) and that the port is free unless this project's NetBox
already holds it (`port-available`). `start` then waits up to `timeoutSeconds`
(600 by default, at most 1800) for every service's health check; the first start
runs the database migrations and takes two or three minutes. Running it again is
safe: it leaves running containers alone, starts stopped ones and recreates any
whose settings changed.

`image` must be a recent
[netbox-docker](https://github.com/netbox-community/netbox-docker) image: the
compose file relies on its `netbox` user, health check and secret files, so
releases before netbox-docker 4 don't start. `apiToken` needs NetBox 4.5 or
later, which introduced v2 tokens.

The superuser is created on the first start and its password is reset to
`adminPassword` on every start. With `apiToken` set, `start` makes sure the
superuser owns a working token with that key and secret, replacing one with the
same key whose secret or owner differ, or that was disabled, expired or made
read-only. Use it as `Authorization: Bearer <apiToken>`. Nothing is ever
deleted: after changing `adminUsername` the old superuser stays, and after
dropping `apiToken` the token stays, until you remove them in NetBox.

Only NetBox publishes a port. The secret key, API token pepper and the
PostgreSQL and Valkey passwords are generated on the first start into the
`<name>-secrets` volume and read from there by every container, so they never
appear in the compose file, in `docker inspect` or in swamp's data. Data lives
in the `<name>-postgres`, `<name>-redis`, `<name>-media`, `<name>-scripts` and
`<name>-reports` volumes, so `remove` and `start` bring back the same instance.

The `instance` resource records the `state`, `url`, `apiUrl`, `username`, each
service's container state and the volume names, plus the `action` the run took
(`created`, `started`, `running`, `status`, `stopped` or `removed`). `start`
also records the NetBox `version` and whether the superuser has the `apiToken`;
the other methods don't check those and leave them `null`.

## Usage

```sh
swamp extension pull @taylor/netbox
swamp vault create local_encryption secrets
swamp vault put secrets netbox-admin            # prompts for the password

# Optional: an API token for scripts and tools
gen() { LC_ALL=C tr -dc A-Za-z0-9 </dev/urandom | head -c "$1"; }
swamp vault put secrets netbox-token "nbt_$(gen 12).$(gen 40)"

swamp model create @taylor/netbox/instance netbox \
  --global-arg "adminPassword=\${{ vault.get('secrets', 'netbox-admin') }}" \
  --global-arg "apiToken=\${{ vault.get('secrets', 'netbox-token') }}"
swamp model method run netbox start
```

Sign in at <http://127.0.0.1:8000> as `admin`, or use the API:

```sh
TOKEN=$(swamp vault read-secret secrets netbox-token -y)
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8000/api/dcim/sites/
```

The [`@tagur/netbox`](https://swamp-club.com/extensions/@tagur/netbox) extension
can read from it with the same token.

## What it runs

Every `docker compose` call gets the generated compose file on standard input.

```
docker info --format '{{.ServerVersion}}'          # docker-ready check
docker compose version                             # docker-ready check
docker compose --project-name <name> --file - ps --all --format json
docker compose --project-name <name> --file - up --detach --wait --wait-timeout <timeoutSeconds>
docker compose --project-name <name> --file - exec -T --env NB_USER --env NB_EMAIL --env NB_PASSWORD --env NB_TOKEN \
  netbox /opt/netbox/venv/bin/python /opt/netbox/netbox/manage.py shell --command '<ensure superuser and token>'
docker compose --project-name <name> --file - stop
docker compose --project-name <name> --file - down --remove-orphans [--volumes]
```

The compose project has these services:

| Service         | Image                                | Notes                                                    |
| --------------- | ------------------------------------ | -------------------------------------------------------- |
| `secrets`       | the NetBox image                     | Runs once to write any missing secrets, then exits       |
| `postgres`      | `docker.io/postgres:18-alpine`       |                                                          |
| `redis`         | `docker.io/valkey/valkey:9.1-alpine` | Database 0 for the task queue, 1 for the cache           |
| `netbox`        | `image`                              | Published on `<bindAddress>:<port>`                      |
| `netbox-worker` | `image`                              | Runs `manage.py rqworker` for scripts, webhooks and jobs |

The superuser password and token reach `docker compose exec` through its
environment, not its argument list. Valkey reads its password from a config file
it writes at startup, and its health check passes the password in
`REDISCLI_AUTH`, so neither shows up in `docker top`. Every container mounts the
secrets volume, so PostgreSQL and Valkey can read NetBox's secret key; this is a
development instance, not a hardened deployment.

## Development

```sh
~/.swamp/deno/deno test --no-config --allow-all extensions/
```

## License

AGPL-3.0-or-later with the Swamp Extension and Definition Exception; see
[LICENSE](LICENSE), [COPYING](COPYING) and
[COPYING-EXCEPTION](COPYING-EXCEPTION).
