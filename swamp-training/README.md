# swamp-training

A [swamp](https://swamp.club/) extension that keeps the
[swamp-training](https://github.com/taylorific/swamp-training) Slidev deck
honest about swamp. Swamp cuts a release for every merge, often several an hour;
this checks whether the deck still matches the latest one.

## Behavior

`@taylor/swamp-training/deck` points at one deck:

| Global argument  | Default            | Description                                                                  |
| ---------------- | ------------------ | ---------------------------------------------------------------------------- |
| `deckDir`        |                    | Deck directory; relative paths resolve from the swamp repo                   |
| `slidesFile`     | `slides.md`        | Deck markdown file, relative to `deckDir`                                    |
| `upstream`       | `swamp-club/swamp` | GitHub repository whose releases are watched                                 |
| `ghPath`         | `gh`               | GitHub CLI binary                                                            |
| `swampConfigDir` | `~/.config/swamp`  | Swamp config directory holding your sign-in, shared with the sandbox         |
| `ignore`         | `[]`               | Regular expressions for deck commands that aren't real commands, like a joke |

| Method   | What it does                                                                                              |
| -------- | --------------------------------------------------------------------------------------------------------- |
| `watch`  | Is there a release newer than the last one tested? Lists the commits since then. Downloads nothing        |
| `retest` | Retest the deck against the latest release (or `version`); does nothing if that release is already tested |

`retest` takes `version` (a release tag, default the latest), `force` (retest a
release that was already tested) and `keepSandbox` (keep the sandbox directory
for debugging; its path goes in the report).

## What `retest` checks

It downloads the release binary for this machine with `gh release download`,
checks it against the release's `checksums.txt`, and runs it in a throwaway
sandbox: a temporary directory with its own `HOME`, so the swamp you have
installed, its skills and its caches are never touched. Only your sign-in is
shared, through `SWAMP_CONFIG_DIR`. In the sandbox it runs `swamp repo init`,
then:

| Check        | How                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Commands** | Every `swamp ...` command in the deck's shell and text code blocks and inline code is walked through the CLI schema `swamp help` prints. A subcommand or option the release doesn't have is an **error**; one the release calls legacy or deprecated (such as `swamp model`) is listed as **legacy**. Hidden commands such as `swamp audit` are looked up with `swamp help <command>`                           |
| **Lab**      | The `@training/file-check` lab is rebuilt from the slides: the file the deck says to create, from the Part 1–3 code blocks, and the unit test. Each command the lab slides show runs in order, and its output is compared with the slide's output block: describe the type, create the definition, run, query, bad settings, `deno test` with and without `deno.json`, the bug the test catches, and bad output |
| **Skills**   | The skills, `CLAUDE.md` and `.claude/settings.local.json` that `swamp repo init` installed are saved as a snapshot and diffed against the snapshot from the last retest                                                                                                                                                                                                                                         |

A lab step that can't find its slide (a renamed heading, a missing code block)
fails with the slide it looked for. Output is compared after removing colors and
timings; `...` in a slide's output matches anything.

The `report` resource records the release, the commits since the previous retest
(GitHub lists at most 250; `commitsTruncated` says when there were more than
that, out of `commitsTotal`), command errors and legacy commands with their deck
line numbers, each lab step with what differed, and the skill files added,
removed and changed, with a unified diff for each. `ok` is false when a command
or a lab step fails; the method itself still succeeds, so the report is saved.

`retest` runs on macOS and Linux (x86_64 or aarch64): there's no Windows binary
to run in a sandbox the same way.

## Usage

```sh
swamp extension pull @taylor/swamp-training
swamp behavior create @taylor/swamp-training/deck swamp-training \
  --global-arg deckDir=/path/to/swamp-training

swamp behavior run swamp-training watch      # anything new?
swamp behavior run swamp-training retest     # retest if so

# What broke, with deck line numbers
swamp data query 'behaviorName == "swamp-training" && name == "report"' \
  --select content --json | jq '.results[0] | {version, ok,
    errors: .commands.errors, lab: [.lab.steps[] | select(.ok | not)],
    skills: {added: .skills.added, removed: .skills.removed,
             changed: [.skills.changed[].path]}}'
```

Commands that aren't meant to run, such as a joke on a slide, go in `ignore` in
the definition's YAML (`swamp behavior edit swamp-training`):

```yaml
globalArguments:
  ignore:
    - "^swamp build me"
```

## What it runs

```
gh api repos/<upstream>/releases/latest                    # or releases/tags/<version>
gh api repos/<upstream>/compare/<last tested>...<release>  # commits since the last retest
gh release download <release> --repo <upstream> --pattern swamp-<os>-<arch> --pattern checksums.txt
```

In the sandbox, with `HOME` set to the sandbox and only `PATH`, `TMPDIR`,
`LANG`, `NO_COLOR` and `SWAMP_CONFIG_DIR` passed through: the downloaded `swamp`
(`repo init`, `help`, and the lab's commands from the deck) and the `deno` that
swamp unpacks into the sandbox's `~/.swamp/deno/`, for the lab's `deno test`.

The checksum check catches a corrupted download; `checksums.txt` comes from the
same release, so it is not a signature.

## Development

```sh
~/.swamp/deno/deno test --no-config --allow-all extensions/
```

## License

AGPL-3.0-or-later with the Swamp Extension and Definition Exception; see
[LICENSE](LICENSE), [COPYING](COPYING) and
[COPYING-EXCEPTION](COPYING-EXCEPTION).
