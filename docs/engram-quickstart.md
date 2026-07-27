# Engram Quickstart

`rotpilot recap` needs one thing: an Engram project with two topics, scoped so every repo you rot through lands in the same memory. This is a one-time, ~2-minute setup in the [Engram console](https://console.weaviate.cloud/).

Docs: https://docs.weaviate.io/engram

> `rotpilot engram` prints these same steps in your terminal — this doc is the illustrated version.

## 1. Create the project

In the Engram console, create a new project with any name you like.

For its scope, choose **user + property scoped**. This is what lets one memory store span every project: the `user` half is you, and the `property` half is the repo you were in.

## 2. Add the two topics

In the project's default group, add **both** of the topics below. For each one:

- set it **unbounded** (memories accumulate; they aren't collapsed to one per scope)
- give it the scope property **`project`** (type `string`) — this is what tags each memory with the repo it came from

Paste the descriptions exactly — they *are* the extraction prompts, so the wording decides what gets remembered. You can refine them later in the console without recreating the project.

### `claude_work`

```
Substantive work Claude Code completed while the user was away, and its outcome: features built, bugs fixed, files edited, tests or commands run and their results, decisions made. Record the OUTCOME, not the process — exclude routine exploration such as reading files, searching the codebase, or listing directories.
```

### `loose_ends`

```
Things that still need the user: questions Claude Code asked, approvals or input it waited for, warnings it raised, and follow-ups it suggested that remain unresolved.
```

## 3. Create an API key

Create an API key for the project and copy it. You'll hand it to rotpilot next.

## 4. Give the key to rotpilot

```sh
rotpilot engram key      # paste the key when prompted (stored 0600, never leaves your machine)
rotpilot engram check    # verifies the key + both topics are wired up correctly
```

That's it. From now on, each rot window's transcript slice is sent to your project (only after you opt in with `rotpilot engram transcripts on`), the pipeline splits it into `claude_work` and `loose_ends` memories, and `rotpilot recap` reads them back to you.
