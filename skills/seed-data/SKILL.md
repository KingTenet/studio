---
name: seed-data
description: >
  Fill the app with sample data by running its scripts/seed-data.ts. Use on "/seed-data", "add some
  sample data", "fill the todo list with examples".
allowed-tools: Bash(npx tsx scripts/seed-data.ts)
---

# Seed the app's data

1. If the app has no `scripts/seed-data.ts`, say so and stop: there's nothing to run.

2. Run it from the app's folder (where you already are):

   ```bash
   npx tsx scripts/seed-data.ts
   ```

3. Say what it added, from what it printed, and that the App tab shows it once the user clicks its reload
   button. If it failed, say why in plain words.
