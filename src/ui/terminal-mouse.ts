/**
 * Terminal mouse handling for SGR and legacy mouse wheel reporting.
 */

export const ENABLE_TERMINAL_MOUSE = "\x1b[?1000h\x1b[?1002h\x1b[?1004h\x1b[?1006h";
export const DISABLE_TERMINAL_MOUSE = "\x1b[?1006l\x1b[?1004l\x1b[?1003l\x1b[?1002l\x1b[?1000l";

const SGR_MOUSE_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

export interface ParsedMouseInput {
	/**
	 * Logical lines scrolled: negative scrolls up, positive scrolls down.
	 */
	wheelDelta: number;
	sawMouse: boolean;
	clickRow?: number;
}

export function parseMouseInput(data: string): ParsedMouseInput {
	let wheelDelta = 0;
	let sawMouse = false;
	let clickRow: number | undefined;

	// SGR format: \x1b[<Cb;Cx;Cy(M|m)
	if (data.includes("\x1b[<")) {
		SGR_MOUSE_RE.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = SGR_MOUSE_RE.exec(data)) !== null) {
			sawMouse = true;
			const button = Number(match[1]);
			const y = Number(match[3]);
			const isRelease = match[4] === "m";

			if ((button & 64) !== 0) {
				// Wheel event
				const direction = button & 3;
				if (direction === 0) wheelDelta -= 1; // wheel up
				else if (direction === 1) wheelDelta += 1; // wheel down
			} else if (!isRelease && (button & 3) === 0) {
				// Primary button press
				clickRow = y;
			}
		}
	}

	// Normal / X10 format: \x1b[M` (up) and \x1b[Ma (down)
	if (data.includes("\x1b[M")) {
		sawMouse = true;
		for (let i = 0; i < data.length - 2; i++) {
			if (data[i] === "\x1b" && data[i + 1] === "[" && data[i + 2] === "M") {
				const btn = data.charCodeAt(i + 3);
				if (btn === 96) wheelDelta -= 1;
				else if (btn === 97) wheelDelta += 1;
			}
		}
	}

	return { wheelDelta, sawMouse, clickRow };
}

export interface WritableTerminalHost {
	terminal?: {
		write?(data: string): void;
	};
}

export function enableTerminalMouse(host?: WritableTerminalHost): boolean {
	try {
		if (typeof host?.terminal?.write === "function") {
			host.terminal.write(ENABLE_TERMINAL_MOUSE);
			return true;
		}
	} catch {}
	return false;
}

export function disableTerminalMouse(host?: WritableTerminalHost): void {
	try {
		if (typeof host?.terminal?.write === "function") {
			host.terminal.write(DISABLE_TERMINAL_MOUSE);
		}
	} catch {}
}
