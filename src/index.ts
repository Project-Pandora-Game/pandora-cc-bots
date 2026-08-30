import { mkdirSync } from 'fs';
import { GetLogger, LogLevel, SetConsoleOutput } from 'pandora-common';
import { ENV } from './config.ts';
import { SetupSignalHandling } from './lifecycle.ts';
import { AddDiscordLogOutput, AddFileOutput } from './logging.ts';
const { LOG_DIR, LOG_DISCORD_WEBHOOK_URL, LOG_PRODUCTION } = ENV;

{
	const nodeLogger = GetLogger('Node');
	process.on('warning', (warning) => {
		nodeLogger.warning(warning);
	});
}

const logger = GetLogger('init');

Start().catch((error) => {
	logger.fatal('Init failed:', error);
	process.exit(1);
});

/**
 * Starts the application.
 */
async function Start(): Promise<void> {
	SetupSignalHandling();
	await SetupLogging();
	logger.info(`Hello World!`);
}

/**
 * Configures logging for the application.
 */
async function SetupLogging(): Promise<void> {
	SetConsoleOutput(LOG_PRODUCTION ? LogLevel.VERBOSE : LogLevel.DEBUG);
	// Setup logging into file
	if (LOG_DIR) {
		mkdirSync(LOG_DIR, { recursive: true });
		let logPrefix = `cc_bots`;
		// In production mode prefix with PID and time of start
		if (LOG_PRODUCTION) {
			const time = new Date();
			const timestring = `${time.getFullYear() % 100}${(time.getMonth() + 1).toString().padStart(2, '0')}${time.getDate().toString().padStart(2, '0')}_` +
				`${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
			logPrefix += `_${timestring}_${process.pid}`;
		}
		await AddFileOutput(`${LOG_DIR}/${logPrefix}_debug.log`, false, LogLevel.DEBUG);
		await AddFileOutput(`${LOG_DIR}/${logPrefix}_error.log`, true, LogLevel.ALERT);
	}
	// Setup logging to Discord
	if (LOG_DISCORD_WEBHOOK_URL) {
		AddDiscordLogOutput('pandora-cc-bots', LOG_DISCORD_WEBHOOK_URL, LogLevel.ALERT);
	}
}
