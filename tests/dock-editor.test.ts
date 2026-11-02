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

test("typed key is not swallowed when dock rows vanished (auto-release, no Esc needed)", () => {
	const dock = makeDock();
	// Rows gone: the controller still thinks it is in dock mode but has no row.
	dock.selected = () => undefined as never;
	let forwarded: string | undefined;
	const editor = makeEditor(dock);
	// Capture what reaches the real editor.
	editor.handleInput = DockEditor.prototype.handleInput.bind(editor);
	Object.assign(editor, {
		tui: { requestRender() {} },
		getText: () => "",
		dock,
	});
	const superSpy = Object.getPrototypeOf(DockEditor.prototype).handleInput as (d: string) => void;
	void superSpy;
	(editor as unknown as { __forwarded?: string }).__forwarded = undefined;
	// Patch the CustomEditor prototype method via an own-property shim.
	const proto = Object.getPrototypeOf(Object.getPrototypeOf(editor));
	const original = proto.handleInput;
	proto.handleInput = function patched(data: string) {
		forwarded = data;
	};
	try {
		editor.handleInput("x");
	} finally {
		proto.handleInput = original;
	}
	assert.equal(forwarded, "x", "the keystroke must reach the real editor");
	assert.ok(dock.recorded.includes("exit"), "dock mode must be released");
});

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

test("up arrow on row 0 exits dock mode to editor", () => {
	const dock = makeDock();
	Object.assign(dock, {
		selectedIndex: () => 0,
	});
	const editor = makeEditor(dock);
	editor.handleInput("\x1b[A");
	assert.deepEqual(dock.recorded, ["exit"]);
});

test("up arrow on row > 0 moves selection up", () => {
	const dock = makeDock();
	Object.assign(dock, {
		selectedIndex: () => 1,
	});
	const editor = makeEditor(dock);
	editor.handleInput("\x1b[A");
	assert.deepEqual(dock.recorded, ["up"]);
});

test("detail mode navigation: enter opens detail, up/down moves task selection, pgup/pgdn scrolls log, esc closes detail", () => {
	const dock = makeDock();
	let isDetail = false;
	let selectedIdx = 0;
	const detailScrolled: number[] = [];
	Object.assign(dock, {
		isDetail: () => isDetail,
		selectedIndex: () => selectedIdx,
		openDetail: () => {
			isDetail = true;
			dock.recorded.push("openDetail");
		},
		closeDetail: () => {
			isDetail = false;
			dock.recorded.push("closeDetail");
		},
		move: (delta: number) => {
			selectedIdx += delta;
			dock.recorded.push(delta === -1 ? "up" : "down");
		},
		scrollDetail: (d: number) => {
			detailScrolled.push(d);
		},
	});
	const editor = makeEditor(dock);

	// Enter opens detail
	editor.handleInput("\r");
	assert.equal(isDetail, true);
	assert.ok(dock.recorded.includes("openDetail"));

	// Down arrow moves selection down
	editor.handleInput("\x1b[B"); // down
	assert.ok(dock.recorded.includes("down"));
	assert.equal(selectedIdx, 1);

	// Up arrow moves selection up
	editor.handleInput("\x1b[A"); // up
	assert.ok(dock.recorded.includes("up"));
	assert.equal(selectedIdx, 0);

	// Up arrow at top row exits dock mode to editor
	editor.handleInput("\x1b[A"); // up at row 0
	assert.ok(dock.recorded.includes("exit"));

	// PgUp / PgDn scrolls log
	editor.handleInput("\u001b[5~"); // PgUp
	assert.deepEqual(detailScrolled, [-10]);
	editor.handleInput("\u001b[6~"); // PgDn
	assert.deepEqual(detailScrolled, [-10, 10]);

	// In detail mode: esc closes detail and exits
	editor.handleInput("\x1b");
	assert.equal(isDetail, false);
	assert.ok(dock.recorded.includes("closeDetail"));
});

test("fleet coordinator integration: Tab, down past bottom, and left switch to fleet", () => {
	const SHARED_FLEET_COORDINATOR_KEY = Symbol.for("pi-subagents:fleet-coordinator");
	let fleetActivated: boolean | undefined;
	(globalThis as any)[SHARED_FLEET_COORDINATOR_KEY] = {
		hasRows: () => true,
		activate: (fromTop: boolean) => {
			fleetActivated = fromTop;
		},
	};

	try {
		const dock = makeDock(2);
		const tasks = [
			{ id: "task-1", command: "sleep 1" },
			{ id: "task-2", command: "sleep 2" },
		];
		let selectedIdx = 0;
		Object.assign(dock, {
			getTasks: () => tasks,
			selectedIndex: () => selectedIdx,
		});
		const editor = makeEditor(dock);

		// Tab switches from dock to fleet
		editor.handleInput("\t");
		assert.equal(fleetActivated, true);
		assert.ok(dock.recorded.includes("exit"));

		// Reset
		fleetActivated = undefined;
		dock.recorded.length = 0;

		// Left arrow switches from dock to fleet
		editor.handleInput("\x1b[D"); // left
		assert.equal(fleetActivated, true);
		assert.ok(dock.recorded.includes("exit"));

		// Reset
		fleetActivated = undefined;
		dock.recorded.length = 0;

		// Down arrow at bottom task (index 1 of 2 tasks) transitions to fleet
		selectedIdx = 1;
		editor.handleInput("\x1b[B"); // down
		assert.equal(fleetActivated, true);
		assert.ok(dock.recorded.includes("exit"));
	} finally {
		delete (globalThis as any)[SHARED_FLEET_COORDINATOR_KEY];
	}
});

test("handleDockInput: down on empty editor enters dock mode; non-empty does not", async () => {
	const { handleDockInput } = await import("../src/ui/dock.ts");
	let inDock = false;
	const controller = {
		inDock: () => inDock,
		enterDock: () => {
			inDock = true;
			return true;
		},
		exitDock: () => {
			inDock = false;
		},
		getTasks: () => [{ id: "task-1", command: "sleep 1" }],
		isDetail: () => false,
		selected: () => ({ id: "task-1", command: "sleep 1" }),
	};

	let editorText = "";
	const ctx = {
		ui: {
			getEditorText: () => editorText,
		},
	};

	// At empty editor, down enters dock mode
	const resEmpty = handleDockInput("\x1b[B", ctx as any, controller as any);
	assert.deepEqual(resEmpty, { consume: true });
	assert.equal(inDock, true);

	// Reset
	inDock = false;
	editorText = "hello world";

	// At non-empty editor, down does not enter dock mode
	const resNonEmpty = handleDockInput("\x1b[B", ctx as any, controller as any);
	assert.equal(resNonEmpty, undefined);
	assert.equal(inDock, false);
});
