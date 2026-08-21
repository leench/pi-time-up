# pi-time-up

`pi-time-up` provides soft deadline reminders for Pi. It is designed for work deadlines, bedtime, and long-running tasks that should converge before a cutoff.

[简体中文说明](README.zh-CN.md)

## Behavior

Each enabled schedule follows a three-stage flow:

1. **30 minutes before the cutoff**: notify the user once. No model turn is triggered.
2. **20 minutes before the cutoff**: send a `wrap-up` steer message to the main agent.
3. **5 minutes before the cutoff**: send a stronger `force-wrap-up` steer message.

The agent stages are dispatched even when the root Agent is idle (for example, waiting for background subagents). If an Agent turn is already active, Pi queues the steer behind the current tool call; the extension also shows a visible UI warning when the stage is queued.

The main agent can first use `subagent({ action: "status" })` to inspect running children, then use `subagent({ action: "steer", id: "<run-id>", message: "Finish the current tool call, then converge." })` to ask each child to converge. These are soft deadlines: `pi-time-up` never hard-kills a tool, shell command, or process.

## Install

Install the published `pi-time-up` package with your preferred Pi package manager.

For a manual installation:

```bash
mkdir -p ~/.pi/agent/extensions/pi-time-up
cp index.ts time-up.ts package.json README.md README.zh-CN.md time-up.example.json \
  ~/.pi/agent/extensions/pi-time-up/
cd ~/.pi/agent/extensions/pi-time-up
npm install
```

Restart Pi or run `/reload` after installing or changing extension code.

## Configuration

The runtime configuration is stored separately from `settings.json`:

```text
${PI_CODING_AGENT_DIR:-~/.pi/agent}/time-up.json
```

The extension does not create this file until a schedule is configured. The repository includes a complete example at [`time-up.example.json`](time-up.example.json).

A minimal configuration looks like this:

```json
{
  "timezone": "local",
  "humanNotification": true,
  "catchUpOnResume": false,
  "prompts": {},
  "schedules": {
    "sleep": {
      "label": "Bedtime",
      "time": "00:00",
      "days": ["sun", "mon", "tue", "wed", "thu", "fri", "sat"],
      "userReminderBefore": "30m",
      "wrapUpBefore": "20m",
      "forceWrapUpBefore": "5m",
      "enabled": true
    }
  }
}
```

Schedule constraints:

- `time` uses the local timezone and `HH:mm` format.
- `userReminderBefore > wrapUpBefore > forceWrapUpBefore`.
- `wrapUpBefore` must be at least `20m`.
- Lead times accept `m`, `h`, and `d` units, up to seven days.
- `catchUpOnResume` defaults to `false`; missed reminders are not replayed when Pi starts.
- Invalid configuration is reported in the UI instead of crashing Pi.

## Commands

```text
/time-up                         # show help and the command list
/time-up status                  # show schedules and the next cutoff
/time-up set <id> <HH:mm> [days] # create or update a schedule
/time-up enable <id>
/time-up disable <id>
/time-up skip [id]               # skip the next complete reminder cycle
/time-up resume [id]             # cancel the active wrap-up for this cycle
/time-up reload                  # reload time-up.json and restart its timers
/time-up help
```

`skip-next` and `ignore-next` remain accepted as compatibility aliases for `skip`.

`skip` is intended for the user-warning stage. Once agent wrap-up has started, use `resume` instead. `resume` cancels the remaining automatic stages for the current occurrence and sends a corrective steer message to the main agent. It cannot retract messages that were already delivered or undo completed work.

## Custom prompts

Built-in prompts are in English and can be overridden globally or per schedule. Schedule-level values override global values. Prompt text is passed to the main agent as-is.

Supported prompt keys:

- `nudge`
- `wrap-up`
- `force-wrap-up`
- `resume`

Supported placeholders:

- `{{label}}`: schedule label
- `{{scheduleId}}`: schedule ID
- `{{cutoff}}`: local cutoff time
- `{{remaining}}`: time remaining until the cutoff
- `{{warning}}`: current lead time, such as `20m`
- `{{warningMinutes}}`: current lead time in minutes
- `{{stage}}`: current stage, such as `wrap-up` or `force-wrap-up`

Unknown placeholders are left unchanged.

## Boundaries

- Pi must be running for timers and agent steering to work.
- Stage reminders are not suppressed just because the root Agent is idle; the process must still be alive and able to deliver messages.
- System sleep and event-loop blockage can cause small delays.
- Subagents are steered indirectly through the main agent; `pi-time-up` does not modify `pi-subagents` or provide an external subagent RPC.
- The extension does not hard-stop shell commands or other processes.

## Development

From this directory:

```bash
npm test
npm run check
npm pack --dry-run
```
