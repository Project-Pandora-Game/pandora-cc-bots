import { PandoraApi } from 'pandora-api/api';
import { BotConnection, SimpleBotOrchestrator } from 'pandora-api/bots';
import { GetLogger } from 'pandora-common';
import { ENV } from './config.ts';
import { EXAMPLE_COMMANDS } from './exampleCommands.ts';
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
		const botConnection = new BotConnection(bot, space)
			.withCommandRouter(EXAMPLE_COMMANDS);

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

			// Send some messages
			(async () => {
				(await botConnection.chatSender.sendMessage({
					type: 'chat',
					message: 'An example chat message',
					as: {
						id: 'bot',
						name: 'Bot',
						labelColor: '#00FFFF',
					},
				})).unwrap();

				(await botConnection.chatSender.sendMessage({
					type: 'chat',
					message: 'I can whisper too! Even look like I am doing that from another room!',
					as: {
						id: 'bot',
						name: 'Bot',
						labelColor: '#00FFFF',
					},
					room: 'room:xMc_gVJXOg2_dMnNemOiO',
					to: ['c1', 'c4'],
				})).unwrap();

				(await botConnection.chatSender.sendMessage({
					type: 'ooc',
					message: [['normal', 'An example '], ['bold', 'OOC message'], ['italic', ' with formatting']],
					as: {
						id: 'bot',
						name: 'Bot with another name',
						labelColor: '#FF0000',
					},
				})).unwrap();

				// Link
				(await botConnection.chatSender.sendMessage({
					type: 'ooc',
					message: 'https://project-pandora.com/',
					as: {
						id: 'bot',
						name: 'Link Bot',
						labelColor: '#d116c1',
					},
				})).unwrap();

				(await botConnection.chatSender.sendMessage(
					{
						type: 'me',
						message: 'waves',
						as: {
							id: 'bot',
							name: 'Some NPC',
							labelColor: '#FFFFFF',
						},
					},
					{
						type: 'emote',
						message: 'But is nowhere to be seen',
						as: {
							id: 'bot',
							name: 'Some NPC',
							labelColor: '#FFFFFF',
						},
					},
				)).unwrap();

				const id1 = (await botConnection.chatSender.sendMessage(
					{
						type: 'ooc',
						message: 'This message will be edited',
						as: {
							id: 'bot',
							name: 'Bot',
							labelColor: '#FFFFFF',
						},
					},
				)).unwrap();

				await new Promise((resolve) => setTimeout(resolve, 10_000));

				const id2 = (await botConnection.chatSender.editMessage(id1,
					{
						type: 'ooc',
						message: 'This message was edited and will be deleted',
						as: {
							id: 'bot',
							name: 'Bot',
							labelColor: '#FFFFFF',
						},
					},
				)).unwrap();

				await new Promise((resolve) => setTimeout(resolve, 10_000));

				(await botConnection.chatSender.deleteMessage(id2)).unwrap();
			})()
				.catch((err) => logger.fatal('Error', err));
		});

		botConnection.updateConnectionInfo(connectionInfo);
		return botConnection;
	}, 'http://localhost:6969/');

	await orchestrator.start();
}
