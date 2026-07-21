import assert from "node:assert/strict";
import { describe, test } from "node:test";
import permissionGate from "../src/index.ts";

interface Completion {
	value: string;
	label: string;
}

interface RegisteredGateCommand {
	getArgumentCompletions?: (prefix: string) => Completion[] | null;
}

function gateCommand(): RegisteredGateCommand {
	let command: RegisteredGateCommand | undefined;
	permissionGate({
		on: () => undefined,
		registerCommand: (name: string, options: RegisteredGateCommand) => {
			if (name === "gate") command = options;
		},
	} as never);
	assert.ok(command);
	return command;
}

function applyArgumentCompletion(prefix: string, value: string): string {
	return `/gate ${prefix}`.slice(0, -prefix.length) + value;
}

describe("/gate argument completions", () => {
	test("nested mode completion preserves the subcommand", () => {
		const completions = gateCommand().getArgumentCompletions?.("mode a");
		assert.deepEqual(completions, [{ value: "mode auto", label: "auto" }]);
		assert.equal(applyArgumentCompletion("mode a", completions![0].value), "/gate mode auto");
	});

	test("nested dry-run completions preserve the subcommand", () => {
		const completions = gateCommand().getArgumentCompletions?.("dry-run o");
		assert.deepEqual(completions, [
			{ value: "dry-run on", label: "on" },
			{ value: "dry-run off", label: "off" },
		]);
	});

	test("a trailing subcommand space offers complete nested values", () => {
		const completions = gateCommand().getArgumentCompletions?.("mode ");
		assert.deepEqual(completions, [
			{ value: "mode default", label: "default" },
			{ value: "mode auto", label: "auto" },
			{ value: "mode off", label: "off" },
		]);
	});
});
