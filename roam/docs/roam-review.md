# @taylor/roam-review

Writes a periodic review for a Roam Research graph: a weekly summary from the
Activities on the daily notes, or a monthly, quarterly or yearly rollup of the
summaries below it.

Source:
[`workflows/workflow-roam-review.yaml`](../workflows/workflow-roam-review.yaml).
See the [legend](../../swamp-diagrams/docs/legend.md) for what the shapes and
colours mean.

<!-- swamp-diagram: workflow-taylor-roam-review -->

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="diagrams/workflow-taylor-roam-review-dark.svg">
  <img alt="@taylor/roam-review" src="diagrams/workflow-taylor-roam-review-light.svg">
</picture>

<!-- /swamp-diagram -->

`collect` gathers the period's sources and builds the prompt, `summarise` writes
the summary with Claude, and `publish` writes it to the graph as a heading block
on the daily note of the Monday after the period ends.
