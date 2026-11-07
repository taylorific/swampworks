# mermaid

A [swamp](https://swamp.club/) extension that draws
[Mermaid](https://mermaid.js.org/) diagrams of swamp workflows and of behaviors'
state machines.

- `workflow` draws the workflows in a repository's `workflows/` folder as
  flowcharts: a box per job, a node per step, and `dependsOn` arrows labelled
  with their condition.
- `stateMachine` draws a behavior's phases and the methods that move between
  them, from the transition lines in a published extension's description (as
  [@swamp/issue-lifecycle](https://swamp-club.com/extensions/@swamp/issue-lifecycle)
  has) or from lines you pass in.

Every diagram is saved as a `.mmd` file and a Markdown file with a fenced
`mermaid` block, which GitHub renders. It can also be rendered to SVG or PNG
with the [mermaid-cli](https://github.com/mermaid-js/mermaid-cli) container and
copied into a folder in the repository.

![@swamp/issue-lifecycle](diagrams/state-machine-swamp-issue-lifecycle.png)

## Behavior

`@taylor/mermaid/diagram`:

| Global argument | Default                               | Description                                                                       |
| --------------- | ------------------------------------- | --------------------------------------------------------------------------------- |
| `theme`         | `dark`                                | `dark` (teal phases on black), `light`, or `none` for Mermaid's own theme         |
| `direction`     | `TD`                                  | `TD` (top-down) or `LR` (left-to-right)                                           |
| `render`        | `none`                                | Also render `svg` or `png` with the mermaid-cli container (needs Docker)          |
| `outputDir`     |                                       | Folder, relative to the repository, to also copy the `.md`, `.mmd` and image into |
| `registryUrl`   | `https://swamp-club.com`              | Registry that `stateMachine` reads extension descriptions from                    |
| `dockerPath`    | `docker`                              | Docker CLI binary                                                                 |
| `mermaidImage`  | `minlag/mermaid-cli:11.12.0@sha256:…` | mermaid-cli image, pinned by digest                                               |

| Method         | What it does                                                                                    |
| -------------- | ----------------------------------------------------------------------------------------------- |
| `workflow`     | Draw one workflow (`name` or `path`) or, by default, every workflow in `workflows/`             |
| `stateMachine` | Draw a behavior's phases from `extension` (its registry description) or from `transitions` text |

Each run writes a `diagram` resource (the Mermaid source, what it was drawn
from, and where it was copied) and `mermaid`, `markdown` and, when rendering,
`image` files. Instances are named `workflow-<name>` and
`state-machine-<extension>`.

### Workflows

Steps show the behavior and method they run. Manual approvals and signal waits
are green hexagons, nested workflows are double-sided boxes, and steps with
`allowFailure` have a dashed border. A `failed` dependency is a red arrow;
`completed` and other conditions are dotted grey arrows with the condition as
the label.

### State machines

The transition notation is the one swamp extensions use in their descriptions:

```
created ──[start]──> triaging
plan_generated ──[iterate]──> plan_generated  (feedback loop)
```

ASCII arrows (`a --[method]--> b`) work too, and lines that don't match are
ignored, so a whole description or README can be passed in. Self-loops are
amber, steps back to an earlier phase are red and labelled `(retry)`, phases
whose name contains `fail` are red, and final phases are green.

| Argument          | Description                                                                           |
| ----------------- | ------------------------------------------------------------------------------------- |
| `extension`       | Published extension whose description holds the transitions                           |
| `transitions`     | Transition lines to draw instead                                                      |
| `title`           | Diagram title (defaults to the extension name)                                        |
| `subtitle`        | A line under the title in the Markdown file                                           |
| `hideStates`      | Phases to leave out; their transitions become entry or exit dots                      |
| `collapseStates`  | Phases to skip over: each way in is joined to each way out, under the outgoing method |
| `omitMethods`     | Methods whose transitions are left out                                                |
| `humanGates`      | Methods only a person may run, drawn as thick green arrows                            |
| `highlightStates` | Phases to emphasise besides the final ones                                            |
| `failureStates`   | Phases to draw as failures besides those named `*fail*`                               |
| `notes`           | A short note under a phase, keyed by phase                                            |
| `showComments`    | Add each transition's parenthetical comment to its arrow                              |

## Usage

```sh
swamp extension pull @taylor/mermaid
swamp behavior create @taylor/mermaid/diagram diagrams \
  --global-arg render=png --global-arg outputDir=docs/diagrams

# Every workflow in workflows/
swamp behavior run diagrams workflow

# One workflow
swamp behavior run diagrams workflow --input name=archive-twit-show
```

The picture above is @swamp/issue-lifecycle's published state machine, with
`created` and `verifying` folded away and the `complete` shortcuts left out:

```sh
swamp behavior run diagrams stateMachine \
  --input extension=@swamp/issue-lifecycle \
  --input 'humanGates=["approve"]' \
  --input 'highlightStates=["approved"]' \
  --input 'hideStates=["created"]' \
  --input 'collapseStates=["verifying"]' \
  --input 'omitMethods=["complete"]' \
  --input 'notes={"triaging":"reads CLAUDE.md + design + skills","classified":"bug · feature · security","implementing":"under CLAUDE.md","pr_open":"CI · 5 merge gates","notify":"thanks contributor","done":"auto-merged & shipped"}'
```

Leave out the last five inputs to draw the whole machine.

Read a diagram back:

```sh
swamp data query 'modelName == "diagrams" && name == "state-machine-swamp-issue-lifecycle"' \
  --select content
```

[diagrams/](diagrams/) has both examples as Markdown, Mermaid and PNG.

## License

AGPL-3.0-or-later with the Swamp Extension and Definition Exception; see
[LICENSE](LICENSE), [COPYING](COPYING) and
[COPYING-EXCEPTION](COPYING-EXCEPTION).
