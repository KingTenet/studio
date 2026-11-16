---
name: worktree-summary
description: >
  Write the short "where this worktree's work stands" summary shown in the cockpit's ticket panel,
  from a digest of the worktree's Claude chats and commits. Run headless by
  summary.sh (`claude -p "/worktree-summary <digest file>"`), which saves what you print.
  Use on "/worktree-summary <digest file>".
---

# Worktree summary

The argument is the path of a digest file. Read all of it with the Read tool (use `offset` if one
read doesn't cover it). It holds, in order:

- the branch (what the work is for);
- the commits on the branch;
- the previous summary, if there is one (older chats may have been left out of the digest, so carry
  forward what it says unless the chats since show it changed);
- the worktree's chats, oldest first: `YOU:` is the person, `CLAUDE:` is Claude. Later chats
  override earlier ones.

## What to print

Print **only** the summary, as Markdown, with nothing before or after it: no preamble, no
"Here is the summary", no code fence. Whatever you print is saved and shown as is.

Use this shape, about 120–200 words in total:

```
One or two sentences: what the work is for and where it stands now.

**Done**
- …

**Now**
- … (what is in progress, blocked, or waiting on someone, and on what)

**Next**
- …
```

- Leave out a section that would be empty, rather than writing "nothing".
- Be concrete: name the feature, the file or the decision, not "made progress on the UI".
- Say what was decided, not how the conversation went. Skip dead ends unless they still matter.
- Use the person's own names for things.
- Link artifacts and other pages to their URLs when the digest gives them. Never invent a URL.
- With no chats in the digest, summarise from the commits, and say there are no chats yet.
