# Config

`~/.config/rotpilot/config.json` — written by `rotpilot init`. Most of it has a command; prefer the command.

```jsonc
{
  "feed": "localLoop",          // localLoop | shorts | instagram — `rotpilot feed <name>`
  "window": "panel",            // panel (split beside claude) | window — `rotpilot window <mode>`
  "panelBias": 33,              // panel width, % of the terminal
  "fps": 20,                    // terminal render cap — lower it if video drifts behind audio
  "watchBoundsMs": [5000, 60000],  // min/max ms per clip. the advance itself is video-driven
                                   // (fires when a reel has played through once); these clamp it
  "autoResumeSec": 6,           // permission pauses auto-resume after N sec (0 = off)
  "sound": true,                // the snap-back ding
  "muteFeed": false,            // true = feed never has sound. default: sound while showing,
                                // silent when paused or hidden
  "engram": {
    "userId": "rotpilot-…",     // what your memories are filed under — `rotpilot engram id`
    "shareTranscripts": false   // `rotpilot engram transcripts on`
  },
  "allowInstagram": false,      // `rotpilot feed instagram --accept-risk`
  "budget": { "limitSec": 600, "period": "day", "since": "…" }
                                // absent unless you set one — use `rotpilot budget 10m`
}
```

## Other files in the config dir

| file | what |
|---|---|
| `rot.json` | your rot history — every break, duration, and response latency |
| `engram.key` | your Engram API key, mode 0600 |
| `daemon.log` | what the daemon did; the first place to look when something is off |
| `loop.mp4` | the `localLoop` video, if you ran `rotpilot loop` |
| `chrome-profile/` | the isolated Chrome profile. can hold real logins — always wiped by `uninstall` |

## Performance

Video is captured from Chrome, PNG-encoded, and pushed through the terminal's graphics protocol — the whole path is CPU-bound, and audio (which comes straight from Chrome) is not. So if the two drift apart, it's the video falling behind under load.

Two levers: drop `fps` to 12, and narrow `panelBias`, since cost scales with pixel area.
