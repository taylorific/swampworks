# github

A [swamp](https://swamp.club/) extension that makes sure a GitHub repository
exists, through the [GitHub CLI](https://cli.github.com/). It uses the account
`gh auth login` set up, so no token goes in a vault.

## Model

`@taylor/github/repo` points at one repository:

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

## Usage

```sh
swamp extension pull @taylor/github
swamp model create @taylor/github/repo my-deck \
  --global-arg owner=my-account --global-arg name=my-deck
swamp model method run my-deck ensure --input description="My deck"
```

## What it runs

```
gh api repos/<owner>/<name>                               # does it exist?
gh api user                                               # who is gh logged in as?
gh api users/<owner>                                      # only for another owner: an organization?
gh api --method POST user/repos -f name=<name> -F private=<bool> [-f description=...]
gh api --method POST orgs/<owner>/repos ...               # for an organization
```

## Development

```sh
~/.swamp/deno/deno test --no-config --allow-all extensions/
```

## License

AGPL-3.0 with the Swamp Extension and Definition Exception; see
[LICENSE](LICENSE), [COPYING](COPYING) and
[COPYING-EXCEPTION](COPYING-EXCEPTION).
