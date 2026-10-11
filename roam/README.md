# roam-graph

A [swamp](https://swamp.club/) extension that keeps a ladder of periodic reviews
in a [Roam Research](https://roamresearch.com/) graph:

| Review    | Written from                                | Heading                         |
| --------- | ------------------------------------------- | ------------------------------- |
| Weekly    | The `Activities` block on each daily note   | `Week Ending October 9, 2026`   |
| Monthly   | The weekly summaries that overlap the month | `Monthly Rollup September 2026` |
| Quarterly | The monthly rollups in the quarter          | `Quarterly Rollup Q3 2026`      |
| Yearly    | The quarterly rollups in the year           | `Yearly Rollup 2026`            |

Each review is published on the daily note of the first Monday after its period
ends: Week Ending October 9 on Monday October 12, the September rollup on Monday
October 5.

Weeks run Saturday to Friday. Rollups find their sources by searching the graph
for those headings, so a summary you wrote or edited by hand is rolled up just
like a generated one. Both `Week Ending 2026-09-18` and
`Week Ending October 2, 2026` are recognised.

## How it works

The `@taylor/roam/graph` model type (`extensions/models/roam_graph.ts`) talks to
Roam's [backend API](https://roamresearch.com/#/app/developer-documentation)
directly — no MCP server or other process to run. The `@taylor/roam-review`
workflow chains three steps:

1. **`roam.collect`** works out the period, gathers its source text (daily-note
   entries, or the child summaries) and builds the prompt. Long pasted code
   blocks are replaced with `[code block omitted]`. It fails if there is nothing
   to summarise, and warns about child periods with no summary.
2. **`roam-summarizer.generate`** (`@keeb/anthropic/claude`) writes the summary
   as a Markdown outline, grouped into themes and ending with an overall theme
   or outcome.
3. **`roam.publish`** writes the outline into the graph as a heading block with
   nested children, creating the daily note if needed, and stores the summary as
   swamp data (`summary-week-2026-10-09`, `summary-month-2026-09`, ...).

If the period already has a summary in the graph, `publish` leaves it alone by
default. Pass `ifExists=replace` to replace its contents in place (the heading
block and its position are kept) or `ifExists=fail` to stop.

## Setup

1. In Roam, create an API token with **edit** access: Settings → Graph → API
   tokens.
2. Store it, your graph name and an Anthropic API key in a vault:

   ```sh
   swamp vault create local_encryption roam-secrets
   swamp vault put roam-secrets ROAM_API_TOKEN
   swamp vault put roam-secrets ROAM_GRAPH          # as in roamresearch.com/#/app/<graph>
   swamp vault put roam-secrets ANTHROPIC_API_KEY
   ```

3. Create the two models the workflow expects:

   ```sh
   swamp model create @taylor/roam/graph roam \
     --global-arg 'token=${{ vault.get("roam-secrets", "ROAM_API_TOKEN") }}' \
     --global-arg 'graph=${{ vault.get("roam-secrets", "ROAM_GRAPH") }}'
   swamp model create @keeb/anthropic/claude roam-summarizer \
     --global-arg 'apiKey=${{ vault.get("roam-secrets", "ANTHROPIC_API_KEY") }}' \
     --global-arg model=claude-opus-5-5 --global-arg maxTokens=8192
   ```

   `models/@keeb/anthropic/claude/roam-summarizer.yaml` in this repository has
   the system prompt used here.

The section read from daily notes defaults to `Activities` (matched
case-insensitively, with or without `[[ ]]`, `#`, `**` or a trailing colon); set
the `section` global argument on `roam` to use another.

## Usage

```sh
swamp workflow run @taylor/roam-review --input kind=week                     # the week that ended last Friday (or today, on a Friday)
swamp workflow run @taylor/roam-review --input kind=month                    # last month
swamp workflow run @taylor/roam-review --input kind=quarter --input date=2026-08-15
swamp workflow run @taylor/roam-review --input kind=year --input date=2026-12-31
swamp workflow run @taylor/roam-review --input kind=week --input date=2026-10-09 --input ifExists=replace
```

`date` is any day in the period, `current` for the period containing today, or
`last` (the default) for the most recent period that has ended. Dates follow the
machine's local time zone, as Roam's daily notes do.

### Without an API key

The bundled `roam-review` skill runs the same steps from an agent session
(Claude Code and the like) with the agent writing the summary, so no Anthropic
API key or `roam-summarizer` model is needed. Ask for "my weekly review" or
"roll up September": it runs `roam.collect`, writes the summary from the
collected prompt, shows you the draft, and runs `roam.publish` once you approve
it.

To see what would be summarised without calling Claude or writing to the graph:

```sh
swamp model method run roam collect --input kind=month --input date=2026-09-01
swamp data query 'modelName == "roam" && name == "source"' --select content
```

`roam.dailies` reads the section from every daily note in a date range
(`--input start=2026-09-01 --input end=2026-09-30`) without building a prompt.

## Privacy

Only the children of the `Activities` block (for weeklies) and the summary
blocks (for rollups) are read and sent to Anthropic; nothing else on your daily
notes leaves the graph. Anything you put under `Activities` does, so keep
credentials out of it.

## Development

```sh
~/.swamp/deno/deno test --no-config --allow-all extensions/
```

The tests run every method against an in-memory fake of the Roam API.

## License

AGPL-3.0 with the Swamp Extension and Definition Exception; see
[LICENSE](LICENSE), [COPYING](COPYING) and
[COPYING-EXCEPTION](COPYING-EXCEPTION).
