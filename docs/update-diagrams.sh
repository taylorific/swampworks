#!/bin/sh
# Redraw every diagram in docs/ from the workflows and state machines it shows.
# Each diagram replaces the code block between its <!-- swamp-diagram: name -->
# and <!-- /swamp-diagram --> markers; the prose around them is untouched.
set -eu
cd "$(dirname "$0")/../swamp-diagrams"

swamp behavior run swampworks-docs workflow --input dir=..

swamp behavior run swampworks-docs stateMachine \
  --input extension=@swamp/issue-lifecycle \
  --input 'humanGates=["approve"]' \
  --input 'highlightStates=["approved"]' \
  --input 'hideStates=["created"]' \
  --input 'collapseStates=["verifying"]' \
  --input 'omitMethods=["complete"]' \
  --input 'notes={"triaging":"reads CLAUDE.md + design + skills","classified":"bug · feature · security","implementing":"under CLAUDE.md","pr_open":"CI · 5 merge gates","notify":"thanks contributor","done":"auto-merged & shipped"}'
