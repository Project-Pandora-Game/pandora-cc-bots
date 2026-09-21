import { BotCommandRepository, CommandSelectorCharacter, CreateBotRepositoryCommand } from 'pandora-api/bots';
import { CommandSelectorNumber } from 'pandora-common';

export const EXAMPLE_COMMANDS = new BotCommandRepository()
	.registerCommand({
		key: 'greet',
		description: 'Let the bot say hello',
		longDescription: 'When you use this command, the bot will publically greet you. You can optionally specify another character to greet.',
		usage: '[character]',
		handler: CreateBotRepositoryCommand()
			.argumentOptional('target', CommandSelectorCharacter({ allowSelf: 'any' }))
			.handler(async ({ character, connection }, { target }) => {
				const targetCharacter = target ?? character;

				await connection.chatSender.sendMessage({
					type: 'chat',
					message: `Hello ${targetCharacter.name}!`,
					as: {
						id: 'bot',
						name: 'Bot',
						labelColor: '#8000ff',
					},
				});
				return true;
			}),
	})
	.registerCommand({
		key: 'unavailable',
		description: 'This command is not visible to anyone',
		isAvailable(_context) {
			return false;
		},
		handler: CreateBotRepositoryCommand()
			.handler(({ displayError }) => {
				displayError?.(`This can't happen`);
				return false;
			}),
	})
	.registerCommand({
		key: 'complex',
		description: 'This command is very complex',
		isAvailable(_context) {
			return true; // Could have complex condition
		},
		handler: CreateBotRepositoryCommand()
			.fork('action', (ctx) => ({
				poke: {
					description: 'Poke a character a number of times',
					handler: ctx
						.argument('target', CommandSelectorCharacter({ allowSelf: 'otherCharacter' }))
						.argumentOptional('count', CommandSelectorNumber({ min: 1, max: 5 }))
						.handler(async ({ connection }, { target, count = 1 }) => {

							for (let i = 0; i < count; i++) {
								await connection.chatSender.sendMessage({
									type: 'emote',
									message: `${target.name} has been poked`,
									as: {
										id: 'bot',
										name: 'Bot',
										labelColor: '#8000ff',
									},
								});
							}
							return true;
						}),
				},
				double_wave: {
					description: 'Wave to two DIFFERENT characters at the same time',
					handler: ctx
						.argument('c1', CommandSelectorCharacter({ allowSelf: 'any' }))
						.argumentDynamic(
							'c2',
							{ preparse: 'quotedArgTrimmed' },
							(_ctx, { c1 }) => {
								return CommandSelectorCharacter({
									allowSelf: 'any',
									filter({ character }) {
										return character.id !== c1.id;
									},
								});
							})
						.handler(async ({ connection }, { c1, c2 }) => {
							await connection.chatSender.sendMessage({
								type: 'me',
								message: `waves to ${c1.name} and ${c2.name} at the same time`,
								as: {
									id: 'bot',
									name: 'Bot',
									labelColor: '#8000ff',
								},
							});
							return true;
						}),
				},
			})),
	});
