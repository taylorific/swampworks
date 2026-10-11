# slidev

A [swamp](https://swamp.club/) extension for working on
[Slidev](https://sli.dev/) decks entirely inside a container, so the host needs
no Node. Its headline feature is a **slide fit check**: it opens every slide
with all clicks revealed and reports content that runs off the bottom or right
edge, bumps against the bottom, or is hidden inside a box that scrolls or clips
(a code block with `maxHeight`, a table too wide for the slide), with the source
file and line of each slide and a screenshot.

It runs [`boxcutter/slidev`](https://hub.docker.com/r/boxcutter/slidev) (or a
compatible image) with **Docker** or **Apple's `container` CLI**.

## Methods

The `@taylor/slidev/deck` model type points at one deck directory:

| Method     | What it does                                                                                                                                  |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `fit`      | Measure every slide (or `slides=3,7,10-14`) and flag the ones that don't fit, with screenshots                                                |
| `serve`    | Start the dev server in a background container (`slidev --remote`) and wait until it answers                                                  |
| `stop`     | Stop that server                                                                                                                              |
| `outdated` | `npm outdated`: packages with newer versions                                                                                                  |
| `upgrade`  | Move `@slidev/*`, `vue` and `playwright-chromium` to `@latest`, adding `playwright-chromium`                                                  |
| `export`   | Export the deck to PDF                                                                                                                        |
| `init`     | Create a new deck at `dir` from the Slidev template, with `playwright-chromium`                                                               |
| `scaffold` | Add page numbers, a GitHub Pages deploy workflow, README, LICENSE and a starter `slides.md` to a deck from `init`, then `git init` and commit |
| `push`     | Push the deck to a remote as `origin`, adding `origin` if it's missing                                                                        |

`fit` and `export` drive the Chromium that the deck's `playwright-chromium`
package installs into `node_modules`, so the deck needs that package; `upgrade`
and `init` add it.

`upgrade` leaves packages pinned to an exact version (`"52.15.2"`, usually to
avoid a known bug) alone unless you name them in `packages`, and records every
version it changed.

## Setup

```sh
swamp extension pull @taylor/slidev
swamp model create @taylor/slidev/deck my-talk --global-arg dir=/path/to/my-talk
```

| Global argument | Default                             | Description                                                |
| --------------- | ----------------------------------- | ---------------------------------------------------------- |
| `dir`           | (required)                          | Deck directory; relative paths resolve from the swamp repo |
| `runtime`       | `docker`                            | `docker`, or `container` for Apple's container CLI         |
| `runtimePath`   | `docker` / `container` on PATH      | Path to the runtime CLI                                    |
| `image`         | `docker.io/boxcutter/slidev:latest` | Slidev image                                               |

With Apple's container CLI, start its service first: `container system start`.

## Usage

```sh
# Which slides don't fit? Copies screenshots of the flagged ones to ./shots
swamp model method run my-talk fit --input shotsDir=./shots
swamp data query 'modelName == "my-talk" && name == "fit"' --select content --json \
  | jq -r '.results[0].flagged[] | "\(.no) \(.file):\(.line) \(.problems) \(.title)"'

# Re-check only the slides you changed
swamp model method run my-talk fit --input slides=12,15-17

# Present it
swamp model method run my-talk serve
swamp model method run my-talk stop

# Keep it current
swamp model method run my-talk outdated
swamp model method run my-talk upgrade
```

A slide is flagged when content reaches within `bottomMargin` (default 40) slide
pixels of the bottom or `rightMargin` (default 20) of the right edge. Slides are
measured in Slidev's own units (980 wide, 552 high for 16:9), so the result
doesn't depend on screen size. Absolutely positioned elements, such as corner
buttons and `abs-br` boxes, are placed deliberately and are ignored.

### A new deck on GitHub

The `@taylor/slidev-new-deck` workflow goes from nothing to a published deck:
`init`, `scaffold`, then (with
[`@taylor/github`](https://swamp-club.com/extensions/@taylor/github) and
[`@taylor/github-pages`](https://swamp-club.com/extensions/@taylor/github-pages),
installed with this extension) create the GitHub repository, set Pages to build
from GitHub Actions, and push. The push runs the deploy workflow, so the deck
appears at `https://<owner>.github.io/<name>/`.

```sh
swamp workflow run @taylor/slidev-new-deck \
  --input name=kvm-training --input title="Virtual Machines with KVM/QEMU" \
  --input owner=my-account --input parentDir="$HOME/github/my-account" \
  --input email=me@example.com --input copyright="My Name"
```

`scaffold` adds:

- `components/Pagination.vue` and `global-top.vue`: a page number in the top
  right of every slide but the cover, set by `themeConfig` in `slides.md`
- `.github/workflows/deploy.yml`: builds with `--base /<name>/` and deploys to
  GitHub Pages
- `README.md`: how to run and update the deck with the container image
- `LICENSE` (`license: false` to skip): code under Apache-2.0, slides under CC
  BY 4.0, logos excluded, with an optional copyright line
- `slides.md`: a cover slide, a table of contents and a first section
- `.gitignore`, if the Slidev template didn't create one

It refuses a directory that is already a git repository. Repositories are public
by default (`visibility=private` for private; GitHub Pages on a private
repository needs a paid plan). The GitHub steps use the GitHub CLI's login and
`push` uses your git credentials.

### Fit passes with an agent

The bundled `slide-fit` skill turns this into a routine for Claude Code and
other agents: run `fit`, look at the screenshots, fix each flagged slide by
cutting words, tightening tables or splitting the slide (never by shrinking
text), and re-check until every slide fits. Ask for "a slide fit pass".

## What it runs

Every method runs the runtime CLI (`docker`, or Apple's `container`) with
argument lists built in `extensions/models/slidev_deck.ts`. The deck is
bind-mounted at `/slidev`, and the image's entrypoint installs dependencies when
`package.json` or the lockfile has changed, so any method may run `npm install`
in the deck first, as `boxcutter/slidev` always does.

```
run --rm --name slidev-<deck>-fit-<id> --mount <deck>:/slidev --mount <tmp>:/fit
    --entrypoint bash <image> -c '/entrypoint.sh --port 3030 & node /fit/fit.mjs ...'
run --detach --rm --name slidev-<deck> --mount <deck>:/slidev --publish <port>:3030 <image> --remote
inspect slidev-<deck>                      # serve/stop; Apple: also the container's IP
rm --force slidev-<deck>                   # docker; Apple: delete --force
run --rm ... --entrypoint npm <image> outdated --json
run --rm ... --entrypoint npm <image> install --no-audit --no-fund <pkg>@latest ...
run --rm ... --mount <tmp>:/out <image> export --output /out/slides.pdf
run --rm ... --mount <parent>:/slidev --entrypoint bash <image> -c 'echo n | npm init slidev@latest --yes <name>'
```

`scaffold` and `push` run git on the host, in the deck directory:

```
git -C <deck> config user.name             # scaffold, when no author is given
git -C <deck> init --initial-branch=main
git -C <deck> add --all
git -C <deck> commit --quiet --message "Initial slides"
git -C <deck> remote get-url origin        # push: add origin if missing, refuse a different one
git -C <deck> remote add origin <remoteUrl>
git -C <deck> push --set-upstream origin <branch>
```

Throwaway containers are removed on timeout too. The fit script
(`extensions/models/_lib/fit_script.ts`) is written to a temporary directory for
each run and deleted afterwards.

## Development

```sh
~/.swamp/deno/deno test --no-config --allow-all extensions/
```

The tests run every method against a fake runtime CLI.

## License

AGPL-3.0 with the Swamp Extension and Definition Exception; see
[LICENSE](LICENSE), [COPYING](COPYING) and
[COPYING-EXCEPTION](COPYING-EXCEPTION).
