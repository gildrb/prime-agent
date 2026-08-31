type CrashHandlerTarget = Pick<NodeJS.Process, "on" | "off" | "exit">;

function describeCrash(reason: unknown): string {
	if (!(reason instanceof Error)) {
		return String(reason);
	}
	const description = reason.stack ?? reason.message;
	const code = (reason as NodeJS.ErrnoException).code;
	return code
		? `${description}
code: ${code}`
		: description;
}

/**
 * Daemon processes run detached with no terminal, so a crash thrown outside a
 * command handler would vanish with the ignored stdio. Capture the stack in the
 * daemon log first, then exit the way node would have. Returns the uninstaller.
 */
export function installDaemonCrashHandlers(
	log: (message: string) => void,
	target: CrashHandlerTarget = process,
): () => void {
	const onUncaughtException = (error: unknown) => {
		log(`uncaught exception: ${describeCrash(error)}`);
		target.exit(1);
	};
	const onUnhandledRejection = (reason: unknown) => {
		log(`unhandled rejection: ${describeCrash(reason)}`);
		target.exit(1);
	};
	target.on("uncaughtException", onUncaughtException);
	target.on("unhandledRejection", onUnhandledRejection);
	return () => {
		target.off("uncaughtException", onUncaughtException);
		target.off("unhandledRejection", onUnhandledRejection);
	};
}
