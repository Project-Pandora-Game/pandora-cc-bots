import { GetLogger, logConfig } from 'pandora-common';
import wtfnode from 'wtfnode';

const logger = GetLogger('Lifecycle');

{
	const wtfNodeLogger = GetLogger('wtfnode');
	wtfnode.setLogger('info', (...message) => wtfNodeLogger.info(...message));
	wtfnode.setLogger('warn', (...message) => wtfNodeLogger.warning(...message));
	wtfnode.setLogger('error', (...message) => wtfNodeLogger.error(...message));
}

let destroying: string | undefined;
let stopping: Promise<void> | undefined;
const STOP_TIMEOUT = 15_000;

export function IsStopping(): boolean {
	return stopping !== undefined;
}

async function StopGracefully(): Promise<void> {
	// Stop listening for IPC
	process.off('message', IPCMessageListener);
	await Promise.resolve();
	destroying = '[done]';
}

export function Stop(): void {
	if (stopping !== undefined)
		return;

	logger.alert('Stopping...');
	setTimeout(() => {
		logger.fatal(`Stop timed out! Destroying ${destroying ?? 'unknown service'}!`);
		// Dump what is running
		wtfnode.dump();
		// Force exit the process
		process.exit();
	}, STOP_TIMEOUT).unref();
	// Graceful stop
	StopGracefully()
		.catch((err) => {
			logger.fatal(`Stop errored at ${destroying}:\n`, err);
			// Force exit the process
			process.exit();
		});
}

function IPCMessageListener(message: unknown) {
	if (message === 'STOP') {
		logger.info('Received STOP message');
		Stop();
	}
}

export function SetupSignalHandling(): void {
	process.on('SIGINT', () => {
		logger.info('Received SIGINT');
		Stop();
	});

	process.on('SIGTERM', () => {
		logger.info('Received SIGTERM');
		Stop();
	});

	process.on('message', IPCMessageListener);

	process.on('exit', () => {
		logger.alert('Stopped.');
	});

	logConfig.onFatal.push(() => {
		logger.info('Fatal error detected, stopping');
		process.exitCode = 2;
		Stop();
	});
}
