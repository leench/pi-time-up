# pi-time-up

`pi-time-up` 为 Pi 提供软截止时间提醒，适合下班、睡觉，以及需要在截止时间前收敛的长任务。

## 工作方式

每个启用的计划按三个阶段运行：

1. **截止前 30 分钟**：只提醒用户一次，不触发模型 turn。
2. **截止前 20 分钟**：向主 Agent 发送 `wrap-up` steer 提示词。
3. **截止前 5 分钟**：发送更强的 `force-wrap-up` steer 提示词。

阶段提醒不会因为主 Agent 当前处于 idle 而被抑制，例如主 Agent 正在等待后台子代理时也会发送。如果 Agent 正在执行工具，Pi 会将 steer 排到当前工具调用之后；阶段进入队列时扩展也会显示可见的 UI 警告。

主 Agent 可以先用 `subagent({ action: "status" })` 查看运行中的子代理，再用 `subagent({ action: "steer", id: "<run-id>", message: "Finish the current tool call, then converge." })` 要求子代理收敛。这些都是软截止时间：`pi-time-up` 不会强制杀死工具、shell 命令或进程。

## 安装

使用你习惯的 Pi package manager 安装发布后的 `pi-time-up`。

手动安装：

```bash
mkdir -p ~/.pi/agent/extensions/pi-time-up
cp index.ts time-up.ts package.json README.md README.zh-CN.md time-up.example.json \
  ~/.pi/agent/extensions/pi-time-up/
cd ~/.pi/agent/extensions/pi-time-up
npm install
```

安装或修改扩展代码后，重启 Pi 或执行 `/reload`。

## 配置

运行时配置独立保存，不写入 `settings.json`：

```text
${PI_CODING_AGENT_DIR:-~/.pi/agent}/time-up.json
```

扩展在配置计划之前不会创建此文件。项目中提供了完整示例：[`time-up.example.json`](time-up.example.json)。

最小配置示例：

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

计划约束：

- `time` 使用运行 Pi 的本地时区，格式为 `HH:mm`。
- 必须满足 `userReminderBefore > wrapUpBefore > forceWrapUpBefore`。
- `wrapUpBefore` 最少为 `20m`。
- 提前时间支持 `m`、`h`、`d`，最长 7 天。
- `catchUpOnResume` 默认为 `false`，Pi 启动时不会补发错过的提醒。
- 配置无效时只在 UI 中提示错误，不会导致 Pi 崩溃。

## 命令

```text
/time-up                         # 显示帮助和命令列表
/time-up status                  # 查看计划和下一次截止时间
/time-up set <id> <HH:mm> [days] # 创建或更新计划
/time-up enable <id>
/time-up disable <id>
/time-up skip [id]               # 跳过下一次完整提醒周期
/time-up resume [id]             # 取消本次正在进行的收敛
/time-up reload                  # 重新读取 time-up.json 并重启定时器
/time-up help
```

`skip-next` 和 `ignore-next` 仍作为 `skip` 的兼容别名保留。

`skip` 用于用户提醒阶段。Agent 已经开始收敛后，应使用 `resume`。`resume` 会取消当前 occurrence 剩余的自动阶段，并向主 Agent 发送纠正 steer 提示词；它不能撤回已经发送的消息，也不能撤销已经完成的工作。

## 自定义提示词

内置提示词使用英文，可以按全局或单个计划覆盖。单个计划的设置优先于全局设置。提示词会原样发送给主 Agent。

支持的提示词键：

- `nudge`
- `wrap-up`
- `force-wrap-up`
- `resume`

支持的占位符：

- `{{label}}`：计划名称
- `{{scheduleId}}`：计划 ID
- `{{cutoff}}`：本地截止时间
- `{{remaining}}`：距离截止的剩余时间
- `{{warning}}`：当前提前时间，例如 `20m`
- `{{warningMinutes}}`：当前提前时间的分钟数
- `{{stage}}`：当前阶段，例如 `wrap-up` 或 `force-wrap-up`

未知占位符会原样保留。

## 边界

- Pi 必须保持运行，定时器和 Agent steer 才能工作。
- 阶段提醒不会仅因主 Agent 处于 idle 而被抑制，但 Pi 进程必须仍在运行并能够发送消息。
- 系统睡眠或事件循环阻塞可能造成轻微延迟。
- 子代理通过主 Agent 间接接收收敛指令；`pi-time-up` 不修改 `pi-subagents`，也不提供外部 subagent RPC。
- 扩展不会强制停止 shell 命令或其它进程。

## 开发

在此目录执行：

```bash
npm test
npm run check
npm pack --dry-run
```
