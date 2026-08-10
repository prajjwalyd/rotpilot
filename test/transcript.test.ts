/**
 * What the recap synthesizer is fed. Tested through `digestLines` rather than
 * the private helpers, so these assert behaviour a user would notice, not
 * internals.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { digestLines, countQuestions, missedLine, transcriptWindow, type ConvMessage } from '../src/memory/transcript.js';
import { parseSynth } from '../src/memory/summarize.js';

const assistant = (content: string, calls: Array<[string, unknown]> = []): ConvMessage => ({
  role: 'assistant',
  content,
  tool_calls: calls.map(([name, input], i) => ({
    id: 't' + i,
    type: 'function' as const,
    function: { name, arguments: JSON.stringify(input) },
  })),
});

/** Write a Claude Code-shaped JSONL transcript and parse it back. */
function fixture(entries: unknown[]): ConvMessage[] {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rp-tr-')), 't.jsonl');
  fs.writeFileSync(p, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return transcriptWindow(p, 0, Date.now() + 1000, 80);
}

/**
 * One assistant turn with tool calls, through the REAL parse path. Constructing
 * ConvMessage by hand would skip `transcriptWindow`, which is where a tool
 * call's arguments get reduced to the one salient field — so a hand-built
 * message renders unshortened and tests nothing.
 */
function parsed(text: string, calls: Array<[string, unknown]>): ConvMessage[] {
  return fixture([
    {
      type: 'assistant',
      timestamp: new Date().toISOString(),
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text },
          ...calls.map(([name, input], i) => ({ type: 'tool_use', id: 'c' + i, name, input })),
        ],
      },
    },
  ]);
}

test('a long Bash command survives — it used to degrade to "run a command"', () => {
  // regression: arguments were built by stringifying the whole input and cutting
  // the blob at 300 chars, slicing through the value; the extractor needs a
  // closing quote, so 17 of 32 action lines in a real session said nothing
  const long = 'curl -s -m 5 http://localhost:8080/v1/schema ' + 'x'.repeat(400);
  const msgs = fixture([
    {
      type: 'assistant',
      timestamp: new Date().toISOString(),
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: long, description: 'probe' } }] },
    },
  ]);
  const out = digestLines(msgs).join('\n');
  assert.ok(!out.includes('run a command'), 'must not fall back to the placeholder');
  assert.ok(out.includes('curl -s -m 5'), 'the actual command should be visible');
});

test('commands report their shape, not their payload', () => {
  const out = digestLines(parsed('ok', [['Bash', { command: "python3 - <<'EOF'\nimport json\nprint(1)\nEOF" }]])).join('\n');
  assert.ok(out.includes('python3 -'), out);
  assert.ok(!out.includes('import json'), 'the heredoc body is noise for a recap');
});

test('scaffolding verbs are skipped for the real one', () => {
  const out = digestLines(parsed('ok', [['Bash', { command: 'cd /tmp && python3 script.py' }]])).join('\n');
  assert.ok(out.includes('python3 script.py'), out);
  assert.ok(!out.includes('cd /tmp'), 'cd is not the action');
});

test('absolute paths shrink to their last two segments', () => {
  const out = digestLines(parsed('ok', [['Edit', { file_path: '/Users/me/Documents/GitHub/proj/src/search/vectors.py' }]])).join('\n');
  assert.ok(out.includes('search/vectors.py'), out);
  assert.ok(!out.includes('/Users/me'), 'the prefix is 40 chars nobody reads');
});

test('repeated actions collapse to one line with a count', () => {
  const out = digestLines([
    ...parsed('a', [['Edit', { file_path: '/p/index.html' }]]),
    ...parsed('b', [['Edit', { file_path: '/p/index.html' }]]),
    ...parsed('c', [['Edit', { file_path: '/p/index.html' }]]),
  ]).join('\n');
  const hits = out.split('\n').filter((l) => l.includes('index.html'));
  assert.equal(hits.length, 1, 'three edits of one file is one fact');
  assert.ok(hits[0].endsWith('×3'), hits[0]);
});

test('a ×N stamp never lands mid-line when one action prefixes another', () => {
  // regression: a substring replace put the count inside the longer line
  const out = digestLines([
    ...parsed('a', [['Bash', { command: 'npm test' }]]),
    ...parsed('b', [['Bash', { command: 'npm test' }]]),
    ...parsed('c', [['Bash', { command: 'npm test --watch' }]]),
  ]).join('\n');
  for (const line of out.split('\n')) {
    const at = line.indexOf('×');
    if (at >= 0) assert.equal(line.slice(at).trim(), line.slice(at), 'nothing may follow the count');
  }
});

test('read-only exploration and tool results are dropped', () => {
  const msgs = fixture([
    { type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'r', name: 'Read', input: { file_path: '/p/a.ts' } }] } },
    { type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'r', content: 'x'.repeat(5000) }] } },
  ]);
  const out = digestLines(msgs).join('\n');
  assert.ok(!out.includes('x'.repeat(50)), 'tool results are huge and add nothing');
});

test('subagent sidechains and meta entries are dropped', () => {
  const msgs = fixture([
    { type: 'assistant', isSidechain: true, timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'SIDECHAIN' }] } },
    { type: 'assistant', isMeta: true, timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'META' }] } },
    { type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'REAL' }] } },
  ]);
  const out = digestLines(msgs).join('\n');
  assert.ok(out.includes('REAL'));
  assert.ok(!out.includes('SIDECHAIN') && !out.includes('META'));
});

test('the digest keeps the LAST n things, in order', () => {
  const msgs = Array.from({ length: 40 }, (_, i) => assistant(`msg${i}`));
  const out = digestLines(msgs, 10);
  assert.equal(out.length, 10, 'capped');
  assert.ok(out[9].includes('msg39'), 'the tail is what you just missed');
  assert.ok(!out.join('\n').includes('msg0'), 'the head should have been dropped');
  assert.ok(out.indexOf('msg30') < out.indexOf('msg39'), 'oldest to newest');
});

test('pipes are filters — the first command is the action, not the filter', () => {
  const out = digestLines(parsed('ok', [['Bash', { command: 'npm test | tail -5' }]])).join('\n');
  assert.ok(out.includes('npm test'), out);
  assert.ok(!out.includes('tail'), 'the pipe target is not what ran');
});

test('shell inspection is dropped, like the read-only tools it mimics', () => {
  const out = digestLines(parsed('ok', [
    ['Bash', { command: 'pwd' }],
    ['Bash', { command: 'ls -la | head -20' }],
    ['Bash', { command: 'echo "=== section ==="' }],
    ['Bash', { command: 'npm run build' }],
  ])).join('\n');
  assert.ok(out.includes('npm run build'), out);
  for (const noise of ['pwd', 'ls -la', 'section']) {
    assert.ok(!out.includes(noise), `${noise} changes nothing and says nothing`);
  }
});

test('JSON escapes do not leak into the rendered action', () => {
  const out = digestLines(parsed('ok', [['Bash', { command: 'node -e "console.log(1)"' }]])).join('\n');
  assert.ok(out.includes('"console.log(1)"'), out);
  assert.ok(!out.includes('\\"'), 'values are still JSON-encoded unless decoded');
});

test('harness chatter is not something you asked', () => {
  const out = digestLines([
    { role: 'user', content: '[Request interrupted by user]' },
    { role: 'user', content: 'actually do the thing' },
  ]).join('\n');
  assert.ok(out.includes('actually do the thing'));
  assert.ok(!out.includes('interrupted'), out);
});

test('pure narration is dropped — it says what was about to happen', () => {
  const out = digestLines([assistant('Let me check the config.'), assistant('The config was wrong.')]).join('\n');
  assert.ok(out.includes('The config was wrong.'));
  assert.ok(!out.includes('Let me check'), out);
});

test('countQuestions counts only claude asking', () => {
  assert.equal(countQuestions([assistant('should I proceed?'), assistant('done.'), { role: 'user', content: 'what?' }]), 1);
});

test('missedLine prices a window, and is null when empty', () => {
  const line = missedLine([assistant('ok', [['Edit', { file_path: '/p/a.ts' }], ['Bash', { command: 'npm test' }]]), assistant('which one?')]);
  assert.ok(line?.startsWith('while you rotted:'), String(line));
  assert.ok(line?.includes('1 edit') && line?.includes('1 command') && line?.includes('1 question waiting'), String(line));
  assert.equal(missedLine([]), null);
});

// ── the one parser every LLM call in rotpilot goes through ──────────────────
test('parseSynth: first prose is the headline, "- " lines are items', () => {
  const s = parseSynth('you owe six things.\n- fix auth.ts (aura) 3d\n- decide the demo shape (pg) 11d');
  assert.equal(s.headline, 'you owe six things.');
  assert.deepEqual(s.items, ['fix auth.ts (aura) 3d', 'decide the demo shape (pg) 11d']);
});

test('parseSynth tolerates the drift the model reaches for anyway', () => {
  // bold markers, three bullet glyphs, blank runs, a multi-line headline
  const s = parseSynth('**you owe**\nsix things.\n\n* one thing\n• another\n·  a third\n');
  assert.equal(s.headline, 'you owe six things.');
  assert.deepEqual(s.items, ['one thing', 'another', 'a third']);
});

test('parseSynth: prose after the list is not mistaken for the headline', () => {
  const s = parseSynth('the debt.\n- item one\nsome trailing pep talk');
  assert.equal(s.headline, 'the debt.');
  assert.deepEqual(s.items, ['item one']);
});

test('parseSynth survives a model that ignores the format entirely', () => {
  const s = parseSynth('just a paragraph with no list at all');
  assert.equal(s.headline, 'just a paragraph with no list at all');
  assert.deepEqual(s.items, []);
});
