#!/bin/sh
# Redraw the diagrams in every extension's docs/ folder. Each diagram replaces
# what's between its <!-- swamp-diagram: name --> and <!-- /swamp-diagram -->
# markers; the prose around them is untouched, and unchanged diagrams aren't
# rewritten.
set -eu
cd "$(dirname "$0")/../swamp-diagrams"

# Every workflow in the repository.
swamp behavior run swampworks-docs workflow --input dir=..

# A behavior's lifecycle, from the transition lines in its docs page.
sm() {
  swamp behavior run swampworks-docs stateMachine "$@"
}

sm --input path=../jj/docs/cli.md --input 'title=@taylor/jj/cli' --input 'hideStates=["absent"]' --input 'backEdges=normal' --input 'notes={"installed": "Homebrew, winget or the checked GitHub release", "configured": "only keys that differ are changed", "removed": "only the jj this behavior installed"}'
sm --input path=../netbox/docs/instance.md --input 'title=@taylor/netbox/instance' --input 'hideStates=["absent"]' --input 'backEdges=normal' --input 'notes={"running": "NetBox, worker, PostgreSQL, Valkey; superuser and token", "stopped": "containers and volumes kept", "removed": "volumes kept unless deleteVolumes"}'
sm --input path=../nexus/docs/instance.md --input 'title=@taylor/nexus/instance' --input 'hideStates=["absent"]' --input 'backEdges=normal' --input 'notes={"running": "ready, onboarding complete", "stopped": "container and data kept", "deleted": "data volume kept unless removeVolume"}'
sm --input path=../nexus/docs/config.md --input 'title=@taylor/nexus/config' --input 'notes={"declared": "realms, blob stores, roles, users, repositories", "matching": "prune=true also deletes undeclared ones"}'
sm --input path=../github/docs/repo.md --input 'title=@taylor/github/repo' --input 'notes={"exists": "an existing repository is reported unchanged"}'
sm --input path=../github/docs/owner.md --input 'title=@taylor/github/owner' --input 'notes={"on_github": "list: newest first, optionally only the last N days", "local_copies": "clones or mirrors; force-pushed history in backup refs; only repos active since the last sync"}'
sm --input path=../github-pages/docs/site.md --input 'title=@taylor/github-pages/site' --input 'notes={"actions": "Pages builds from GitHub Actions"}'
sm --input path=../emudhra/docs/exposure.md --input 'title=@taylor/emudhra/exposure' --input 'notes={"report": "per target: trusted, not trusted, or failed"}'
sm --input path=../webshot/docs/capture.md --input 'title=@taylor/webshot' --input 'notes={"page": "fresh headless-shell container per capture", "loaded": "scrolled until the page stops growing", "image": "PNG, JPEG or WebP, any height", "failed": "nothing saved"}'
sm --input path=../transcripts/docs/transcriber.md --input 'title=@taylor/whisper-transcriber' --input 'notes={"image": "under the container CLI or Docker", "transcripts": ".txt, .srt, .vtt and .json"}'
sm --input path=../swamp-training/docs/deck.md --input 'title=@taylor/swamp-training/deck' --input 'hideStates=["untested"]' --input 'backEdges=normal' --input 'notes={"tested": "commands, lab and installed files checked", "behind": "a swamp release newer than the last one tested"}'
sm --input path=../slidev/docs/deck.md --input 'title=@taylor/slidev/deck' --input 'hideStates=["none"]' --input 'backEdges=normal' --input 'notes={"deck": "from the Slidev template", "scaffolded": "page numbers, Pages workflow, README, LICENSE", "serving": "dev server in a background container", "builds": "production build passes", "pushed": "Pages deploys from origin"}'
sm --input path=../roam/docs/graph.md --input 'title=@taylor/roam/graph' --input 'backEdges=normal' --input 'notes={"prompt": "weekly: daily-note Activities; rollups: the summaries below", "summary": "written with Claude", "on_the_graph": "heading block on the Monday after the period"}'
sm --input path=../libvirt/docs/vm.md --input 'title=@taylor/libvirt/vm' --input 'hideStates=["absent"]' --input 'notes={"running": "waits for its address; apply starts a shut-down VM", "removed": "with its storage"}'
sm --input path=../swamp-diagrams/docs/diagram.md --input 'title=@taylor/swamp-diagrams/diagram' --input 'notes={"transitions": "a registry description, text, or a page like this one", "diagram": "light and dark SVG, or Mermaid", "docs_page": "<picture> between the swamp-diagram markers"}'

# @swamp/issue-lifecycle, from its registry description.
swamp behavior run swampworks-docs stateMachine \
  --input extension=@swamp/issue-lifecycle \
  --input 'subtitle=a typed state machine — every transition is validated' \
  --input 'humanGates=["approve"]' \
  --input 'highlightStates=["approved"]' \
  --input 'hideStates=["created"]' \
  --input 'collapseStates=["verifying"]' \
  --input 'omitMethods=["complete"]' \
  --input 'notes={"triaging":"reads CLAUDE.md + design + skills","classified":"bug · feature · security","implementing":"under CLAUDE.md","pr_open":"CI · 5 merge gates","notify":"thanks contributor","done":"auto-merged & shipped"}'
