export const DEBUG = /^(1|true|yes|on)$/i;
export const DEBUG_PREFIX = "[pi-rules]";

export function debug(emit: (message: string) => void, msg: string): void {
	if (DEBUG.test(process.env.PI_RULES_DEBUG ?? "")) emit(`${DEBUG_PREFIX} ${msg}`);
}
