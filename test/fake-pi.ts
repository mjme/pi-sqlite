/**
 * A minimal stand-in for Pi's ExtensionAPI and ExtensionContext: implements only what src/index.ts uses,
 * recording every call so tests can assert on observable effects.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Handler = (event: any, ctx: any) => unknown;

export interface FakePi {
	pi: ExtensionAPI;
	flags: Record<string, { type: string; description?: string }>;
	tools: Record<string, any>;
	commands: Record<string, any>;
	messageRenderers: Record<string, any>;
	handlers: Record<string, Handler[]>;
	activeTools: string[];
	setActiveToolsCalls: string[][];
	entries: { customType: string; data: unknown }[];
	sent: { message: any; options: any }[];
	emit(event: string, payload: any, ctx: any): Promise<unknown[]>;
}

export function createFakePi(opts: { flags?: Record<string, string | boolean>; activeTools?: string[] } = {}): FakePi {
	const fake: FakePi = {
		pi: undefined as unknown as ExtensionAPI,
		flags: {},
		tools: {},
		commands: {},
		messageRenderers: {},
		handlers: {},
		activeTools: opts.activeTools ?? ["read", "bash", "edit", "write"],
		setActiveToolsCalls: [],
		entries: [],
		sent: [],
		async emit(event, payload, ctx) {
			const results = [];
			for (const h of fake.handlers[event] ?? []) results.push(await h({ type: event, ...payload }, ctx));
			return results;
		},
	};
	const pi = {
		registerFlag(name: string, o: { type: string; description?: string }) {
			fake.flags[name] = o;
		},
		getFlag(name: string) {
			return opts.flags?.[name];
		},
		registerTool(def: any) {
			fake.tools[def.name] = def;
		},
		registerCommand(name: string, def: any) {
			fake.commands[name] = def;
		},
		registerMessageRenderer(type: string, renderer: any) {
			fake.messageRenderers[type] = renderer;
		},
		on(event: string, handler: Handler) {
			(fake.handlers[event] ??= []).push(handler);
			return () => {};
		},
		getActiveTools() {
			return [...fake.activeTools];
		},
		setActiveTools(names: string[]) {
			fake.setActiveToolsCalls.push([...names]);
			fake.activeTools = [...names];
		},
		appendEntry(customType: string, data: unknown) {
			fake.entries.push({ customType, data });
		},
		sendMessage(message: any, options?: any) {
			fake.sent.push({ message, options });
		},
	};
	fake.pi = pi as unknown as ExtensionAPI;
	return fake;
}

export interface FakeCtx {
	cwd: string;
	hasUI: boolean;
	mode: string;
	notifications: { message: string; type?: string }[];
	statuses: { key: string; text: string | undefined }[];
	ui: { notify(message: string, type?: string): void; setStatus(key: string, text: string | undefined): void };
	sessionManager: { getBranch(): unknown[] };
	isIdle(): boolean;
}

export function createFakeCtx(opts: { cwd: string; hasUI?: boolean; branch?: unknown[]; idle?: boolean }): FakeCtx {
	const ctx: FakeCtx = {
		cwd: opts.cwd,
		hasUI: opts.hasUI ?? true,
		mode: opts.hasUI === false ? "print" : "tui",
		notifications: [],
		statuses: [],
		ui: {
			notify(message, type) {
				ctx.notifications.push({ message, type });
			},
			setStatus(key, text) {
				ctx.statuses.push({ key, text });
			},
		},
		sessionManager: { getBranch: () => opts.branch ?? [] },
		isIdle: () => opts.idle ?? true,
	};
	return ctx;
}

/** Theme stub: no colors, enough surface for themeStyle and renderCall. */
export const plainTheme = { fg: (_c: string, s: string) => s, bold: (s: string) => s } as any;
