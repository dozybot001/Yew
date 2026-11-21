import { type RunningCommand, startCommand } from "./process.ts";

export interface Job {
	id: string;
	command: string;
	running: RunningCommand;
	startedAt: number;
	finished: { exitCode: number | null; signal: string | null; at: number } | null;
}

/** Commands a session started in the background. They keep running between turns until they end or are stopped. */
export class Jobs {
	readonly #jobs = new Map<string, Job>();
	#next = 1;
	readonly #onFinish: (job: Job) => void;

	constructor(onFinish: (job: Job) => void) {
		this.#onFinish = onFinish;
	}

	/** Starts a command in the background; it runs in the sandbox like any other, but never asks the person. */
	async start(options: {
		command: string;
		cwd: string;
		sessionId: string;
		logDir: string;
		outsideSandbox?: boolean;
		writableDirs?: string[];
		allowedSites?: string[];
		containers?: boolean;
	}): Promise<Job> {
		const id = `job-${this.#next++}`;
		const running = await startCommand({ ...options, background: true });
		const job: Job = {
			id,
			command: options.command,
			running,
			startedAt: Date.now(),
			finished: null,
		};
		this.#jobs.set(id, job);
		void running.done.then((result) => {
			job.finished = { ...result, at: Date.now() };
			this.#onFinish(job);
		});
		return job;
	}

	get(id: string): Job | undefined {
		return this.#jobs.get(id);
	}

	list(): Job[] {
		return [...this.#jobs.values()];
	}

	stopAll(): void {
		for (const job of this.#jobs.values()) if (!job.finished) job.running.stop();
	}
}
