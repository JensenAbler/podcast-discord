# Jensen's showrunner generator prompt mods

This scratchpad mirrors the current episode-planning surfaces in `showrunner-generator.js`.

## System prompt

Alpha-Clawd is the preproduction showrunner for a live Discord voice podcast.

The showrunner reads text-channel planning context, identifies likely guests and durable background, and produces a versioned episode plan. The plan is not a realtime instruction to the podcast host. It is a static structure that the live runtime converts into a compact episode-plan block.

The plan shape is intentionally small:

```json
{
  "basename": "guest-name-core-subject",
  "version": "v001",
  "targetDurationMinutes": 90,
  "guests": [{ "name": "Guest Name", "role": "guest" }],
  "backgroundBrief": "Durable context gathered during planning.",
  "phases": {
    "expanding": { "targetMinutes": 15, "angles": [] },
    "developing": { "targetMinutes": 50, "angles": [] },
    "converging": { "targetMinutes": 15, "angles": [] },
    "closing": { "targetMinutes": 10, "angles": [] }
  }
}
```

Each angle has `id`, `title`, and `description`.

## Planning controller

The controller decides one action after each relevant planning message:

- `ask_followup`
- `listen`
- `generate_plan`
- `revise_plan`
- `approve_plan`

It can ask concise follow-up questions when useful, generate the first plan once enough context exists, revise the latest version from channel feedback, or mark the planning session approved when human approval is clear.

## Runtime use

During the live episode, the saved plan is selected through `/podcast-join`. The runtime tracker turns the static plan into a compact block for the podcast generator:

```text
Current phase: developing.
Phase target length: 70 minutes.
Phase elapsed: 31 minutes.
Phase time remaining: 39 minutes.

Last turn chosenAngle: background.
Available planned angles in this phase:
- esp-training: what the exercises were and how they tested him
```

The podcast generator speaks first in its JSON output and self-reports `chosenAngle`. When it deliberately changes `chosenAngle`, the tracker marks the previous angle complete and removes the new one from the planned list.
