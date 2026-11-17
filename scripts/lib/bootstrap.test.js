'use strict';

/**
 * bootstrap.sh, run the way the one-liner runs it (`/bin/bash -c "$(curl …)" -- args`, macOS's bash 3.2), against a temp
 * HOME, a local repo standing in for Studio on GitHub (its install.sh prints its arguments and a line it reads from the
 * terminal), a stand-in xcode-select and a file-served Homebrew installer that "installs" the command-line tools.
 *
 * Run tests: node --test lib/bootstrap.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BOOTSTRAP = fs.readFileSync(path.resolve(__dirname, '..', '..', 'bootstrap.sh'), 'utf8');
const IDENTITY = { GIT_AUTHOR_NAME: 'Felix', GIT_AUTHOR_EMAIL: 'f@example.com', GIT_COMMITTER_NAME: 'Felix', GIT_COMMITTER_EMAIL: 'f@example.com' };

const INSTALL = `#!/usr/bin/env bash
echo "install.sh $(cat "$(dirname "$0")/version") args:$*"
read -r answer
echo "answered:$answer"
`;

const setup = ({ tools = true, homebrewBringsTools = true } = {}) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-bootstrap-')));
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  const upstream = path.join(root, 'studio-upstream');
  fs.mkdirSync(home);
  fs.mkdirSync(bin);
  fs.mkdirSync(upstream);
  const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: { ...process.env, ...IDENTITY } }).trim();
  git(upstream, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(upstream, 'install.sh'), INSTALL, { mode: 0o755 });
  const release = (version) => {
    fs.writeFileSync(path.join(upstream, 'version'), `${version}\n`);
    git(upstream, 'add', '-A');
    git(upstream, 'commit', '-q', '-m', version);
  };
  release('1');

  const cltMarker = path.join(root, 'clt-installed');
  if (tools) fs.writeFileSync(cltMarker, '');
  fs.writeFileSync(path.join(bin, 'xcode-select'), `#!/bin/sh\n[ -f "${cltMarker}" ] || exit 2\necho /Library/Developer/CommandLineTools\n`, { mode: 0o755 });
  const homebrew = path.join(root, 'homebrew-install.sh');
  fs.writeFileSync(homebrew, `echo "homebrew installer ran"\n${homebrewBringsTools ? `touch "${cltMarker}"` : ''}\n`);

  const run = (args = [], input = 'Her Name\n', script = BOOTSTRAP) =>
    spawnSync('/bin/bash', ['-c', script, ...(args.length ? ['--', ...args] : [])], {
      encoding: 'utf8',
      input,
      env: { ...process.env, ...IDENTITY, HOME: home, PATH: `${bin}:${process.env.PATH}`, STUDIO_REPO_URL: upstream, STUDIO_HOMEBREW_INSTALL_URL: `file://${homebrew}`, STUDIO_DIR: '' },
    });
  return { root, home, upstream, release, run, studio: path.join(home, 'Studio', 'studio'), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
};

test('copies Studio into ~/Studio/studio and runs its install.sh with the arguments, which can still ask questions; run again, it updates', () => {
  const t = setup();
  try {
    let result = t.run(['--app', 'my-app']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Copying Studio into .*\/home\/Studio\/studio/);
    assert.match(result.stdout, /^install\.sh 1 args:--app my-app$/m);
    assert.match(result.stdout, /^answered:Her Name$/m, 'install.sh reads from the terminal, not from the script');
    assert.doesNotMatch(result.stdout, /homebrew installer ran/, 'git is there, so Homebrew is left to install.sh');
    assert.ok(fs.existsSync(path.join(t.studio, '.git')), 'a real clone, so studio up can update it');

    t.release('2');
    result = t.run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Updating Studio/);
    assert.match(result.stdout, /^install\.sh 2 args:$/m);
  } finally {
    t.cleanup();
  }
});

test("on a Mac with no git, Homebrew's installer brings it first", () => {
  const t = setup({ tools: false });
  try {
    const result = t.run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /this Mac has no git yet[\s\S]*homebrew installer ran[\s\S]*Copying Studio[\s\S]*install\.sh 1/);
  } finally {
    t.cleanup();
  }
});

test('stops with a plain message when there is still no git, or a folder of something else is in the way', () => {
  let t = setup({ tools: false, homebrewBringsTools: false });
  try {
    const result = t.run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /still has no git\. Run: xcode-select --install/);
    assert.ok(!fs.existsSync(t.studio));
  } finally {
    t.cleanup();
  }
  t = setup();
  try {
    fs.mkdirSync(t.studio, { recursive: true });
    fs.writeFileSync(path.join(t.studio, 'mine.txt'), 'hers');
    const result = t.run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /isn't a copy of Studio\. Move it out of the way/);
    assert.equal(fs.readFileSync(path.join(t.studio, 'mine.txt'), 'utf8'), 'hers');
  } finally {
    t.cleanup();
  }
});

test('a download cut off part way runs nothing', () => {
  const t = setup();
  try {
    const lines = BOOTSTRAP.split('\n');
    for (const keep of [lines.length - 3, Math.floor(lines.length / 2), 25]) {
      const result = t.run([], '', lines.slice(0, keep).join('\n'));
      assert.doesNotMatch(result.stdout, /Copying|install\.sh/, `cut after ${keep} lines`);
      assert.ok(!fs.existsSync(t.studio), `cut after ${keep} lines`);
    }
  } finally {
    t.cleanup();
  }
});
