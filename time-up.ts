export const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type DayName = (typeof DAY_NAMES)[number];
export type Action = "notify" | "nudge" | "wrap-up" | "force-wrap-up";
export type PromptAction = Exclude<Action, "notify"> | "resume";
export type PromptTemplates = Partial<Record<PromptAction, string>>;
export type ReminderStage = "user-reminder" | "wrap-up" | "force-wrap-up";

export const DEFAULT_PROMPTS: Record<PromptAction, string> = {
	nudge: "Time-up soft deadline reminder for {{label}}. The cutoff is {{cutoff}} (local time), with {{remaining}} remaining. This is a soft deadline, not a request to hard-kill tools. Keep the task focused and assess what can be completed safely.",
	"wrap-up": "Time-up soft deadline for {{label}}: the cutoff is {{cutoff}} (local time), with {{remaining}} remaining. This is a soft deadline; do not hard-kill the current tool.\n\nSwitch to wrap-up mode:\n- Do not start new large tasks.\n- Check the currently running subagents.\n- For each subagent still running, use the existing steer_subagent tool and ask it to finish its current tool call, then converge.\n- Prioritize saving changes, essential verification, and a concise handoff.\n- Do not expand the scope.",
	"force-wrap-up": "Only {{remaining}} remain before the {{label}} cutoff at {{cutoff}}. Force wrap-up now: do not start or continue non-essential work. Ask every running subagent to finish its current tool call and converge immediately. Save changes, perform only essential verification, and produce the final handoff. Do not hard-kill the current tool.",
	resume: "The user has cancelled the current Time-up wrap-up request for {{label}}. Resume normal task execution and do not treat the previous Time-up message as a request to stop. Continue the original task if it is safe to do so.",
};

export interface Schedule {
	id: string;
	label: string;
	time: string;
	days: DayName[];
	/** User-only reminder lead time. Defaults to 30m. */
	userReminderBefore: string;
	/** Normal agent wrap-up lead time. Defaults to 20m. */
	wrapUpBefore: string;
	/** Strong agent wrap-up lead time. Defaults to 5m. */
	forceWrapUpBefore: string;
	enabled: boolean;
	prompts?: PromptTemplates;
	skipNext?: boolean;
	skipNextOccurrence?: string;
	activeOccurrence?: string;
	cancelledOccurrence?: string;
}

export interface TimeUpConfig {
	timezone: "local";
	schedules: Record<string, Schedule>;
	humanNotification: boolean;
	catchUpOnResume: boolean;
	prompts: PromptTemplates;
}

export interface Occurrence {
	id: string;
	cutoff: Date;
}

export interface ReminderEvent {
	schedule: Schedule;
	occurrence: Occurrence;
	stage: ReminderStage;
	warning: string;
	warningMinutes: number;
	at: Date;
}

export function parseTime(value: string): number {
	if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
		throw new Error(`Invalid time "${value}"; expected HH:mm`);
	}
	const [hours, minutes] = value.split(":").map(Number);
	return hours * 60 + minutes;
}

export function parseWarning(value: string): number {
	const match = /^(\d+)([mhd])$/i.exec(value.trim());
	if (!match) throw new Error(`Invalid warning "${value}"; expected e.g. 30m, 1h, or 0m`);
	const amount = Number(match[1]);
	const unit = match[2].toLowerCase();
	const minutes = unit === "h" ? amount * 60 : unit === "d" ? amount * 1440 : amount;
	if (!Number.isSafeInteger(minutes) || minutes > 10080) {
		throw new Error(`Warning "${value}" is too large`);
	}
	return minutes;
}

function canonicalWarning(minutes: number): string {
	if (minutes % 1440 === 0 && minutes > 0) return `${minutes / 1440}d`;
	if (minutes % 60 === 0 && minutes > 0) return `${minutes / 60}h`;
	return `${minutes}m`;
}

function isDayName(value: unknown): value is DayName {
	return typeof value === "string" && (DAY_NAMES as readonly string[]).includes(value);
}

export function normalizePrompts(value: unknown, scope = "prompts"): PromptTemplates {
	if (value === undefined) return {};
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${scope} must be an object`);
	}
	const raw = value as Record<string, unknown>;
	const prompts: PromptTemplates = {};
	for (const action of ["nudge", "wrap-up", "force-wrap-up", "resume"] as const) {
		if (raw[action] === undefined) continue;
		if (typeof raw[action] !== "string" || !raw[action].trim()) {
			throw new Error(`${scope}.${action} must be a non-empty string`);
		}
		prompts[action] = raw[action];
	}
	return prompts;
}

export function normalizeSchedule(id: string, value: unknown): Schedule {
	if (!value || typeof value !== "object") throw new Error(`Schedule "${id}" must be an object`);
	const raw = value as Partial<Schedule>;
	if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error(`Invalid schedule id "${id}"`);
	const time = typeof raw.time === "string" ? raw.time : "";
	parseTime(time);
	const days = Array.isArray(raw.days) ? raw.days.filter(isDayName) : [];
	if (days.length === 0 || days.length !== raw.days?.length) {
		throw new Error(`Schedule "${id}" must have one or more valid days`);
	}
	const userReminderBefore = canonicalWarning(parseWarning(String(raw.userReminderBefore ?? "30m")));
	const wrapUpBefore = canonicalWarning(parseWarning(String(raw.wrapUpBefore ?? "20m")));
	const forceWrapUpBefore = canonicalWarning(parseWarning(String(raw.forceWrapUpBefore ?? "5m")));
	if (parseWarning(userReminderBefore) <= parseWarning(wrapUpBefore)) {
		throw new Error(`Schedule "${id}" userReminderBefore must be greater than wrapUpBefore`);
	}
	if (parseWarning(wrapUpBefore) <= parseWarning(forceWrapUpBefore)) {
		throw new Error(`Schedule "${id}" wrapUpBefore must be greater than forceWrapUpBefore`);
	}
	if (parseWarning(wrapUpBefore) < 20) {
		throw new Error(`Schedule "${id}" wrapUpBefore must be at least 20m`);
	}
	const prompts = normalizePrompts(raw.prompts, `Schedule "${id}" prompts`);
	return {
		id,
		label: typeof raw.label === "string" && raw.label.trim() ? raw.label : id,
		time,
		days: [...new Set(days)],
		userReminderBefore,
		wrapUpBefore,
		forceWrapUpBefore,
		enabled: raw.enabled !== false,
		...(Object.keys(prompts).length > 0 ? { prompts } : {}),
		skipNext: raw.skipNext === true,
		skipNextOccurrence: typeof raw.skipNextOccurrence === "string" ? raw.skipNextOccurrence : undefined,
		activeOccurrence: typeof raw.activeOccurrence === "string" ? raw.activeOccurrence : undefined,
		cancelledOccurrence: typeof raw.cancelledOccurrence === "string" ? raw.cancelledOccurrence : undefined,
	};
}

export function normalizeConfig(value: unknown): TimeUpConfig {
	if (!value || typeof value !== "object") throw new Error("time-up configuration must be a JSON object");
	const raw = value as Partial<TimeUpConfig>;
	if (raw.timezone !== undefined && raw.timezone !== "local") {
		throw new Error('Only timezone "local" is currently supported');
	}
	if (!raw.schedules || typeof raw.schedules !== "object" || Array.isArray(raw.schedules)) {
		throw new Error("time-up configuration requires a schedules object");
	}
	const schedules: Record<string, Schedule> = {};
	for (const [id, schedule] of Object.entries(raw.schedules)) schedules[id] = normalizeSchedule(id, schedule);
	const prompts = normalizePrompts(raw.prompts);
	return {
		timezone: "local",
		schedules,
		humanNotification: raw.humanNotification !== false,
		catchUpOnResume: raw.catchUpOnResume === true,
		prompts,
	};
}

export function emptyConfig(): TimeUpConfig {
	return {
		timezone: "local",
		schedules: {},
		humanNotification: true,
		catchUpOnResume: false,
		prompts: {},
	};
}

function occurrenceForDate(schedule: Schedule, date: Date): Occurrence | undefined {
	if (!schedule.days.includes(DAY_NAMES[date.getDay()])) return undefined;
	const minutes = parseTime(schedule.time);
	const cutoff = new Date(date.getFullYear(), date.getMonth(), date.getDate(), Math.floor(minutes / 60), minutes % 60, 0, 0);
	return { id: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}@${schedule.time}`, cutoff };
}

export function getNextOccurrence(schedule: Schedule, from = new Date()): Occurrence {
	for (let offset = 0; offset <= 8; offset++) {
		const date = new Date(from.getFullYear(), from.getMonth(), from.getDate() + offset);
		const occurrence = occurrenceForDate(schedule, date);
		if (occurrence && occurrence.cutoff > from) return occurrence;
	}
	throw new Error(`Could not find a future occurrence for ${schedule.id}`);
}

export function getCurrentOrNextOccurrence(schedule: Schedule, at = new Date()): Occurrence {
	for (let offset = 0; offset <= 8; offset++) {
		const date = new Date(at.getFullYear(), at.getMonth(), at.getDate() + offset);
		const occurrence = occurrenceForDate(schedule, date);
		if (occurrence && occurrence.cutoff >= at) return occurrence;
	}
	return getNextOccurrence(schedule, at);
}

export function markSkipNext(schedule: Schedule, at = new Date()): Schedule {
	return { ...schedule, skipNext: true, skipNextOccurrence: getCurrentOrNextOccurrence(schedule, at).id };
}

export function getEventsBetween(schedule: Schedule, from: Date, through: Date): ReminderEvent[] {
	const events: ReminderEvent[] = [];
	const stages: Array<[ReminderStage, string]> = [
		["user-reminder", schedule.userReminderBefore],
		["wrap-up", schedule.wrapUpBefore],
		["force-wrap-up", schedule.forceWrapUpBefore],
	];
	for (let offset = -8; offset <= 16; offset++) {
		const date = new Date(from.getFullYear(), from.getMonth(), from.getDate() + offset);
		const occurrence = occurrenceForDate(schedule, date);
		if (!occurrence) continue;
		for (const [stage, warning] of stages) {
			const warningMinutes = parseWarning(warning);
			const at = new Date(occurrence.cutoff.getTime() - warningMinutes * 60_000);
			if (at >= from && at <= through) events.push({ schedule, occurrence, stage, warning, warningMinutes, at });
		}
	}
	return events.sort((a, b) => a.at.getTime() - b.at.getTime());
}

export function getNextEvent(schedule: Schedule, from = new Date()): ReminderEvent | undefined {
	const events = getEventsBetween(schedule, from, new Date(from.getTime() + 9 * 24 * 60 * 60_000));
	return events.find((event) => event.at > from);
}

export function formatRemaining(milliseconds: number): string {
	if (milliseconds <= 0) return "deadline reached";
	const totalMinutes = Math.ceil(milliseconds / 60_000);
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export function formatLocalDate(date: Date): string {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function renderTemplate(template: string, values: Record<string, string>): string {
	return template.replace(/\{\{([a-zA-Z][a-zA-Z0-9_-]*)\}\}/g, (placeholder, key: string) => values[key] ?? placeholder);
}

export function renderPrompt(template: string, event: ReminderEvent, now = new Date()): string {
	return renderTemplate(template, {
		label: event.schedule.label,
		scheduleId: event.schedule.id,
		cutoff: formatLocalDate(event.occurrence.cutoff),
		remaining: formatRemaining(event.occurrence.cutoff.getTime() - now.getTime()),
		warning: event.warning,
		warningMinutes: String(event.warningMinutes),
		stage: event.stage,
	});
}
