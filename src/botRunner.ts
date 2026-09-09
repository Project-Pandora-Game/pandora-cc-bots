import { PandoraApi } from 'pandora-api/api';
import { GetLogger } from 'pandora-common';
import { ENV } from './config.ts';
import { BotConnection, SimpleBotOrchestrator } from 'pandora-api/bots';
const { CC_BOTS_BOT_ID } = ENV;

export async function RunBots(api: PandoraApi): Promise<void> {
	const tokenInfo = (await api.token.getCurrentTokenInfo()).unwrap();
	const logger = GetLogger('Main');

	logger.info(`Authenticated as account ${tokenInfo.accountId} using token "${tokenInfo.tokenName}" (scopes: ${tokenInfo.tokenScopes.join(', ')})`);

	if (!tokenInfo.tokenScopes.includes('bots:run'))
		throw new Error('Specified token is missing the "bots:run" scope');

	// Setup orchestrator responsible for spawning bot intstances
	const orchestrator = new SimpleBotOrchestrator(api, CC_BOTS_BOT_ID, (bot, space, connectionInfo) => {
		logger.info('Spawning new connection for bot and space', bot, space, connectionInfo);
		const botConnection = new BotConnection(bot, space);

		botConnection.on('connected', () => {
			logger.info('Bot connected to space', bot, space);
		});
		botConnection.on('connectError', (err) => {
			logger.warning('Error connecting', bot, space, err);
		});
		botConnection.on('disconnected', () => {
			logger.info('Bot disconnected from space', bot, space);
		});
		botConnection.on('loaded', (spaceState) => {
			logger.info('Space loaded successfully', bot, space);
			logger.info('Characters: \n' + spaceState.characters.map((it) => `  - ${it.name} (${it.id})`).join('\n'));
			logger.info('Space rooms: \n' + spaceState.globalState.space.rooms.map((it) => `  - ${it.name} (${it.id})`).join('\n'));
		});

		botConnection.updateConnectionInfo(connectionInfo);
		return botConnection;
	}, 'http://localhost:6969/');

	await orchestrator.start();
}
