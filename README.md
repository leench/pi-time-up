# pi-time-up

`pi-time-up` 为 Pi 提供软截止时间提醒：适合下班、睡觉，或让长任务在截止时间前开始收敛。它不会强杀 shell、工具或正在运行的子代理。

> 包名和仓库名是 `pi-time-up`；命令仍然是 `/time-up`，配置文件仍然是 `time-up.json`，以保持功能命名稳定。

## Features

- 在截止时间前向用户显示一次提醒
- 在收敛阶段向主 Agent 发送 steer，要求停止扩张、收敛子代理、保存修改并完成必要验证
- 强制收敛阶段使用更强提醒，但不硬杀当前工具调用
- 支持工作日、每天等重复计划
- 支持自定义提示词和本次 occurrence 的 `skip` / `resume`
- 配置独立保存，不修改 `settings.json`

## Install

推荐使用 Pi package 安装 Git 仓库：

```bash
pi install git:git@github.com:leench/pi-time-up.git
```

也可以使用 HTTPS shorthand：

```bash
pi install git:github.com/leench/pi-time-up
```

安装后在 Pi 中执行 `/reload`，或重启 Pi。更新扩展时执行：

```bash
pi update --extensions
```

临时试用或本地开发可以直接安装本地目录：

```bash
pi install /absolute/path/to/pi-time-up
```

不需要手动复制文件；Pi 会根据 `package.json` 的 `pi.extensions` manifest 加载 `index.ts`，并在安装 Git package 时处理依赖。

## Configuration

配置文件位于：

```text
${PI_CODING_AGENT_DIR:-~/.pi/agent}/time-up.json
```

首次安装不会创建文件，也不会启用任何计划；使用 `/time-up set` 后才会写入。仓库中的 `time-up.example.json` 是可复制的完整示例。

```json
{
  "timezone": "local",
  "humanNotification": true,
  "catchUpOnResume": false,
  "prompts": {
    "wrap-up": "The {{label}} soft deadline is {{cutoff}}. Switch to wrap-up mode; do not start new large tasks, steer active subagents to converge, save changes, run essential verification, and prepare a concise handoff.",
    "force-wrap-up": "Only {{remaining}} remain before the {{label}} cutoff. Force wrap-up now: stop non-essential work, steer active subagents to converge, save changes, and prepare the final handoff.",
    "resume": "The user cancelled the current Time-up wrap-up for {{label}}. Resume normal task execution and continue the original task if safe."
  },
  "schedules": {
    "work": {
      "label": "Work",
      "time": "18:00",
      "days": ["mon", "tue", "wed", "thu", "fri"],
      "userReminderBefore": "30m",
      "wrapUpBefore": "20m",
      "forceWrapUpBefore": "5m",
      "enabled": true
    }
  }
}
```

- `timezone` 当前固定为 `local`，时间使用运行 Pi 的本地时区
- 时间设置支持 `m`、`h`、`d`，最大 7 天
- `wrapUpBefore` 至少为 `20m`
- 必须满足 `userReminderBefore > wrapUpBefore > forceWrapUpBefore`
- 坏 JSON 或无效配置会显示错误通知，不会让 Pi 崩溃
- 配置写入采用临时文件后 rename

支持的提示词占位符：`{{label}}`、`{{scheduleId}}`、`{{cutoff}}`、`{{remaining}}`、`{{warning}}`、`{{warningMinutes}}`、`{{stage}}`。

## Commands

```text
/time-up                         # 显示帮助和所有子命令
/time-up status                  # 计划、下次截止、剩余时间、skip 状态
/time-up set work 18:00 mon tue wed thu fri
/time-up enable work
/time-up disable work
/time-up skip [id]               # 跳过当前 occurrence 的全部阶段
/time-up resume [id]             # 取消当前收敛并恢复正常工作
/time-up reload
/time-up help
```

`set` 会创建或更新计划；省略 days 时保留原计划的 days，新计划默认每天。完整的 `label`、时间和 `prompts` 设置可以直接编辑 JSON 后执行 `/time-up reload`。

## Behavior and boundaries

- 30 分钟前只显示一次用户提醒，不唤起模型
- 20 分钟前发送 `wrap-up` steer，要求不启动新大型任务、检查当前 subagents 并开始收敛
- 5 分钟前发送 `force-wrap-up` steer，要求停止非必要工作并整理 handoff
- `resume` 会取消当前 occurrence 的后续自动收敛
- steer 会在安全点处理；不会硬杀当前工具调用
- Pi 进程必须持续运行；系统睡眠或事件循环阻塞可能造成轻微延迟
- 子代理只通过主 Agent 间接收敛，不修改 `pi-subagents`

## Development

```bash
npm install
npm test
npm run check
npm run pack:check
```

发布流程见 [`RELEASING.md`](RELEASING.md)。本地配置、日志、凭据和 `node_modules/` 不应提交到仓库。

## License

MIT
