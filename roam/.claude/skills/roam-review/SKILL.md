---
name: roam-review
description: >
  Write and publish a Roam Research periodic review interactively with the
  @taylor/roam-graph extension — a weekly summary of the Activities on daily
  notes, or a monthly, quarterly or yearly rollup — with the agent writing the
  summary instead of an API-key LLM model. Use when asked for a weekly review,
  week summary, monthly/quarterly/yearly rollup, "summarize my week", "roll up
  September", or to preview or redo a Roam summary.
---

# Roam review (interactive)

The `@taylor/roam-review` workflow writes summaries with an Anthropic API key.
This skill does the same job without one: `collect` gathers the source and the
prompt, you write the summary, and `publish` writes it to the graph. Run the
commands from the swamp repository that has the `roam` model.

## 1. Collect

```sh
swamp model method run roam collect --input kind=<week|month|quarter|year> --input date=<last|current|YYYY-MM-DD>
swamp data query 'modelName == "roam" && name == "source"' --select content --json
```

`date` defaults to `last`, the most recent period that has ended. A week runs
Saturday to Friday. If collect fails because there is nothing to summarise, say
so and stop — for a rollup, the child summaries must be published first. Tell
the user about any periods listed in `missing`.

## 2. Write the summary

The source record has `title`, `key`, `kind`, `start`, `end`, `targetDate` and
`prompt`. **Follow `prompt` exactly** — it holds the length, structure, style
and ticket rules, then the source text. Write only from the source; never add
anything that is not in it.

Show the user the draft under its title, say it will go on the `targetDate`
daily note (the first Monday after the period ends), and ask whether to publish,
revise or stop. Revise until they approve. Do not publish without approval: it
writes to their graph.

## 3. Publish

Write the approved outline to a YAML file in the scratchpad (a block scalar
avoids shell quoting problems), then publish it:

```yaml
kind: week
key: "2026-10-09"
ifExists: skip
markdown: |
  - **Theme**
    - point
  - **Overall theme:** ...
```

```sh
swamp model method run roam publish --input-file <file>.yaml --json
```

Use `kind` and `key` from the source record, not from the original inputs.
`ifExists`:

- `skip` (default) — leave an existing summary for the period alone. If the
  result's `action` is `skipped`, tell the user a summary already exists and
  offer to rerun with `replace`.
- `replace` — replace the existing summary's contents in place. Only with the
  user's explicit OK, since it overwrites what is in their graph (possibly
  hand-written).
- `fail` — stop if one exists.

Report the `action` and the daily note it went to.
