# @taylor/slidev workflow

`@taylor/slidev-new-deck` creates a Slidev deck and publishes it to GitHub
Pages. See the [legend](legend.md) for what the shapes and colours mean.

<!-- swamp-diagram: workflow-taylor-slidev-new-deck -->

```mermaid
---
title: "@taylor/slidev-new-deck"
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
  subgraph job_new_deck["new-deck"]
    direction TB
    s_new_deck_init("init<br/><small>deck-${{ inputs.name }} · init</small>"):::state
    s_new_deck_scaffold("scaffold<br/><small>deck-${{ inputs.name }} · scaffold</small>"):::state
    s_new_deck_build("build<br/><small>deck-${{ inputs.name }} · build</small>"):::state
    s_new_deck_repo("repo<br/><small>repo-${{ inputs.name }} · ensure</small>"):::state
    s_new_deck_pages("pages<br/><small>pages-${{ inputs.name }} · ensure</small>"):::state
    s_new_deck_push("push<br/><small>deck-${{ inputs.name }} · push</small>"):::state
  end
  style job_new_deck fill:transparent,stroke:#9ca3af,stroke-width:1px,stroke-dasharray:4 3
  s_new_deck_init --> s_new_deck_scaffold
  s_new_deck_scaffold --> s_new_deck_build
  s_new_deck_build --> s_new_deck_repo
  s_new_deck_repo --> s_new_deck_pages
  s_new_deck_pages --> s_new_deck_push
  classDef state fill:transparent,stroke:#14b8a6,stroke-width:1.5px
  classDef highlight fill:#22c55e33,stroke:#22c55e,stroke-width:1.5px,stroke-width:3px,font-weight:bold
  classDef failure fill:#ef444426,stroke:#ef4444,stroke-width:1.5px
  classDef dot fill:#3b82f6,stroke:#3b82f6,color:#3b82f6
  classDef dashed fill:transparent,stroke:#14b8a6,stroke-width:1.5px,stroke-dasharray:5 3
  linkStyle 0 stroke:#3b82f6,stroke-width:1.5px
  linkStyle 1 stroke:#3b82f6,stroke-width:1.5px
  linkStyle 2 stroke:#3b82f6,stroke-width:1.5px
  linkStyle 3 stroke:#3b82f6,stroke-width:1.5px
  linkStyle 4 stroke:#3b82f6,stroke-width:1.5px
```

<!-- /swamp-diagram -->

The deck is checked to build before anything is created on GitHub, and Pages is
set to build from GitHub Actions before the first push, so that push's deploy
succeeds.
