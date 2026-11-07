# @swamp/issue-lifecycle

[@swamp/issue-lifecycle](https://swamp-club.com/extensions/@swamp/issue-lifecycle)
drives a swamp-club issue from triage to a shipped release as a typed state
machine: every method checks the issue's current phase first, so a phase can't
be skipped. See the [legend](legend.md) for what the shapes and colours mean.

<!-- swamp-diagram: state-machine-swamp-issue-lifecycle -->

```mermaid
---
title: "@swamp/issue-lifecycle"
config:
  flowchart:
    padding: 20
    curve: linear
    nodeSpacing: 40
    rankSpacing: 45
    wrappingWidth: 320
    subGraphTitleMargin:
      top: 4
      bottom: 12
---
flowchart TD
  __start(( )):::dot
  st_triaging("triaging<br/><small>reads CLAUDE.md + design + skills</small>"):::state
  st_classified("classified<br/><small>bug · feature · security</small>"):::state
  st_plan_generated("plan_generated<br/><small>↺ iterate</small>"):::state
  st_approved("approved"):::highlight
  st_implementing("implementing<br/><small>under CLAUDE.md</small>"):::state
  st_pr_open("pr_open<br/><small>CI · 5 merge gates</small><br/><small>↺ link_pr</small>"):::state
  st_pr_failed("pr_failed"):::failure
  st_releasing("releasing"):::state
  st_notify("notify<br/><small>thanks contributor</small>"):::state
  st_summarizing("summarizing"):::state
  st_done("done<br/><small>auto-merged #amp; shipped</small>"):::highlight
  __start -->|"start"| st_triaging
  st_triaging -->|"triage"| st_classified
  st_classified -->|"plan"| st_plan_generated
  st_plan_generated ==>|"approve"| st_approved
  st_approved -->|"implement"| st_implementing
  st_implementing -->|"link_pr"| st_pr_open
  st_pr_open -->|"pr_failed"| st_pr_failed
  st_pr_failed -->|"link_pr (retry)"| st_pr_open
  st_pr_failed -->|"implement (retry)"| st_implementing
  st_pr_open -->|"pr_merged"| st_releasing
  st_releasing -->|"ship"| st_notify
  st_notify -->|"notify / skip_notify"| st_summarizing
  st_summarizing -->|"summarize"| st_done
  classDef state fill:transparent,stroke:#14b8a6,stroke-width:1.5px
  classDef highlight fill:#22c55e33,stroke:#22c55e,stroke-width:1.5px,stroke-width:3px
  classDef failure fill:#ef444426,stroke:#ef4444,stroke-width:1.5px
  classDef dot fill:#3b82f6,stroke:#3b82f6,color:#3b82f6
  classDef dashed fill:transparent,stroke:#14b8a6,stroke-width:1.5px,stroke-dasharray:5 3
  linkStyle 0 stroke:#3b82f6,stroke-width:1.5px
  linkStyle 1 stroke:#3b82f6,stroke-width:1.5px
  linkStyle 2 stroke:#3b82f6,stroke-width:1.5px
  linkStyle 3 stroke:#22c55e,stroke-width:3px
  linkStyle 4 stroke:#3b82f6,stroke-width:1.5px
  linkStyle 5 stroke:#3b82f6,stroke-width:1.5px
  linkStyle 6 stroke:#ef4444,stroke-width:1.5px
  linkStyle 7 stroke:#ef4444,stroke-width:1.5px
  linkStyle 8 stroke:#ef4444,stroke-width:1.5px
  linkStyle 9 stroke:#3b82f6,stroke-width:1.5px
  linkStyle 10 stroke:#3b82f6,stroke-width:1.5px
  linkStyle 11 stroke:#3b82f6,stroke-width:1.5px
  linkStyle 12 stroke:#3b82f6,stroke-width:1.5px
```

<!-- /swamp-diagram -->

The diagram is drawn from the transition list in the extension's published
description, simplified to the main path: `created` is shown as the entry dot,
`verifying` is folded into the `link_pr` arrow, and the `complete` shortcuts
(which end a lifecycle without a PR) are left out.

- **A person approves the plan.** `approve` is the one transition the agent
  never makes on its own; `iterate` revises the plan, and adversarial review
  findings must be resolved before it is allowed.
- **A failed PR goes back to work.** From `pr_failed`, `link_pr` opens a new PR
  or `implement` restarts the implementation.
- **The issue's reporter is thanked** in `notify` (or that step is skipped)
  before the session is summarised.
