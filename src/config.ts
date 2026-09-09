import { CreateEnvParser, PandoraAccessTokenSchema } from 'pandora-common';
import { BotIdSchema } from 'pandora-common/bots';
import * as z from 'zod';

export const EnvParser = CreateEnvParser({
	CC_BOTS_TOKEN: PandoraAccessTokenSchema,
	CC_BOTS_BOT_ID: BotIdSchema,
	CC_BOTS_SERVER_ADDRESS: z.string(),

	//#region Logging

	/** The directory to store logs into */
	LOG_DIR: z.string().default('./logs'),
	/** If the logging should use "production" preset, reducing verbosity and rotating logs */
	LOG_PRODUCTION: z.boolean().default(false),
	/** A webhook URL to log important events */
	LOG_DISCORD_WEBHOOK_URL: z.string().default(''),

	//#endregion
});

export const ENV = EnvParser();
