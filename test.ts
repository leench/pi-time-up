import { Scheduler } from "./index.ts";
import {
	activeRunsFromStatusReply,
	emptyConfig,
	getActiveStage,
	getEventsBetween,
	getNextOccurrence,
	markSkipNext,
	normalizeConfig,
	normalizeSchedule,
	parseTime,
	parseWarning,
	renderPrompt,
	shouldDeliverAgentStage,
} from "./time-up.ts";

const failures: string[] = [];
function check(name: string, actual: unknown, expected: unknown): void {
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		failures.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
	} else console.log(`✓ ${name}`);
}
function throws(name: string, fn: () => unknown): void {
	try {
		fn();
		failures.push(`${name}: expected an error`);
	} catch {
		console.log(`✓ ${name}`);
	}
}

check("parses local time", parseTime("18:05"), 1085);
check("parses warning units", [parseWarning("30m"), parseWarning("2h"), parseWarning("1d")], [30, 120, 1440]);
throws("rejects invalid time", () => parseTime("25:00"));
throws("rejects invalid warning", () => parseWarning("soon"));

const schedule = normalizeSchedule("work", {
	label: "Work",
	time: "18:00",
	days: ["mon", "tue", "wed", "thu", "fri"],
	userReminderBefore: "30m",
	wrapUpBefore: "20m",
	forceWrapUpBefore: "5m",
	enabled: true,
});
check("normalizes staged lead times", [schedule.userReminderBefore, schedule.wrapUpBefore, schedule.forceWrapUpBefore], ["30m", "20m", "5m"]);
throws("requires at least 20m for wrap-up", () => normalizeSchedule("short", {
	time: "18:00", days: ["mon"], userReminderBefore: "10m", wrapUpBefore: "5m", forceWrapUpBefore: "1m",
}));

const monday = new Date(2026, 2, 23, 9, 0);
const next = getNextOccurrence(schedule, monday);
check("finds next weekday occurrence", next.cutoff.getDay(), 1);
const stagedEvents = getEventsBetween(schedule, new Date(2026, 2, 23, 17, 0), next.cutoff);
check("finds three staged events before cutoff", stagedEvents.map((event) => event.stage), ["user-reminder", "wrap-up", "force-wrap-up"]);
check("detects the active wrap-up phase", getActiveStage(schedule, new Date(2026, 2, 23, 17, 50))?.stage, "wrap-up");
check("detects the active force-wrap-up phase", getActiveStage(schedule, new Date(2026, 2, 23, 17, 56))?.stage, "force-wrap-up");
check("does not activate before wrap-up", getActiveStage(schedule, new Date(2026, 2, 23, 17, 30)), undefined);
check("does not activate a cancelled occurrence", getActiveStage({ ...schedule, cancelledOccurrence: "2026-03-23@18:00" }, new Date(2026, 2, 23, 17, 50)), undefined);
const skipped = markSkipNext(schedule, new Date(2026, 2, 23, 17, 0));
check("skip-next targets the current complete occurrence", [skipped.skipNext, skipped.skipNextOccurrence], [true, "2026-03-23@18:00"]);

const custom = normalizeSchedule("custom", {
	label: "Custom",
	time: "18:00",
	days: ["mon"],
	userReminderBefore: "30m",
	wrapUpBefore: "20m",
	forceWrapUpBefore: "5m",
	prompts: { "wrap-up": "Finish {{label}} by {{cutoff}}; {{remaining}} remain. Unknown={{unknown}}" },
});
const customEvent = getEventsBetween(custom, new Date(2026, 2, 23, 17, 40), new Date(2026, 2, 23, 18, 0))[0];
check(
	"renders custom prompt placeholders",
	renderPrompt(custom.prompts!["wrap-up"]!, customEvent, new Date(2026, 2, 23, 17, 50)),
	"Finish Custom by 2026-03-23 18:00; 10m remain. Unknown={{unknown}}",
);
const customConfig = normalizeConfig({ schedules: {}, prompts: { nudge: "Custom {{label}}", "force-wrap-up": "Force {{remaining}}", resume: "Resume {{label}}" } });
check("normalizes global prompt overrides", [customConfig.prompts.nudge, customConfig.prompts["force-wrap-up"], customConfig.prompts.resume], ["Custom {{label}}", "Force {{remaining}}", "Resume {{label}}"]);
const empty = emptyConfig();
check("new config has no schedules", Object.keys(empty.schedules), []);

const schedulerConfig = normalizeConfig({
	timezone: "local",
	schedules: { custom },
	humanNotification: true,
	catchUpOnResume: false,
	prompts: {},
});
const schedulerEvent = getEventsBetween(custom, new Date(2026, 2, 23, 17, 40), new Date(2026, 2, 23, 18, 0))[0];

check("keeps the agent stage while the root is busy", shouldDeliverAgentStage(true, undefined), true);
check("keeps the agent stage when background state is unknown", shouldDeliverAgentStage(false, undefined), true);
check("delivers the agent stage with active background runs", shouldDeliverAgentStage(false, 2), true);
check("skips the agent stage when idle without background runs", shouldDeliverAgentStage(false, 0), false);
check(
	"reads active runs from asyncSnapshot",
	activeRunsFromStatusReply({ data: { asyncSnapshot: { runs: [{ id: "a" }, { id: "b" }] } } }),
	2,
);
check("falls back to fleet.totalActive", activeRunsFromStatusReply({ data: { fleet: { totalActive: 3 } } }), 3);
check("reports unknown background state for unusable replies", activeRunsFromStatusReply({ data: {} }), undefined);

function mockEventBus(reply: unknown): { on: (channel: string, handler: (data: unknown) => void) => () => void; emit: (channel: string, data: unknown) => void } {
	const listeners = new Map<string, Set<(data: unknown) => void>>();
	return {
		on(channel, handler) {
			const handlers = listeners.get(channel) ?? new Set();
			handlers.add(handler);
			listeners.set(channel, handlers);
			return () => handlers.delete(handler);
		},
		emit(channel, data) {
			if (channel !== "subagents:rpc:v1:request" || reply === undefined) return;
			const requestId = (data as { requestId?: string }).requestId;
			for (const handler of listeners.get(`subagents:rpc:v1:reply:${requestId}`) ?? []) handler(reply);
		},
	};
}

async function fireStage(options: { idle: boolean; reply?: unknown; requireActiveWork?: boolean }): Promise<{ sent: number; notices: string[] }> {
	const sent: unknown[] = [];
	const notices: string[] = [];
	const config = options.requireActiveWork === undefined
		? schedulerConfig
		: normalizeConfig({ schedules: { custom }, requireActiveWork: options.requireActiveWork });
	const scheduler = new Scheduler(
		{
			sendMessage: (...args: unknown[]) => {
				sent.push(args);
				return Promise.resolve();
			},
			events: mockEventBus(options.reply),
		} as never,
		config,
		{
			isIdle: () => options.idle,
			ui: { notify: (message: string, type?: string) => notices.push(`${type ?? "info"}:${message}`) },
		} as never,
		async () => undefined,
	);
	await (scheduler as unknown as { fire: (event: typeof schedulerEvent) => Promise<void> }).fire(schedulerEvent);
	await Promise.resolve();
	return { sent: sent.length, notices };
}

const busy = await fireStage({ idle: false, reply: undefined });
check("delivers wrap-up while the root Agent is busy", busy.sent, 1);
check("shows a visible stage notification", busy.notices.length, 1);

const waiting = await fireStage({ idle: true, reply: { data: { fleet: { totalActive: 1 } } } });
check("delivers wrap-up while background runs are active", waiting.sent, 1);

const idle = await fireStage({ idle: true, reply: { data: { fleet: { totalActive: 0 } } } });
check("skips wrap-up when idle without background runs", idle.sent, 0);
check("explains the skipped stage", idle.notices.length, 1);

const legacy = await fireStage({ idle: true, reply: undefined, requireActiveWork: false });
check("restores unconditional delivery with requireActiveWork=false", legacy.sent, 1);

if (failures.length) {
	console.error("\nFAILED:\n" + failures.join("\n"));
	process.exit(1);
}
console.log("\nAll tests passed");
