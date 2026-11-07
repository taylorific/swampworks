# @taylor/roam-graph workflow

`@taylor/roam-review` writes a periodic review for a Roam Research graph: a
weekly summary from the Activities on the daily notes, or a monthly, quarterly
or yearly rollup of the summaries below it. See the [legend](legend.md) for what
the shapes and colours mean.

<!-- swamp-diagram: workflow-taylor-roam-review -->

```mermaid
---
title: "@taylor/roam-review"
config:
  themeVariables:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
  flowchart:
    curve: linear
    nodeSpacing: 40
    rankSpacing: 45
    wrappingWidth: 320
    subGraphTitleMargin:
      top: 4
      bottom: 12
---
flowchart TD
  subgraph job_review["review"]
    direction TB
    s_review_collect("collect<br/><small>roam · collect</small>"):::state
    s_review_summarise("summarise<br/><small>roam-summarizer · generate</small>"):::state
    s_review_publish("publish<br/><small>roam · publish</small>"):::state
  end
  style job_review fill:transparent,stroke:#9ca3af,stroke-width:1px,stroke-dasharray:4 3
  s_review_collect --> s_review_summarise
  s_review_summarise --> s_review_publish
  classDef state fill:transparent,stroke:#14b8a6,stroke-width:1.5px
  classDef highlight fill:#22c55e33,stroke:#22c55e,stroke-width:1.5px,stroke-width:3px,font-weight:bold
  classDef failure fill:#ef444426,stroke:#ef4444,stroke-width:1.5px
  classDef dot fill:#3b82f6,stroke:#3b82f6,color:#3b82f6
  classDef dashed fill:transparent,stroke:#14b8a6,stroke-width:1.5px,stroke-dasharray:5 3
  linkStyle 0 stroke:#3b82f6,stroke-width:1.5px
  linkStyle 1 stroke:#3b82f6,stroke-width:1.5px
```

<!-- /swamp-diagram -->

`collect` gathers the period's sources and builds the prompt, `summarise` writes
the summary with Claude, and `publish` writes it to the graph as a heading block
on the daily note of the Monday after the period ends.
