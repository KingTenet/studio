'use strict';

/**
 * Checks the settings Claude runs with in the studio (claude/settings.json). Auto mode drops broad allow rules
 * (Bash(npm *), wildcarded interpreters), so every rule has to be narrow: an exact command, or a path inside the app.
 *
 * Run tests: node --test lib/settings.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, readdirSync, readFileSync } = require('node:fs');
const path = require('node:path');

const settings = JSON.parse(readFileSync(path.join(__dirname, '..', '..', 'claude', 'settings.json'), 'utf8'));

test('the allowlist has only exact commands and paths inside the app folder', () => {
  const allow = settings.permissions.allow;
  assert.ok(allow.length > 0);
  for (const rule of allow) {
    const bash = /^Bash\((.*)\)$/.exec(rule);
    if (bash) assert.ok(!bash[1].includes('*'), `${rule} is a wildcard, which auto mode drops`);
    else assert.match(rule, /^(Edit|Read)\(\.\/[^)]*\)$/, `${rule} reaches outside the app folder`);
  }
});

test("the skills' own allowed commands are exact, or one of this harness's scripts with its arguments, never an interpreter", () => {
  const skills = path.join(__dirname, '..', '..', 'skills');
  for (const name of readdirSync(skills)) {
    const file = path.join(skills, name, 'SKILL.md');
    const allowed = /^allowed-tools: (.*)$/m.exec(existsSync(file) ? readFileSync(file, 'utf8') : '')?.[1] ?? '';
    for (const [, command] of allowed.matchAll(/Bash\(([^)]*)\)/g)) {
      if (command.includes('*')) assert.match(command, /^\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/[\w-]+\.sh \*$/, `${name}: Bash(${command}) is broader than a harness script`);
    }
  }
});

test('/seed-data runs without a prompt: its command is on the allowlist exactly', () => {
  assert.ok(settings.permissions.allow.includes('Bash(npx tsx scripts/seed-data.ts)'));
});
