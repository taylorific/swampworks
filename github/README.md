# github

A [swamp](https://swamp.club/) extension for GitHub repositories, through the
[GitHub CLI](https://cli.github.com/): make sure one exists, list a user's or
organization's repositories, and keep local copies of them up to date. It uses
the account `gh auth login` set up, so no token goes in a vault.

## Models

### `@taylor/github/repo`

Points at one repository:

| Global argument | Default | Description                                   |
| --------------- | ------- | --------------------------------------------- |
| `owner`         |         | User or organization that owns the repository |
| `name`          |         | Repository name                               |
| `ghPath`        | `gh`    | GitHub CLI binary                             |

| Method   | What it does                                                                               |
| -------- | ------------------------------------------------------------------------------------------ |
| `ensure` | Create the repository if it doesn't exist; otherwise report it, leaving its settings alone |

`ensure` takes `description` and `visibility` (`public` by default) for a new
repository. When the repository already exists, a different visibility is
reported as a warning and nothing is changed. It creates repositories for the
account `gh` is logged in as, or for an organization that account belongs to.

The `repo` resource records the URLs (`url`, `sshUrl`, `cloneUrl`), visibility,
default branch and whether this run `created` the repository or found that it
`exists`.

### `@taylor/github/owner`

Points at a user or organization:

| Global argument | Default | Description                                         |
| --------------- | ------- | --------------------------------------------------- |
| `owner`         |         | User or organization whose repositories these are   |
| `ghPath`        | `gh`    | GitHub CLI binary                                   |
| `gitPath`       | `git`   | git binary (2.41 or newer, for `fetch --porcelain`) |

| Method | What it does                                                                                     |
| ------ | ------------------------------------------------------------------------------------------------ |
| `list` | List the owner's repositories' SSH URLs (`git@github.com:owner/name.git`), most recently active first |
| `sync` | Clone or update local copies of the repositories active since the last sync                      |

A repository's activity is the latest of when it was created, last pushed to
and last updated. Only repositories the owner owns are listed: a user's
collaborations in other accounts are left out.

`list` takes an optional `days` to keep only repositories active in the last N
days. It writes the `repos` resource (the `sshUrls` and each repository's
details) and an `ssh-urls` text file with one URL per line.

`sync` takes:

| Argument      | Default  | Description                                                                                         |
| ------------- | -------- | --------------------------------------------------------------------------------------------------- |
| `directory`   |          | Where the copies live; relative to the swamp repository, `~` for your home directory               |
| `mode`        | `source` | `source`: a checkout per repository in `<name>`. `mirror`: a bare `git clone --mirror` in `<name>.git` |
| `days`        |          | Only repositories active in the last N days                                                         |
| `all`         | `false`  | Every repository, whatever the last sync or `days` say                                              |
| `concurrency` | `4`      | Repositories cloned or fetched at once                                                              |

Without `days` or `all`, a sync takes only the repositories active since the
last sync of the same mode into the same directory began (less ten minutes),
so a large organization is listed but only what changed is fetched. The first
sync takes everything. The starting point only moves forward when a sync
succeeds for every repository and reaches back to it, so failed repositories
are retried next time, and a narrow `days` run doesn't skip anything.

Missing copies are cloned. Existing ones are fetched with `--prune` for
branches; tags are fetched with `--tags --force`, so a moved tag is updated but
a tag deleted upstream is kept. `source` checkouts are then fast-forwarded to
their upstream branch.

**Force pushes and deletions.** A dry-run fetch first lists what the fetch
would overwrite or delete, and all of it is kept in `refs/backups/<UTC time>/...`
refs in the local copy, in one transaction, before anything changes. If the
backups can't be written, nothing is fetched and the repository is reported as
failed. Backed up are:

- a branch that was force-pushed or a tag that was moved upstream (`refs/backups/<time>/heads/main`
  in a mirror, `refs/backups/<time>/remotes/origin/main` in a checkout);
- a branch deleted upstream;
- in a checkout, the local branch, when its upstream can't be fast-forwarded:
  it's backed up to `refs/backups/<time>/heads/<branch>` and reset to the
  upstream. If the checkout has uncommitted changes it's left alone and
  reported as failed.

GitHub's own `refs/pull/*` refs are mirrored but not backed up. List or restore
backups with git:

```sh
git for-each-ref refs/backups/
git branch rescued refs/backups/20261015T120000Z/heads/main
```

Git's automatic maintenance is off during the fetch, so commits pushed between
the dry run and the fetch can still be backed up afterwards. A repository that fails doesn't stop the
others; each result is recorded in the `sync` resource (instance `sync-source`
or `sync-mirror`) with what was cloned, updated, rewritten or deleted, and
errors are logged.

## Usage

```sh
swamp extension pull @taylor/github
swamp model create @taylor/github/repo my-deck \
  --global-arg owner=my-account --global-arg name=my-deck
swamp model method run my-deck ensure --input description="My deck"

swamp model create @taylor/github/owner systeminit --global-arg owner=systeminit
swamp model method run systeminit list --input days=30
swamp model method run systeminit sync --input directory=~/backup/systeminit/source
swamp model method run systeminit sync \
  --input directory=~/backup/systeminit/mirror --input mode=mirror
```

## What it runs

```
gh api repos/<owner>/<name>                               # does it exist?
gh api user                                               # who is gh logged in as?
gh api users/<owner>                                      # only for another owner: an organization?
gh api --method POST user/repos -f name=<name> -F private=<bool> [-f description=...]
gh api --method POST orgs/<owner>/repos ...               # for an organization

gh api graphql -f query=... -f owner=<owner> [-f cursor=...]  # list, 100 a page
git clone [--mirror] <sshUrl> <directory>/<name>[.git]
git -C <copy> fetch --porcelain --prune --tags --force --no-auto-maintenance origin <refspecs> --dry-run
git -C <copy> update-ref --stdin                          # backups, before history is lost
git -C <copy> fetch --porcelain --prune --tags --force --no-auto-maintenance origin <refspecs>
git -C <copy> merge --ff-only @{upstream}                 # source checkouts
git -C <copy> reset --hard @{upstream}                    # only after a backup, clean tree
```

## Development

```sh
~/.swamp/deno/deno test --no-config --allow-all extensions/
```

## License

AGPL-3.0-or-later with the Swamp Extension and Definition Exception; see
[LICENSE](LICENSE), [COPYING](COPYING) and
[COPYING-EXCEPTION](COPYING-EXCEPTION).
