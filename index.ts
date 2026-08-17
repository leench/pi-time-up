import { homedir } from "node:os";
import { join } from "node:path";
import { promises as fs } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	emptyConfig,
	formatLocalDate,
	formatRemaining,
	getActiveStageForConfig,
	getCurrentOrNextOccurrence,
	getEventsBetween,
	getNextEvent,
	getNextOccurrence,
	normalizeConfig,
	normalizeSchedule,
	parseTime,
	DEFAULT_PROMPTS,
	markSkipNext,
	renderPrompt,
	renderTemplate,
	type PromptAction,
	type ReminderEvent,
	type Schedule,
	type TimeUpConfig,
} from "./time-up.ts";

const CONFIG_FILE = "time-up.json";
const MAX_TIMER_MS = 60 * 60 * 1000;
const CUSTOM_MESSAGE_TYPE = "time-up";

type Persist = () => Promise<void>;

function configPath(): string {
	return join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), CONFIG_FILE);
}

async function readConfig(path: string): Promise<TimeUpConfig> {
	try {
		const text = await fs.readFile(path, "utf8");
		return normalizeConfig(JSON.parse(text));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyConfig();
		throw error;
	}
}

async function writeConfig(path: string, config: TimeUpConfig): Promise<void> {
	const directory = join(path, "..");
	await fs.mkdir(directory, { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
	await fs.writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
	try {
		await fs.rename(temporary, path);
	} catch (error) {
		await fs.rm(temporary, { force: true }).catch(() => undefined);
		throw error;
	}
}

function daysText(schedule: Schedule): string {
	return schedule.days.join(",");
}

function promptFor(event: ReminderEvent, config: TimeUpConfig): string {
	const action: PromptAction = event.stage === "force-wrap-up" ? "force-wrap-up" : "wrap-up";
	const template = event.schedule.prompts?.[action] ?? config.prompts[action] ?? DEFAULT_PROMPTS[action];
	return renderPrompt(template, event);
}

function stageMessage(event: ReminderEvent, config: TimeUpConfig) {
	return {
		customType: CUSTOM_MESSAGE_TYPE,
		content: promptFor(event, config),
		display: true,
		details: { scheduleId: event.schedule.id, occurrence: event.occurrence.id, warning: event.warning, stage: event.stage },
	};
}

function sendStagePrompt(pi: ExtensionAPI, event: ReminderEvent, config: TimeUpConfig): void {
	pi.sendMessage(stageMessage(event, config), { triggerTurn: true, deliverAs: "steer" });
}

class Scheduler {
	private timer: ReturnType<typeof setTimeout> | undefined;
	private startedAt = new Date();
	private readonly fired = new Set<string>();
	private running = false;

	constructor(
		private readonly pi: ExtensionAPI,
		private config: TimeUpConfig,
		private readonly ctx: ExtensionContext,
		private readonly persist: Persist,
		private readonly hasActiveWork: () => boolean,
	) {}

	start(): void {
		this.stop();
		this.startedAt = new Date();
		this.running = true;
		void this.tick(true);
	}

	stop(): void {
		this.running = false;
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = undefined;
	}

	update(config: TimeUpConfig): void {
		this.config = config;
		if (this.running) {
			if (this.timer !== undefined) clearTimeout(this.timer);
			this.timer = undefined;
			void this.tick(true);
		}
	}

	private async tick(initial: boolean): Promise<void> {
		if (!this.running) return;
		const now = new Date();
		if (initial && this.config.catchUpOnResume) await this.processCatchUp(now);
		if (!initial) await this.processDue(now);
		await this.clearCompletedSkips(now);
		if (!this.running) return;
		let next: ReminderEvent | undefined;
		for (const schedule of Object.values(this.config.schedules)) {
			if (!schedule.enabled) continue;
			const candidate = getNextEvent(schedule, now);
			if (candidate && (!next || candidate.at < next.at)) next = candidate;
		}
		const delay = next ? Math.max(1000, Math.min(next.at.getTime() - Date.now(), MAX_TIMER_MS)) : MAX_TIMER_MS;
		this.timer = setTimeout(() => void this.tick(false), delay);
	}

	private async processDue(now: Date): Promise<void> {
		for (const schedule of Object.values(this.config.schedules)) {
			if (!schedule.enabled) continue;
			const events = getEventsBetween(schedule, this.startedAt, now);
			for (const event of events) await this.fire(event);
		}
	}

	private async processCatchUp(now: Date): Promise<void> {
		for (const schedule of Object.values(this.config.schedules)) {
			if (!schedule.enabled) continue;
			const events = getEventsBetween(schedule, new Date(now.getTime() - 8 * 86400_000), now);
			const latestByOccurrence = new Map<string, ReminderEvent>();
			for (const event of events) latestByOccurrence.set(event.occurrence.id, event);
			const latest = [...latestByOccurrence.values()].sort((a, b) => b.at.getTime() - a.at.getTime())[0];
			if (latest) await this.fire(latest);
		}
	}

	private async fire(event: ReminderEvent): Promise<void> {
		const key = `${event.schedule.id}:${event.occurrence.id}:${event.stage}`;
		if (this.fired.has(key)) return;
		this.fired.add(key);
		const schedule = event.schedule;
		const occurrenceId = event.occurrence.id;
		const skipped = schedule.skipNext === true && (schedule.skipNextOccurrence === occurrenceId || !schedule.skipNextOccurrence);
		if (skipped || schedule.cancelledOccurrence === occurrenceId) return;

		if (event.stage === "user-reminder") {
			if (this.config.humanNotification) {
				this.ctx.ui.notify(
					`${schedule.label}: deadline in ${formatRemaining(event.occurrence.cutoff.getTime() - Date.now())}. Use /time-up skip ${schedule.id} to skip this occurrence.`,
					"warning",
				);
			}
			return;
		}

		if (!this.hasActiveWork()) return;
		schedule.activeOccurrence = occurrenceId;
		await this.persist();
		sendStagePrompt(this.pi, event, this.config);
	}

	private async clearCompletedSkips(now: Date): Promise<void> {
		let changed = false;
		for (const schedule of Object.values(this.config.schedules)) {
			const targets = [schedule.skipNextOccurrence, schedule.activeOccurrence, schedule.cancelledOccurrence].filter(
				(target): target is string => Boolean(target),
			);
			for (const target of targets) {
				const occurrence = getEventsBetween(schedule, new Date(now.getTime() - 8 * 86400_000), now)
					.map((event) => event.occurrence)
					.find((candidate) => candidate.id === target);
				if (!occurrence || occurrence.cutoff > now) continue;
				if (schedule.skipNextOccurrence === target) {
					schedule.skipNext = false;
					schedule.skipNextOccurrence = undefined;
				}
				if (schedule.activeOccurrence === target) schedule.activeOccurrence = undefined;
				if (schedule.cancelledOccurrence === target) schedule.cancelledOccurrence = undefined;
				changed = true;
			}
		}
		if (changed) await this.persist();
	}
}

function notifyError(ctx: ExtensionContext, message: string, error?: unknown): void {
	const detail = error instanceof Error ? `: ${error.message}` : "";
	ctx.ui.notify(`${message}${detail}`, "error");
}

function chooseSchedule(config: TimeUpConfig, id: string | undefined, now = new Date()): Schedule | undefined {
	if (id) return config.schedules[id];
	return Object.values(config.schedules)
		.filter((schedule) => schedule.enabled)
		.map((schedule) => ({ schedule, next: getNextOccurrence(schedule, now) }))
		.sort((a, b) => a.next.cutoff.getTime() - b.next.cutoff.getTime())[0]?.schedule;
}

function chooseActiveSchedule(config: TimeUpConfig, id?: string): Schedule | undefined {
	if (id) {
		const schedule = config.schedules[id];
		return schedule?.activeOccurrence ? schedule : undefined;
	}
	return Object.values(config.schedules).find((schedule) => Boolean(schedule.activeOccurrence));
}

function statusText(config: TimeUpConfig, now = new Date()): string {
	const schedules = Object.values(config.schedules);
	if (schedules.length === 0) return "time-up: no schedules configured. Use /time-up set <id> <HH:mm> [days...].";
	const lines = [`time-up (timezone: local) — ${schedules.length} schedule(s)`];
	for (const schedule of schedules) {
		const next = schedule.enabled ? getNextOccurrence(schedule, now) : undefined;
		const skip = schedule.skipNext ? `; skip${schedule.skipNextOccurrence ? ` (${schedule.skipNextOccurrence})` : ""}` : "";
		const active = schedule.activeOccurrence ? `; wrap-up active (${schedule.activeOccurrence})` : "";
		const cancelled = schedule.cancelledOccurrence ? `; current wrap-up cancelled (${schedule.cancelledOccurrence})` : "";
		lines.push(
			`- ${schedule.id}: ${schedule.enabled ? "enabled" : "disabled"}, ${schedule.time} ${daysText(schedule)}, user=${schedule.userReminderBefore}, wrap-up=${schedule.wrapUpBefore}, force=${schedule.forceWrapUpBefore}${skip}${active}${cancelled}`,
		);
		if (next) lines.push(`  next cutoff: ${formatLocalDate(next.cutoff)} (${formatRemaining(next.cutoff.getTime() - now.getTime())})`);
	}
	return lines.join("\n");
}

export default function timeUpExtension(pi: ExtensionAPI): void {
	let config = emptyConfig();
	let loaded = false;
	let scheduler: Scheduler | undefined;
	const path = configPath();

	const activeSubagents = new Set<string>();
	let rootContext: ExtensionContext | undefined;
	let suppressNextPhaseInjection = 0;
	const hasActiveWork = (): boolean => Boolean(rootContext && !rootContext.isIdle()) || activeSubagents.size > 0;

	const load = async (ctx: ExtensionContext): Promise<boolean> => {
		try {
			config = await readConfig(path);
			loaded = true;
			return true;
		} catch (error) {
			loaded = false;
			notifyError(ctx, `Could not load ${path}`, error);
			return false;
		}
	};
	const save = async (ctx: ExtensionContext): Promise<boolean> => {
		try {
			await writeConfig(path, config);
			return true;
		} catch (error) {
			notifyError(ctx, `Could not save ${path}`, error);
			return false;
		}
	};
	const ensureLoaded = async (ctx: ExtensionContext): Promise<boolean> => loaded || load(ctx);
	const restart = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI) return;
		if (scheduler) scheduler.update(config);
		else if (loaded) scheduler = new Scheduler(pi, config, ctx, () => save(ctx).then(() => undefined), hasActiveWork);
		if (scheduler) scheduler.start();
	};

	pi.on("session_start", async (_event, ctx) => {
		if (!(await load(ctx))) return;
		if (!ctx.hasUI) return;
		rootContext = ctx;
		scheduler?.stop();
		scheduler = new Scheduler(pi, config, ctx, () => save(ctx).then(() => undefined), hasActiveWork);
		scheduler.start();
		ctx.ui.setStatus("time-up", Object.keys(config.schedules).length ? "time-up active" : undefined);
	});
	pi.on("session_shutdown", () => {
		scheduler?.stop();
		scheduler = undefined;
		rootContext = undefined;
		activeSubagents.clear();
	});

	// Inject the active phase into every new main-agent task. Child sessions
	// receive the same hook, so a newly started subagent gets the constraint
	// directly even when the parent has no public steer RPC.
	pi.on("before_agent_start", async (_event, ctx) => {
		if (!(await ensureLoaded(ctx))) return;
		const event = getActiveStageForConfig(config);
		if (!event) return;
		if (ctx.hasUI && suppressNextPhaseInjection > 0) {
			suppressNextPhaseInjection -= 1;
			return;
		}
		if (ctx.hasUI && event.schedule.activeOccurrence !== event.occurrence.id) {
			event.schedule.activeOccurrence = event.occurrence.id;
			await save(ctx);
		}
		return { message: stageMessage(event, config) };
	});

	// The root session uses this event to re-notify the main agent when a new
	// child starts during an active phase; the main agent then calls its normal
	// steer_subagent tool. Child sessions also receive the phase via the hook
	// above, so this is a supervisor fallback rather than an internal patch.
	pi.events.on("subagents:started", async (event: unknown) => {
		const id = typeof event === "object" && event && "id" in event ? String((event as { id: unknown }).id) : undefined;
		if (id) activeSubagents.add(id);
		const ctx = rootContext;
		if (!ctx || !(await ensureLoaded(ctx))) return;
		const stage = getActiveStageForConfig(config);
		if (!stage) return;
		stage.schedule.activeOccurrence = stage.occurrence.id;
		await save(ctx);
		suppressNextPhaseInjection += 1;
		sendStagePrompt(pi, stage, config);
	});
	pi.events.on("subagents:completed", (event: unknown) => {
		if (typeof event === "object" && event && "id" in event) activeSubagents.delete(String((event as { id: unknown }).id));
	});
	pi.events.on("subagents:failed", (event: unknown) => {
		if (typeof event === "object" && event && "id" in event) activeSubagents.delete(String((event as { id: unknown }).id));
	});

	pi.registerCommand("time-up", {
		description: "Manage soft time limits and wrap-up reminders",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const command = parts[0] || "help";
			if (command === "help") {
				ctx.ui.notify(
					"time-up — soft deadline reminders for work, bedtime, and long-running tasks.\n\n" +
					"Flow: notify the user 30m before the cutoff → start wrap-up at 20m → force wrap-up at 5m.\n" +
					"It sends steer instructions after the current tool call; it does not hard-kill processes.\n\n" +
					"Commands:\n" +
					"/time-up status\n" +
					"/time-up set <id> <HH:mm> [mon tue ...]\n" +
					"/time-up enable|disable <id>\n" +
					"/time-up skip [id]\n" +
					"/time-up resume [id]       cancel the current wrap-up\n" +
					"/time-up reload\n" +
					"/time-up help",
					"info",
				);
				return;
			}
			if (!(await ensureLoaded(ctx))) return;
			if (command === "status") {
				ctx.ui.notify(statusText(config), "info");
				return;
			}
			if (command === "reload") {
				if (await load(ctx)) {
					restart(ctx);
					ctx.ui.notify(`Reloaded ${path}`, "info");
				}
				return;
			}
			if (command === "set") {
				const [id, time, ...dayArgs] = parts.slice(1);
				if (!id || !time) {
					ctx.ui.notify("Usage: /time-up set <id> <HH:mm> [mon tue ...]", "warning");
					return;
				}
				try {
					parseTime(time);
					const existing = config.schedules[id];
					const days = dayArgs.length ? dayArgs : existing?.days || ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
					config.schedules[id] = normalizeSchedule(id, {
						...(existing || {
							label: id,
							userReminderBefore: "30m",
							wrapUpBefore: "20m",
							forceWrapUpBefore: "5m",
							enabled: true,
						}),
						time,
						days,
					});
					if (await save(ctx)) {
						restart(ctx);
						ctx.ui.notify(`Saved schedule ${id}.`, "info");
					}
				} catch (error) {
					notifyError(ctx, "Invalid schedule", error);
				}
				return;
			}
			if (command === "enable" || command === "disable") {
				const id = parts[1];
				const schedule = id ? config.schedules[id] : undefined;
				if (!schedule) {
					ctx.ui.notify(`Unknown schedule: ${id || "(missing id)"}`, "warning");
					return;
				}
				schedule.enabled = command === "enable";
				if (await save(ctx)) {
					restart(ctx);
					ctx.ui.notify(`${command === "enable" ? "Enabled" : "Disabled"} ${id}.`, "info");
				}
				return;
			}
			if (command === "resume") {
				const schedule = chooseActiveSchedule(config, parts[1]);
				if (!schedule || !schedule.activeOccurrence) {
					ctx.ui.notify("No active Time-up wrap-up is available to resume.", "warning");
					return;
				}
				const target = schedule.activeOccurrence;
				const occurrence = getEventsBetween(schedule, new Date(Date.now() - 8 * 86400_000), new Date(Date.now() + 8 * 86400_000))
					.map((event) => event.occurrence)
					.find((candidate) => candidate.id === target);
				if (!occurrence) {
					ctx.ui.notify(`Could not find active occurrence ${target}.`, "warning");
					return;
				}
				schedule.cancelledOccurrence = target;
				schedule.activeOccurrence = undefined;
				if (await save(ctx)) {
					restart(ctx);
					const template = schedule.prompts?.resume ?? config.prompts.resume ?? DEFAULT_PROMPTS.resume;
					pi.sendMessage(
						{
							customType: CUSTOM_MESSAGE_TYPE,
							content: renderTemplate(template, {
								label: schedule.label,
								scheduleId: schedule.id,
								cutoff: formatLocalDate(occurrence.cutoff),
								remaining: formatRemaining(occurrence.cutoff.getTime() - Date.now()),
								warning: "",
								warningMinutes: "",
								stage: "resume",
							}),
							display: true,
							details: { scheduleId: schedule.id, occurrence: target, stage: "resume" },
						},
						{ triggerTurn: true, deliverAs: "steer" },
					);
					ctx.ui.notify(`Cancelled the current wrap-up for ${schedule.id}; resume instruction sent.`, "info");
				}
				return;
			}
			if (command === "skip" || command === "skip-next" || command === "ignore-next") {
				const schedule = chooseSchedule(config, parts[1]);
				if (!schedule || !schedule.enabled) {
					ctx.ui.notify("No enabled schedule is available to skip.", "warning");
					return;
				}
				if (schedule.activeOccurrence) {
					ctx.ui.notify(`Wrap-up is already active for ${schedule.id}; use /time-up resume ${schedule.id} to cancel it.`, "warning");
					return;
				}
				try {
					const marked = markSkipNext(schedule);
					schedule.skipNext = marked.skipNext;
					schedule.skipNextOccurrence = marked.skipNextOccurrence;
					const occurrence = getCurrentOrNextOccurrence(schedule);
					if (await save(ctx)) {
						restart(ctx);
						ctx.ui.notify(`Will skip the complete next reminder cycle for ${schedule.id} (${occurrence.id}).`, "info");
					}
				} catch (error) {
					notifyError(ctx, "Could not set skip", error);
				}
				return;
			}
			ctx.ui.notify(`Unknown /time-up command: ${command}. Try /time-up help.`, "warning");
		},
	});
}

export { configPath, normalizeConfig, readConfig, statusText };
