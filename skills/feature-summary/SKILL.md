---
name: feature-summary
description: >
  Write what a feature of the app does, in plain words: the entry Keep adds to the app's FEATURES.md
  and shows before the feature is kept. Run headless by feature-summary.sh
  (`claude -p "/studio:feature-summary <digest file>"`), which uses what you print.
  Use on "/feature-summary <digest file>".
---

# Feature summary

The argument is the path of a digest file. Read all of it with the Read tool (use `offset` if one
read doesn't cover it). It holds, in order:

- the feature's name;
- its checkpoints, oldest first: what each change did, and what she asked for (later ones can
  undo or change earlier ones);
- the files changed, and the changes themselves (possibly cut short);
- the app's FEATURES.md so far: what earlier versions added.

## What to print

Print **only** the summary: one paragraph of plain text, with nothing before or after it. No
heading (Keep adds `## vN <name>` itself), no preamble, no "Here is the summary", no code fence.
Whatever you print goes into FEATURES.md as is.

- 2–4 sentences, about 40–90 words, in the style of the FEATURES.md entries already there.
- Say what the app now does that it didn't, as someone using it would see it: the page, what's on
  it, what it lets you do, what is remembered.
- Then, briefly, where it lives for whoever builds on it later: the route or page, and the API
  calls or tables it adds or changes, in backticks, when the changes show them.
- Describe the end result, not the steps or the conversation. Skip what was tried and undone.
- Use her names for things, from what she asked for.
