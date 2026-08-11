# How rotpilot works

```
claude code hook ──▶ rotpilot hook <event> ──unix socket──▶ rotpilotd
                                                              │
                              prompt submitted ──▶ play (thinking time is rot time)
                                                              │
                                        headful Chrome ──CDP screencast──▶ PNG frames
                                                              │
                                        kitty graphics protocol ──▶ your terminal
                                                              │
                         permission / done ──▶ freeze + roast, ding, focus snaps back
```

## Hooks

rotpilot installs 13 Claude Code hooks into the current project's `.claude/settings.local.json` — never your global settings.

The "claude is working" hooks are **async**: a dead daemon can never slow down or break a Claude session (the hook client no-ops in ~45 ms).

The pause hooks are deliberately **sync**. `PermissionRequest` fires *before* the dialog is painted, so the feed is already frozen by the time you see the prompt.

Playback starts on `UserPromptSubmit`, not on the first tool call — Claude's thinking time is rot time.

## Chrome

Chrome runs **headful** with an isolated profile (`~/.config/rotpilot/chrome-profile`, never your own) and anti-throttle flags, and its window hides behind your terminal. You watch the *terminal*; Chrome is only the engine.

The debug port is chosen dynamically, and rotpilot only ever kills Chrome processes matching its own profile directory — it will not touch your browser.

Read-only by design: rotpilot scrolls to watch. It will never like, follow, comment, or DM.

## The daemon

One daemon serves every session and stays resident between them, so the next session starts warm. It holds a singleton lock (`daemon.pid`, taken atomically) — a second daemon spawned by a hook burst stands down rather than stealing the socket.

A session ending closes the TV panel and Chrome but leaves the daemon alive. `rotpilot stop` ends everything, and also sweeps any daemon or TV window orphaned by an earlier hard kill.

## Terminal support

The panel needs three things from a terminal: an image protocol, programmatic pane spawning, and focus control.

| terminal | supported |
|---|---|
| kitty | yes — kitty graphics protocol + `kitten @ launch` remote control |
| Ghostty ≥1.3 | yes — kitty graphics protocol + AppleScript |
| everything else | no |

VS Code, Terminal.app, and IDE extensions cannot run the panel: Terminal.app has no image protocol and no splits, and VS Code exposes no external API for splitting its terminal (its Kitty-graphics support is also still in testing and excludes animation). A browser-window mode that works anywhere is on the list.
