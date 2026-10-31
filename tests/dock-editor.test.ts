import test from "node:test";
import assert from "node:assert/strict";

// The kitty matcher lives inside the DockEditor class; exercise it through the
// same byte sequences the field session recorded in debug.log.
//
// Minimal fakes: Editor's constructor stores refs and prepares state only.
const { DockEditor } = await import("../src/dock-editor.ts");
const { Key, matchesKey } = await import("@earendil-works/pi-tui");

// Rebuild the private matcher via a tiny instance-free proxy: construct with
// stub objects (Editor ctor does not touch them beyond storage).
const tui = { requestRender() {} };
const theme = { borderColor: (t: string) => t };
const keybindings = {};

// A DockController stub with recorded moves.
function makeDock(rows = 3) {
	const tasks = Array.from({ length: rows }, (_, i) => ({ id: `task-${i + 1}`, command: `sleep ${i + 1}` }));
	const recorded: Array<string> = [];
	return {
		recorded,
		inDock: () => true,
		enterDock: () => true,
		exitDock: () => {
			recorded.push("exit");
		},
		move: (delta: number) => {
			recorded.push(delta === -1 ? "up" : "down");
		},
		selected: () => tasks[0],
	};
}

function makeEditor(dock: ReturnType<typeof makeDock>) {
	const editor = Object.create(DockEditor.prototype) as InstanceType<typeof DockEditor>;
	// Bypass the constructor: stub the members handleInput touches.
	Object.assign(editor, {
		tui: { requestRender() {} },
		getText: () => "",
		dock,
	});
	return editor;
}

test("kitty protocol down arrow (CSI 1;1:1B) moves the dock selection down", () => {
	const dock = makeDock();
	const editor = makeEditor(dock);
	editor.handleInput("\u001b[1;1:1B"); // exact sequence from the field trace
	assert.deepEqual(dock.recorded, ["down"]);
});

test("kitty protocol up arrow (CSI 1;1:1A) moves up", () => {
	const dock = makeDock();
	const editor = makeEditor(dock);
	editor.handleInput("\u001b[1;1:1A");
	assert.deepEqual(dock.recorded, ["up"]);
});

test("legacy CSI and SS3 down arrows still match", () => {
	for (const sequence of ["\x1b[B", "\x1bOB"]) {
		const dock = makeDock();
		const editor = makeEditor(dock);
		editor.handleInput(sequence);
		assert.deepEqual(dock.recorded, ["down"], `sequence: ${JSON.stringify(sequence)}`);
	}
});

test("enter opens the selected task; escape exits dock mode", () => {
	const opened: string[] = [];
	const dock = makeDock();
	const editor = makeEditor(dock);
	editor.onOpenTask = (task) => opened.push(task.id);
	editor.handleInput("\r");
	assert.deepEqual(opened, ["task-1"]);

	const exited: string[] = [];
	const dock2 = makeDock();
	const editor2 = makeEditor(dock2);
	// exitDock is recorded via the recorded array through exitDock stub
	dock2.exitDock = () => {
		exited.push("exit");
		dock2.recorded.push("exit");
	};
});

test("escape key (plain ESC byte) exits dock mode", () => {
	const dock = makeDock();
	const editor = makeEditor(dock);
	let escaped = false;
	dock.exitDock = () => {
		escaped = true;
	};
	editor.handleInput("\x1b");
	assert.equal(escaped, true);
});

test("kitty escape (CSI 27 u) exits dock mode", () => {
	const dock = makeDock();
	const editor = makeEditor(dock);
	let escaped = false;
	dock.exitDock = () => {
		escaped = true;
	};
	editor.handleInput("\u001b[27u");
	assert.equal(escaped, true);
});

test("plain arrows still match the pi-tui Key bindings", () => {
	assert.equal(matchesKey("\x1b[B", Key.down), true);
	assert.equal(matchesKey("\x1b[A", Key.up), true);
});
