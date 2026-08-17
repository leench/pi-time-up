import {
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

if (failures.length) {
	console.error("\nFAILED:\n" + failures.join("\n"));
	process.exit(1);
}
console.log("\nAll tests passed");
