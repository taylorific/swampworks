// Files that `scaffold` adds to a deck created by `init`: page numbers,
// a GitHub Pages deploy workflow, a README, a licence and a starter
// slides.md. Vue and YAML here are written out verbatim; the functions only
// fill in the deck's name, title and author.

/** Values a scaffolded deck is personalised with. */
export interface DeckInfo {
  /** Repository and directory name; also the Pages base path. */
  name: string;
  title: string;
  author: string;
  email?: string;
  /** Copyright holder for LICENSE; omitted when empty. */
  copyright?: string;
  year: number;
}

/**
 * Page number component, from slidev-theme-academic by Alexander Eble
 * (https://github.com/alexanderdavide/slidev-theme-academic).
 */
export const PAGINATION_VUE = `<template>
  <div class="absolute p-2 text-xs" :class="classNames"><SlideCurrentNo /> / <SlidesTotal /></div>
</template>

<script setup lang="ts">
import { computed, PropType } from 'vue';

const {
  classNames: classNamesTransferred,
  x,
  y,
} = defineProps({
  classNames: {
    type: [Array, String] as PropType<string[] | string>,
  },
  x: {
    default: 'r',
    type: String as PropType<'l' | 'r'>,
    validator: (value) => value === 'l' || value === 'r',
  },
  y: {
    default: 't',
    type: String as PropType<'b' | 't'>,
    validator: (value) => value === 'b' || value === 't',
  },
});

const classNames = computed(() => [
  ...(classNamesTransferred
    ? Array.isArray(classNamesTransferred)
      ? classNamesTransferred
      : [classNamesTransferred]
    : []),
  x === 'l' && 'left-0',
  x === 'r' && 'right-0',
  y === 't' && 'top-0',
  y === 'b' && 'bottom-0',
]);
</script>
`;

/** Shows Pagination on every slide, driven by themeConfig in slides.md. */
export const GLOBAL_TOP_VUE = `<!-- global-top.vue -->
<template>
  <Pagination
    v-if="
      $slidev.nav.currentPage !== $slidev.nav.total + 1 &&
      !$slidev.themeConfigs.paginationPagesDisabled?.includes($slidev.nav.currentPage) &&
      ($slidev.themeConfigs.paginationX || $slidev.themeConfigs.paginationY)
    "
    :x="$slidev.themeConfigs.paginationX"
    :y="$slidev.themeConfigs.paginationY"
  />
</template>
`;

/** Written only when the Slidev template didn't create one. */
export const GITIGNORE = `node_modules
.DS_Store
dist
*.local
.vite-inspect
.remote-assets
components.d.ts
`;

/** Builds the deck and deploys it to GitHub Pages at /<name>/. */
export function deployYml(name: string): string {
  return `name: Deploy pages

on:
  workflow_dispatch: {}
  push:
    branches:
      - main

jobs:
  deploy:
    runs-on: ubuntu-latest

    permissions:
      contents: read
      pages: write
      id-token: write

    environment:
      name: github-pages
      url: \${{ steps.deployment.outputs.page_url }}

    steps:
      - uses: actions/checkout@v7

      - uses: actions/setup-node@v6
        with:
          node-version: 'lts/*'

      - name: Install dependencies
        run: npm ci

      - name: Build
        run: npm run build -- --base /${name}/

      - uses: actions/configure-pages@v6

      - uses: actions/upload-pages-artifact@v5
        with:
          path: dist

      - name: Deploy
        id: deployment
        uses: actions/deploy-pages@v5
`;
}

/** Code under Apache-2.0, slides under CC BY 4.0, logos excluded. */
export function license(info: DeckInfo): string {
  return `${
    info.copyright ? `Copyright (c) ${info.year} ${info.copyright}\n\n` : ""
  }The code in this repository is licensed under the Apache License
Version 2.0. You may obtain a copy of this license at:

    http://www.apache.org/licenses/LICENSE-2.0

The instructions and slides in this repository (e.g. the files
with extension .md in the root and "pages" directories) are
under the Creative Commons Attribution 4.0 International Public
License. You may obtain a copy of this license at:

    https://creativecommons.org/licenses/by/4.0/legalcode

Logos and trademarks in the "public/images" directory belong to
their respective owners and are not covered by either license.
`;
}

/** How to run, update and credit the deck. */
export function readme(info: DeckInfo): string {
  const fence = "```";
  return `# ${info.title}

To start the slide show:

${fence}
docker run -it --rm \\
  --mount type=bind,source="$(pwd)",target="/slidev" \\
  --publish 3030:3030 \\
  docker.io/boxcutter/slidev

# Visit <http://localhost:3030/>
${fence}

Edit the [slides.md](./slides.md) to see the changes.

Learn more about Slidev at the [documentation](https://sli.dev/).

# Update dependencies

To see what is out of date:

${fence}bash
docker run -it --rm \\
  --mount type=bind,source="$(pwd)",target="/slidev" \\
  --entrypoint npm \\
  docker.io/boxcutter/slidev outdated
${fence}

To upgrade Slidev and the themes to their latest versions:

${fence}bash
docker run -it --rm \\
  --mount type=bind,source="$(pwd)",target="/slidev" \\
  --entrypoint npm \\
  docker.io/boxcutter/slidev \\
    install @slidev/cli@latest @slidev/theme-default@latest @slidev/theme-seriph@latest

# on the host
git add package.json package-lock.json
git commit -m "Sync npm lockfile"
git push
${fence}

# Attributions

The following projects were used for inspiration and some code was
reused for the slideware:

- https://sli.dev/ - Slidev slideware
- https://github.com/alexanderdavide/slidev-theme-academic  Pagination  - Alexander Eble
- https://github.com/jpetazzo/container.training - Idea of using markdown slideware for training - Jérôme Petazzoni
`;
}

/** A cover slide, a table of contents and a first section. */
export function slidesMd(info: DeckInfo): string {
  // JSON strings are valid YAML scalars, so titles with colons stay intact.
  const yaml = (s: string) => JSON.stringify(s);
  return `---
theme: seriph
# random image from a curated Unsplash collection by Anthony
# like them? see https://unsplash.com/collections/94734566/slidev
background: https://cover.sli.dev
hideInToc: true
title: ${yaml(info.title)}
author: ${yaml(info.author)}
info: |
  ## ${info.title}
# apply unocss classes to the current slide
class: text-center
# https://sli.dev/features/drawing
drawings:
  persist: false
# enable MDC Syntax: https://sli.dev/features/mdc
mdc: true
themeConfig:
  paginationX: r
  paginationY: t
  paginationPagesDisabled: [1]
---

# ${info.title}

##### ${info.author}${info.email ? ` | 📧 <${info.email}>` : ""}

<div @click="$slidev.nav.next" class="mt-12 py-1" hover:bg="white op-10">
  Press Space for next page <carbon:arrow-right />
</div>

<div class="abs-br m-6 text-xl">
  <button @click="$slidev.nav.openInEditor()" title="Open in Editor" class="slidev-icon-btn">
    <carbon:edit />
  </button>
  <a href="https://github.com/slidevjs/slidev" target="_blank" class="slidev-icon-btn">
    <carbon:logo-github />
  </a>
</div>

<!--
The last comment block of each slide will be treated as slide notes. It will be visible and editable in Presenter Mode along with the slide. [Read more in the docs](https://sli.dev/guide/syntax.html#notes)
-->

---
hideInToc: true
routeAlias: toc
---

# Table of Contents

<Toc columns="2"/>

---
layout: section
---

# Getting started

<br>
<br>
<Link to="toc" title="Table of Contents"/>
`;
}
