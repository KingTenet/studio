---
name: artifact-index
description: >
  Write (or rewrite) the app's artifact index: one Claude-authored HTML page that puts the
  app and the feature being built in context and shows every artifact made in it as a card, with a
  summary, how the artifacts relate, and which overlap, contradict each other, are out of date or
  wait on a decision; then publish it. With `consolidate`, also merge overlapping artifacts into
  fewer, simpler, current ones and mark the originals superseded. Started by the cockpit's
  Artifacts buttons (artifact-index-in-herdr.sh). Use on "/artifact-index", "rebuild the
  artifact index", "/artifact-index consolidate", "consolidate the artifacts".
---

# Artifact index

Every artifact published from this worktree is recorded by a hook (scripts/lib/artifacts.js)
with a snapshot of what was published. Your job is the overview a person reads first: what this
worktree is for, what each artifact says, and how they fit together.

## 1. Load the registry

```sh
node "$STUDIO_DIR"/scripts/lib/artifacts.js where
```

It prints `folder` (this worktree's artifact folder), `artifacts` (each with `id`, `url`, `name`,
`versions`, `latest.snapshot`, `supersededBy`) and `index` (the previous index's `url` and how many
publishes came since, or null). If `artifacts` is empty, say there is nothing to index and stop.

## 2. Gather the context

- What the app is and how it got here: `FEATURES.md` in the app's folder.
- The feature being built, if any: the checkpoints on `develop` since `main` (`git log --oneline main..develop`).
- The artifacts themselves.

## 3. Read every artifact

For each artifact, read its latest snapshot, `<folder>/<latest.snapshot>/index.html` (plus the
supporting files beside it when the page's content lives in them). When there is no snapshot, read
the published page with the Artifact tool's `read` action on its `url`. Where an artifact has
several versions with snapshots, compare the first and last when that tells you how its
conclusions moved.

For each one, work out:
- what question it answers or what it decides, in one or two sentences;
- what it builds on, overlaps with, contradicts or replaces among the others;
- whether it is still current against the code and the ticket now, and why not if it isn't;
- any decision it waits on (an open question, an option it recommends but nobody has chosen).

## 4. Write the index

Load the `artifact-design` skill first, then write `<folder>/index.html` (overwrite the old one).
Be creative about the form; it needn't look like any other index. It must:

- open with the context: what the app is, the feature being built, where it stands, what is still open;
- list **every** artifact in the registry, each as a card with its name, your summary, when it was
  last published, how many versions it has, and a link to its `url` (`target="_blank"`);
- show how the artifacts relate, in whatever form explains it best (a dependency graph, a timeline,
  lanes per question, clusters), and say why each relationship holds;
- flag artifacts that overlap, contradict each other, are out of date, or depend on a decision, and
  collect the open decisions in one place;
- show superseded artifacts (`supersededBy` set) dimmed, with a link to what replaced them.

Give the page a short `<title>` such as `My App artifacts`. Link artifacts by their claude.ai URLs,
never local snapshot paths: the page is also published, where those don't exist. Give other links
`target="_blank"` so they open outside the cockpit.

End the page with this script, unchanged. In the cockpit's Artifacts pane it treats artifact links
the way the rest of the cockpit does: a plain click previews the artifact in the pane, and a
⌘/Ctrl/Shift or middle click opens its local copy in a tab. On claude.ai it does nothing, and the
links open as usual.

```html
<script>
if (window.parent !== window && location.pathname.startsWith('/_env/')) {
  const artifactId = (link) => /^https:\/\/claude\.ai\/(?:code\/)?artifact\/([A-Za-z0-9_-]+)/.exec(link?.getAttribute('href') ?? '')?.[1];
  const open = (event) => {
    const link = event.target.closest?.('a[href]');
    const id = artifactId(link);
    if (!id || (event.type === 'auxclick' && event.button !== 1)) return;
    event.preventDefault();
    if (event.type === 'click' && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
      parent.postMessage({ type: 'studio-artifact-preview', id }, '*');
    } else {
      window.open('http://localhost/_env/artifact/' + id + '/', '_blank', 'noopener');
    }
  };
  document.addEventListener('click', open);
  document.addEventListener('auxclick', open);
}
</script>
```

## 5. Publish it

- With a previous index (`index.url`): read it first with the Artifact tool's `read` action on that
  url, then publish `<folder>/index.html` with `url` set to it, so the link stays the same.
- Without one: publish `<folder>/index.html` as a new artifact.

Then record it, with the url the publish returned:

```sh
node "$STUDIO_DIR"/scripts/lib/artifacts.js mark-built <url>
```

The hook leaves the index itself out of the registry.

## Consolidate (`/artifact-index consolidate`)

After step 3, before writing the index:

1. Propose a plan: groups of artifacts that overlap or have drifted, each to become one simpler,
   current artifact, with what it would keep, drop and correct. Leave alone the ones that stand on
   their own.
2. Ask with AskUserQuestion which groups to go ahead with. Stop at the plan if none.
3. For each group you're told to go ahead with, write the consolidated page in your scratchpad,
   publish it as a new artifact, then mark the ones it replaces:
   ```sh
   node "$STUDIO_DIR"/scripts/lib/artifacts.js supersede <new-id> <old-id>…
   ```
   (`<id>` is the last part of an artifact's url.) Never delete an artifact: superseded ones stay
   reachable from the index.
4. Run `where` again, then carry on from step 4 so the index shows the result.

## Finish

End with one line naming what changed and the index's link.
