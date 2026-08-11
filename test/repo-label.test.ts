/**
 * Project identity. This is the scope key for every stat and every Engram
 * memory, so getting it wrong silently merges unrelated repos — or, if the
 * daemon and the CLI ever disagreed, writes to one drawer and reads another.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { repoLabel } from '../src/memory/store.js';

/** A throwaway tree: <root>/<repo>/.git plus any nested dirs. */
function repo(name: string, sub = ''): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-repo-'));
  const r = path.join(root, name);
  fs.mkdirSync(path.join(r, '.git'), { recursive: true });
  if (sub) fs.mkdirSync(path.join(r, sub), { recursive: true });
  return sub ? path.join(r, sub) : r;
}

test('the repo root names the project', () => {
  assert.equal(repoLabel(repo('aura')), 'aura');
});

test('a subdirectory files under its repo, not under itself', () => {
  // the actual bug: aura/frontend and OmniSearch/frontend both became "frontend"
  assert.equal(repoLabel(repo('aura', 'frontend')), 'aura');
  assert.equal(repoLabel(repo('OmniSearch', 'frontend')), 'OmniSearch');
});

test('two repos that share a subdirectory name stay distinct', () => {
  const a = repoLabel(repo('aura', 'frontend'));
  const b = repoLabel(repo('Weaview', 'frontend'));
  assert.notEqual(a, b, 'this collision is what merged four repos into one');
});

test('deeply nested still resolves to the root', () => {
  assert.equal(repoLabel(repo('proj', 'a/b/c/d')), 'proj');
});

test('outside a git repo it falls back to the directory name', () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-plain-'));
  const leaf = path.join(plain, 'notarepo');
  fs.mkdirSync(leaf);
  assert.equal(repoLabel(leaf), 'notarepo');
});

test('a .git FILE counts too — worktrees and submodules use one', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-wt-'));
  const r = path.join(root, 'linked');
  fs.mkdirSync(path.join(r, 'src'), { recursive: true });
  fs.writeFileSync(path.join(r, '.git'), 'gitdir: /elsewhere/.git/worktrees/linked\n');
  assert.equal(repoLabel(path.join(r, 'src')), 'linked');
});

test('no cwd, no label', () => {
  assert.equal(repoLabel(undefined), undefined);
});
