# Memory — what you missed

Every snap-back is recorded locally (`~/.config/rotpilot/rot.json`): what Claude was working on, how long you rotted, why you got yanked back, and how fast you responded. **No data leaves your machine unless you opt in.**

## 👀 While you rotted (instant, local)

Every snap-back screen prices what just streamed by, parsed locally from the session transcript — no key, no network, works from your first rot.

`rotpilot recap` catches you up on **this session** the same way: it reads the current Claude Code transcript directly and synthesizes a sardonic briefing with **your own** Claude (the `claude` CLI you already have). No key, no opt-in, nothing leaves your machine. This is the 95% case: "what did I miss just now."

The briefing is written at read time by Haiku through your own CLI. No `claude` on PATH? recap degrades to a clean bulleted list and says why. `rotpilot recap --plain` skips the write-up on demand; `--raw` prints the exact prompt.

### Budgets

`rotpilot budget 10m` hands rotpilot a daily rot ration (or `1h --weekly`). `rotpilot stats` then shows a live meter — `today ███████░░░ 7m / 10m · 3m left` — plus a days-under-budget streak, and the recap roast knows when you've blown past it (*"you burned through your 10-minute budget by 9am"*). `rotpilot budget off` to drop it.

## 🧠 Across time & repos (Engram, opt-in)

Here's the thing local can't fix. **Every question Claude asks while you're rotting dies with the session that asked it.** Claude Code writes one JSONL transcript per session and rotates them — so "what was Claude waiting on me for, in the other repo, last Tuesday?" is permanently unanswerable from your disk. `rotpilot stats` prices the leak for you:

```
▎ loose ends

  claude asked you 14 things this week while you weren't looking.
  those sessions are gone, and took the questions with them.
```

[Engram](https://docs.weaviate.io/engram) is what keeps them. It's off by default, entirely opt-in, and rotpilot is fully functional without it — but it buys you one thing nothing else can: the **second half of every recap**.

`rotpilot recap` always prints two sections. The first — *this session* — is local and needs nothing. The second — *still on you* — is **a standing to-do list you never wrote**: every question, approval, and warning Claude surfaced while you weren't looking, across *every* repo and *every* session, most overdue first. Without Engram that section just tells you what it would hold; with it:

```
▎ still on you

  you've got ten things hanging from three different projects, oldest
  gathering dust since july 2nd. twenty-five days, and the only movement
  has been you refreshing your phone 124 times.

  · decide whether to apply claude's fix to aura/views/posts.py  (aura)
  · claude never ran the grep it offered in OmniSearch/frontend  (omnisearch)
  · pick a demo shape — it's been waiting on you since monday  (playground)
```

Engram's extraction pipeline does the did-vs-needs-you split by reading the dialogue (rotpilot parses nothing), and its merge step folds the same unanswered question from three sessions into one line instead of three. `--days` widens the window (default 14).

Setup: **[Engram Quickstart](./engram-quickstart.md)**. Two more modes come free with it:

```sh
rotpilot recap --all                    # this repo, across every past session
rotpilot recap "what changed in auth?"  # ask anything, across every project you rotted through
```

You watched reels; your memory watched Claude. Weeks later, in any repo, you can ask what happened while you weren't looking — and get a straight answer, not a log dump:

```
▎ recap · aura

▎ all sessions

  you were doom-scrolling while claude actually debugged your code. lines
  720-724 in posts.py: exception handler was killing the original image url,
  causing campaign images to fail silently. tragic, honestly.

  · found it: loop var `img` gets clobbered after `_url_to_data_uri()`
  · rewrote the handler to preserve the source url and added a regression test

▎ still on you

  four things hanging across three repos, oldest waiting 26 days.

  · aura (3d): green-light the posts.py fix — claude is blocked on you
  · playground (26d): pick a demo shape, you were asked and said nothing
```

### Your memory id

Your memories are filed under an id generated on your machine and stored only in `config.json`. The API key you can always re-copy from the Engram console; **this you cannot.** Save it somewhere:

```sh
rotpilot engram id
```

After an uninstall or on a new machine, `rotpilot engram id <that-value>` is what makes your history reachable again. Without it a reinstall starts empty — the memories are still there, just out of reach.
