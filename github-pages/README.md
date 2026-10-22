# github-pages

A [swamp](https://swamp.club/) extension that makes a repository's GitHub Pages
site build from GitHub Actions, through the
[GitHub CLI](https://cli.github.com/). It uses the account `gh auth login` set
up, so no token goes in a vault.

This is the "Settings → Pages → Source → GitHub Actions" step for a repository
whose workflow deploys with `actions/deploy-pages`.

## Model

`@taylor/github-pages/site` points at one repository's Pages site:

| Global argument | Default | Description                                   |
| --------------- | ------- | --------------------------------------------- |
| `owner`         |         | User or organization that owns the repository |
| `repo`          |         | Repository name                               |
| `ghPath`        | `gh`    | GitHub CLI binary                             |

| Method   | What it does                                                                                             |
| -------- | -------------------------------------------------------------------------------------------------------- |
| `ensure` | Enable Pages with GitHub Actions as the source, switch a branch-built site to Actions, or leave it alone |

The `site` resource records the site `url`, `buildType`, `status` and whether
this run `created` the site, `switched` it to Actions or left it `unchanged`.

## Usage

```sh
swamp extension pull @taylor/github-pages
swamp model create @taylor/github-pages/site my-deck-pages \
  --global-arg owner=my-account --global-arg repo=my-deck
swamp model method run my-deck-pages ensure
```

## What it runs

```
gh api repos/<owner>/<repo>/pages                                        # current site, if any
gh api --method POST repos/<owner>/<repo>/pages -f build_type=workflow   # when Pages is off
gh api --method PUT  repos/<owner>/<repo>/pages -f build_type=workflow   # when it builds from a branch
```

## Development

```sh
~/.swamp/deno/deno test --no-config --allow-all extensions/
```

## License

AGPL-3.0-or-later with the Swamp Extension and Definition Exception; see
[LICENSE](LICENSE), [COPYING](COPYING) and
[COPYING-EXCEPTION](COPYING-EXCEPTION).
