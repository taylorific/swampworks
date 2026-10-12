# jj

A [swamp](https://swamp.club/) extension that installs and configures
[Jujutsu (jj)](https://jj-vcs.github.io/jj/), the Git-compatible version control
system, on Linux, macOS and Windows. It installs jj with Homebrew on macOS and
winget on Windows when they are there, otherwise from the
[GitHub release](https://github.com/jj-vcs/jj/releases), and checks the download
against the SHA-256 digest GitHub lists for it. It then sets your user-level jj
config (name, email, and any other keys you give it), changing only keys that
differ.

## Model

`@taylor/jj/cli` is jj for the user swamp runs as:

| Global argument | Default   | Description                                                                                                |
| --------------- | --------- | ---------------------------------------------------------------------------------------------------------- |
| `installMethod` | `auto`    | `auto`, `release`, `brew` or `winget`; see [Install methods](#install-methods)                             |
| `version`       | `latest`  | `latest`, or a version like `0.46.0`. Homebrew can't pin one.                                              |
| `installDir`    | see below | Where `release` puts jj: `~/.local/bin`, or `%LOCALAPPDATA%\Programs\jj` on Windows                        |
| `jjPath`        |           | A jj binary to use instead of looking for one                                                              |
| `userName`      |           | `user.name` for commits                                                                                    |
| `userEmail`     |           | `user.email` for commits                                                                                   |
| `settings`      | `{}`      | Other user-level config, keyed as jj names them; values are strings, numbers, booleans or lists of strings |

| Method      | What it does                                                                                               |
| ----------- | ---------------------------------------------------------------------------------------------------------- |
| `install`   | Install jj if it's missing or isn't the pinned `version`; pass `upgrade=true` to also update to the latest |
| `configure` | Set `userName`, `userEmail` and `settings` with `jj config set --user`, only for keys that differ          |
| `sync`      | Read the installed jj and its config and record drift from the arguments; changes nothing                  |

The `installation` resource records `installed`, `path`, `version`, the `method`
this run used, `os`, `arch`, `drift`, and `action`: `installed`, `updated`,
`exists`, or `missing` when `sync` finds no jj.

The `config` resource records the user config file's `path`, the current
`settings` for every key the model manages, the keys `configure` `changed`, and
the `drift` that `sync` found.

## Install methods

| Method    | Platforms             | How                                                                                |
| --------- | --------------------- | ---------------------------------------------------------------------------------- |
| `release` | Linux, macOS, Windows | Downloads the jj-vcs/jj release archive for x86_64 or aarch64 and verifies SHA-256 |
| `brew`    | macOS, Linux          | `brew install jj`, or `brew upgrade jj` when Homebrew already has it               |
| `winget`  | Windows               | `winget install --id jj-vcs.jj`, or `winget upgrade` when winget already has it    |

`auto` uses Homebrew on macOS when `brew` is installed and `version` is
`latest`, winget on Windows when `winget` is installed, and `release` everywhere
else, including Linux. The Linux release builds are static (musl), so they run
on any distribution.

`release` warns when `installDir` isn't on `PATH`. Add it to your shell profile
so your shell finds jj; swamp finds it either way.

To find jj, the model tries `jjPath` alone if it's set, otherwise `installDir`,
then `jj` on `PATH`, then where Homebrew and winget put it. `installDir` comes
first so a pinned release build wins over an older jj on `PATH`.

## Configuration

`configure` reads each key with `jj config list --user` and sets only the ones
that differ, passing values as TOML so that a string like `"true"` stays a
string. jj writes a value before checking it, and a value it rejects (say
`ui.color: "true"`) breaks every later jj command. So `configure` backs up the
config file first, reads every key back afterwards, and restores the file if
anything failed.

`settings` is an object, which `--global-arg` can't pass. Create the model, then
add `settings` to its definition in `models/@taylor/jj/cli/<name>.yaml`:

```yaml
globalArguments:
  userName: Your Name
  userEmail: you@example.com
  settings:
    ui.default-command: log
    ui.diff-formatter: ":git"
    ui.paginate: never
    revset-aliases."trunk()": main@origin
    aliases.l: [log, -r, "all()"]
```

Write keys the way `jj config list` prints them. A key that names a table (`ui`
rather than `ui.paginate`) is rejected; set the keys inside it instead.

## Pre-flight checks

Swamp runs these before each method; skip one with `--skip-check <name>` or a
group with `--skip-check-label <label>`.

| Check                       | Label    | Methods     | Fails when                                                                  |
| --------------------------- | -------- | ----------- | --------------------------------------------------------------------------- |
| `platform-supported`        | `policy` | `install`   | the OS or architecture has no jj build, or the method doesn't run on the OS |
| `package-manager-available` | `live`   | `install`   | `installMethod` is `brew` or `winget` and that command isn't installed      |
| `jj-installed`              | `live`   | `configure` | no jj can be found                                                          |

## Usage

```sh
swamp extension pull @taylor/jj
swamp model create @taylor/jj/cli jj \
  --global-arg userName="Your Name" --global-arg userEmail=you@example.com
swamp model method run jj install
swamp model method run jj configure
```

Later, check for drift or move to the newest jj:

```sh
swamp model method run jj sync
swamp model method run jj install --input upgrade=true
```

To pin a version on any platform, use the release build:

```sh
swamp model create @taylor/jj/cli jj \
  --global-arg installMethod=release --global-arg version=0.46.0
```

## What it runs

```
jj --version                                                   # find jj (each candidate)
brew --version / winget --version                              # auto: is the package manager there?

# release
GET https://api.github.com/repos/jj-vcs/jj/releases/latest     # or /releases/tags/v<version>
GET <asset browser_download_url>                               # then SHA-256 checked against the asset digest
tar -xf <archive> -C <temp dir>                                # %SystemRoot%\System32\tar.exe on Windows

# brew
brew list --versions jj
brew install jj | brew upgrade jj
brew --prefix

# winget
winget list --id jj-vcs.jj --exact
winget install --id jj-vcs.jj --exact --silent ... [--version <v> --force]
winget upgrade --id jj-vcs.jj --exact --silent ...

# configure / sync
jj config path --user
jj config list --user -T 'json(value) ++ "\n"' <key>
jj config set --user <key> <toml value>
```

## Development

```sh
~/.swamp/deno/deno test --no-config --allow-all extensions/
```

## License

AGPL-3.0 with the Swamp Extension and Definition Exception; see
[LICENSE](LICENSE), [COPYING](COPYING) and
[COPYING-EXCEPTION](COPYING-EXCEPTION).
