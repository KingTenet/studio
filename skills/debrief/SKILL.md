---
name: debrief
description: Explain a just-finished piece of work (a skill run, a feature, or a free-form stretch of the session) at a chosen depth and in a chosen medium - terse bullets, a teaching walkthrough, plain-language analogies, ASCII diagrams, an HTML page, or a docs2 write-up. Use when the user says "debrief", "/debrief", "walk me through what you just did", "summarise that with a diagram", or "teach me what changed".
argument-hint: "[terse|normal|teach|eli5] [chat|diagram|html|doc] [focus or git ref]"
---

# Debrief

Present work that is already done. Never edit code, commit, or re-run tests while debriefing.

## Arguments

Any order, all optional.

- **Depth:** `terse` | `normal` | `teach` | `eli5`
- **Medium:** `chat` | `diagram` | `html` | `doc`
- **Anything else** narrows the scope: a topic ("the clipping logic"), a feature, or a git ref to debrief from (`since abc123`).

Resolve depth and medium separately, first match wins:

1. An argument to this skill.
2. The most recent `[modes]` header in the context (from the modes hook): its `depth=` and `medium=` values, including one-shot overrides.
3. `normal` and `chat`. No `[modes]` header means the session is at these defaults.

## 1. Find the unit of work

Default scope is the most recent unit of work in this conversation: everything since the last skill invocation, or since the user started the current task if no skill ran. Gather:

- What was asked, and what was decided along the way (from the conversation).
- Commits made: `git log --oneline <base>..HEAD`, where `<base>` is the commit before the work started. Use the conversation's record of commits, or where `develop` branched from `main`.
- Uncommitted changes: `git status --short` and `git diff --stat`.
- What was verified: tests, lint, and manual checks that actually ran, and their results.

If the scope is ambiguous (several unrelated tasks, no clear start), ask one question before writing.

## 2. Content

Every debrief covers, scaled by depth:

1. **What changed and why** - the problem, and the shape of the fix.
2. **How it works** - the mechanism, with `file_path:line` references.
3. **What was verified** - only what the evidence shows. Say plainly what was not tested.
4. **Risks and open items** - follow-ups, assumptions, anything deferred.

Depth:

- **terse** - at most five bullets across the four points.
- **normal** - a short section per point.
- **teach** - adds why this approach beat the alternatives considered, the concepts and patterns it touched (language features, library behaviour, domain rules) explained from the ground up and tied to the code, and two or three things worth reading next.
- **eli5** - plain language, one real-world analogy for the core mechanism, every term defined on first use, no jargon left unexplained.

## 3. Medium

- **chat** - Markdown in the reply.
- **diagram** - ASCII diagrams first, then the text at the chosen depth. Pick the diagram that shows the mechanism: before/after for a behaviour change, a sequence diagram for a request or data flow, a component map for structural changes. Keep diagrams within 80 columns, using box-drawing characters and arrows.
- **html** - Load the `artifact-design` and `artifact-diagramming` skills, build one page with inline SVG diagrams, and publish it with the Artifact tool. It is private by default. Reply with the link and a two-line summary.
- **doc** - Write full prose to `docs/debriefs/DEBRIEF-<short-topic>.md` in the app's folder (create it if missing). Include ASCII diagrams where they help. Reply with the path and a two-line summary.

## Rules

- Report outcomes faithfully. A test that was skipped or failed is stated as such, never smoothed over.
- Don't duplicate artefacts that already exist (plans, artifacts): link them.
- No real customer data, names, or IDs from logs or screenshots in an `html` or `doc` debrief.
