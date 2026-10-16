import { PandoraApi } from 'pandora-api/api';
import {
	BotCommandRepository,
	BotConnection,
	CreateBotRepositoryCommand,
	SimpleBotOrchestrator,
	type BotSpaceCharacter,
	type BotSpaceState,
	type SimpleBotOrchestratorBotInstance,
} from 'pandora-api/bots';
import { Assert, AssertNever, CommandSelectorNumber, GetLogger, type BotChatMessage, type CharacterId, type ChatMessageChatNPC, type SpaceId } from 'pandora-common';
import type { BotId, BotShardConnectionInfo } from 'pandora-common/bots';
import { ENV } from './config.ts';

const { CC_BOTS_BOT_ID } = ENV;
const logger = GetLogger('IWouldNotMind');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function ShuffleInPlace<T>(arr: T[]): void {
	for (let i = arr.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[arr[i], arr[j]] = [arr[j], arr[i]];
	}
}

/** Collapses all whitespace (including newlines) so user text cannot fake additional lines in bot messages */
function CleanText(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Types & constants
// ---------------------------------------------------------------------------
type GameState =
	| 'game_not_started'
	| 'waiting_on_next_turn'
	| 'waiting_on_statement'
	| 'waiting_on_teases'
	| 'waiting_on_tease_selection'
	| 'waiting_on_reveal';

interface Tease {
	readonly player: BotSpaceCharacter;
	readonly text: string;
}

const BOT_IDENTITY: ChatMessageChatNPC = { id: 'bot', name: 'Game Mistress', labelColor: '#ce4676' };

/** Remaining seconds at which the timer is announced in chat (kept sparse to not be annoying) */
const TIMER_ANNOUNCE_AT: readonly number[] = [60, 30, 10];

const MANUAL = `
I WOULDN'T MIND
a game by Lily, implementation by Claudia & Clare

In memory of Lily, one of the oldest mistresses around, who loves to play games and wants to bring joy to awesome people with her creative game ideas. 'I wouldn't mind' is her masterpiece.

'I wouldn't mind' is a kinky and fun multiplayer game in the spirit of popular party games like truth and dare. It is best played with four to five players, but can be started with three. Games are rather quick and players can join and leave in between turns.

GAME FLOW
The game is played in turns. In each turn, the player at turn announces a statement starting with 'I wouldn't mind...', for example 'I wouldn't mind being tied up a little bit.' or 'I wouldn't mind having my shoes kissed~'. Then every other player prepares a tease of what they would do to that person if their tease is chosen, for instance 'Oh I would tie you so tightly you wouldn't be able to move an inch!' or 'I would kiss your shoes so much you will tire of it, Miss!'

Every tease is submitted secretly to the bot with the !tease command. After all players except the one at turn have submitted one, the bot states all teases openly in the chat without revealing who wrote which.

The player at turn then picks the tease she likes most. The author of the winning tease is revealed and CHOOSES whether she wants to do what she promised or not :3
She can really tie up or kiss shoes or do whatever she said... or she can just say something like 'Haha! Joke's on you, I won't do it~' and that is fair too.

After the tease was fulfilled or denied, anybody can start the next turn with !next. All effects of a tease last for one cycle/round, meaning until it is the teased player's turn again, unless the tease states differently. If a previous tease prevents you from doing or receiving a new tease, the previous one is put out of effect early.

The whole point of the game is to play with the players' expectations and desires, making it a lot of fun for all kinds of people and their various kinks.

GAME END
There is no game end or victory condition. The game continues as long as there are enough players to start a new round. Players can join and leave as they like. Please don't afk in the space or disturb the game! Enjoy, be fair and respect each other and the rules!

GAME COMMANDS
Type an exclamation mark character '!' into the chat (without sending it) to see a list of all bot/game commands popping up. You can use tab-autocomplete as with normal commands.
`.trim();

const WELCOME_MESSAGE =
	`Welcome to 'I wouldn't mind', a kinky and fun multiplayer game. Use !manual to read the rules and !joingame to take part. ` +
	`It is best played with four to five players, but can be started with three.`;

// ---------------------------------------------------------------------------
// Game logic (one instance per space; survives shard disconnects)
// ---------------------------------------------------------------------------
class IwouldnotmindGame {
	/** The commands of this game; handlers are closures created in the constructor */
	public readonly commands: BotCommandRepository;

	/**
	 * Registered players as a turn queue: the front is the next player to be at turn.
	 * The player at turn is moved to the back when their round starts, new players join at the back.
	 */
	private readonly players: BotSpaceCharacter[] = [];
	/** ids of players that still need to submit a tease */
	private readonly teasers = new Set<CharacterId>();
	private activePlayerId: CharacterId | null = null;
	private teases: Tease[] = [];
	private statement = '';
	private gameState: GameState = 'game_not_started';
	private turnTimer = 0;
	/** Timer announcement thresholds that were already announced in the current phase */
	private readonly announced = new Set<number>();

	/** Characters currently present in the space */
	private present = new Map<CharacterId, BotSpaceCharacter>();

	private readonly tickTimer: NodeJS.Timeout;

	/** Set on destroy; stops all further sending and long-running flows */
	private destroyed = false;
	/** Serializes outgoing messages so they arrive in the order they were issued */
	private sendQueue: Promise<void> = Promise.resolve();

	private readonly conn: BotConnection;

	constructor(conn: BotConnection) {
		this.conn = conn;
		this.tickTimer = setInterval(() => {
			try {
				this.tick();
			} catch (err) {
				logger.error('Error in game tick', err);
			}
		}, 1000);
		this.setGameState('game_not_started');

		// Return value convention for all commands:
		//   true  = the command took effect (or there is nothing the user could fix), input is cleared
		//   false = the user should modify the command or retry later, input is kept
		this.commands = new BotCommandRepository()
			.registerCommand({
				key: 'manual',
				description: 'Show the manual of the game',
				handler: CreateBotRepositoryCommand().handler(({ character }): boolean => {
					void this.whisper(character, MANUAL);
					return true;
				}),
			})
			.registerCommand({
				key: 'status',
				description: 'Get information about the running game',
				handler: CreateBotRepositoryCommand().handler(({ character }): boolean => {
					const active = this.getActive();
					// The queue front is the next player; the player at turn is at the back, so skip them if they are the only one
					const next = this.players.find((p) => p.id !== this.activePlayerId) ?? null;
					void this.whisper(character, `This is the current status of the game:\n` +
						`The game has the following registered players:\n` +
						(this.players.map((p) => this.nameOf(p)).join(', ') || 'none') +
						`\nThe player at turn is: ${active ? this.nameOf(active) : 'none'}\n` +
						`The player next turn will be: ${next ? this.nameOf(next) : 'none'}` +
						(this.gameState === 'waiting_on_teases'
							? `\nThe following players still need to submit a tease for ${active ? this.nameOf(active) : 'none'}:\n${this.teaserNames().join(', ')}`
							: ''));
					return true;
				}),
			})
			.registerCommand({
				key: 'joingame',
				description: 'Register as a new player',
				handler: CreateBotRepositoryCommand().handler(({ character }): boolean => {
					if (this.players.some((p) => p.id === character.id)) {
						void this.whisper(character, 'GAME: You are already registered as a player.');
						return true;
					}
					this.players.push(character);
					void this.emote(`GAME: ${this.nameOf(character)} was registered as an active player.`);
					return true;
				}),
			})
			.registerCommand({
				key: 'next',
				description: 'Start a new round after registering (needs 3+ players)',
				handler: CreateBotRepositoryCommand().handler(({ character }): boolean => {
					if (!this.players.some((p) => p.id === character.id)) {
						void this.whisper(character, 'GAME: Please register first by using !joingame.');
						return false;
					}
					if (this.gameState !== 'game_not_started' && this.gameState !== 'waiting_on_next_turn') {
						void this.whisper(character, 'GAME: A round is currently already in progress. You will be part of the next round.');
						return false;
					}

					// Players that went offline are removed right when a round starts
					for (const player of [...this.players]) {
						if (player.data.onlineStatus === 'offline') {
							this.unregisterPlayer(player, ' as they are offline.');
						}
					}

					if (this.players.length < 3) {
						void this.whisper(character, 'GAME: The game needs a minimum of three registered players to start the next round.');
						return false;
					}
					this.setGameState('waiting_on_statement');
					const next = this.determineNextPlayer();
					void this.emote(`GAME: ${this.nameOf(character)} started the next round. It is ${this.nameOf(next)}'s turn to announce an 'I wouldn't mind' statement ` +
						`using !iwouldnotmind [text]. Time limit: 2 minutes.`);
					return true;
				}),
			})
			.registerCommand({
				key: 'iwouldnotmind',
				description: 'When it is your turn: announce your "I wouldn\'t mind" statement',
				usage: '[text]',
				handler: CreateBotRepositoryCommand().handler({ restArgName: 'text' }, ({ character }, _args, rawText): boolean => {
					if (this.activePlayerId !== character.id || this.gameState !== 'waiting_on_statement') {
						void this.whisper(character, 'GAME: It is currently not your turn to announce a statement.');
						return false;
					}
					// Allow people to type the full sentence out of habit
					const text = CleanText(rawText).replace(/^i\s+(wouldn['’]?t|would\s+not)\s+mind\s*/i, '').trim();
					if (!text) {
						void this.whisper(character, 'GAME: Please provide a statement, for example: !iwouldnotmind being tied up a little bit');
						return false;
					}
					this.statement = text;
					this.teasers.clear();
					for (const p of this.players) {
						if (p.id !== character.id) this.teasers.add(p.id);
					}
					void this.emote(`GAME: ${this.nameOf(character)} says: "I wouldn't mind ${text}"`);
					void this.emote(`GAME: The game proceeds when the following players have secretly submitted a tease using !tease [text]: ` +
						`${this.teaserNames().join(', ')}. Time limit: 4 minutes.`);
					this.setGameState('waiting_on_teases');
					return true;
				}),
			})
			.registerCommand({
				key: 'tease',
				description: 'Secretly submit your tease for the current statement',
				usage: '[text]',
				handler: CreateBotRepositoryCommand().handler({ restArgName: 'text' }, ({ character }, _args, rawText): boolean => {
					if (this.gameState !== 'waiting_on_teases' || !this.teasers.has(character.id)) {
						void this.whisper(character, 'GAME: You are currently not expected to submit a tease.');
						return false;
					}
					const text = CleanText(rawText);
					if (!text) {
						void this.whisper(character, 'GAME: Please provide your tease, for example: !tease I would tie you up so tightly you could not move!');
						return false;
					}
					this.teases.push({ player: character, text });
					this.teasers.delete(character.id);
					void this.whisper(character, `GAME: Your tease was received: ${text}`);

					if (this.teasers.size === 0) {
						this.revealTeases();
						return true;
					}
					if (this.teasers.size === 2) {
						this.turnTimer = Math.min(this.turnTimer, Date.now() + 120_000);
					} else if (this.teasers.size === 1) {
						this.turnTimer = Math.min(this.turnTimer, Date.now() + 60_000);
					}
					void this.emote(`GAME: A tease was received. Still waiting for: ${this.teaserNames().join(', ')}.`);
					this.tick();
					return true;
				}),
			})
			.registerCommand({
				key: 'pick',
				description: 'Pick the tease you like most',
				usage: '[number]',
				handler: CreateBotRepositoryCommand()
					// The bounds depend on the number of teases of the current round; the selector enforces them
					.argumentDynamic(
						'choice',
						{ preparse: 'quotedArgTrimmed' },
						() => CommandSelectorNumber({ min: 1, max: Math.max(1, this.teases.length) }),
					)
					.handler(({ character }, { choice }): boolean => {
						if (this.activePlayerId !== character.id || this.gameState !== 'waiting_on_tease_selection') {
							void this.whisper(character, 'GAME: You cannot pick a tease right now.');
							return false;
						}
						const picked = this.teases[choice - 1];
						// special state so the player cannot time out between pick and reveal
						this.setGameState('waiting_on_reveal');

						this.announceWinner(character, picked)
							.catch((err: unknown) => {
								logger.error('Error while announcing the winner', err);
								if (this.gameState === 'waiting_on_reveal') {
									this.setGameState('waiting_on_next_turn');
								}
							}); // No await: Handler returns quickly
						return true;
					}),
			});
	}

	public destroy(): void {
		this.destroyed = true;
		clearInterval(this.tickTimer);
	}

	// ----- sending ---------------------------------------------------------

	private send(message: BotChatMessage): Promise<void> {
		const result = this.sendQueue.then(async () => {
			if (this.destroyed) return;
			try {
				(await this.conn.chatSender.sendMessage(message)).unwrap();
			} catch (err) {
				logger.error('Failed to send message', err);
			}
		});
		// Never rejects, errors are handled inside
		this.sendQueue = result;
		return result;
	}

	/** Public message */
	private emote(message: string): Promise<void> {
		return this.send({ type: 'emote', message, as: BOT_IDENTITY });
	}

	/** Private message to a single player */
	private whisper(to: BotSpaceCharacter, message: string): Promise<void> {
		return this.send({ type: 'ooc', message, as: BOT_IDENTITY, to: [to.id] });
	}

	// ----- space events ----------------------------------------------------

	/**
	 * Replaces the known presence list after (re)loading the space.
	 * - Registered players that are no longer in the space are unregistered.
	 * - Characters that were not known as present before (and are not registered) get the welcome message,
	 *   so on the first load everybody who is already in the space is greeted.
	 */
	public syncPresent(characters: readonly BotSpaceCharacter[]): void {
		const oldPresent = this.present;
		this.present = new Map(characters.map((c) => [c.id, c] as const));

		for (const player of [...this.players]) {
			if (!this.present.has(player.id)) {
				this.unregisterPlayer(player, ' due to leaving the space.');
			}
		}

		for (const c of characters) {
			if (!oldPresent.has(c.id) && !this.players.some((p) => p.id === c.id)) {
				this.greet(c);
			}
		}
	}

	public onCharacterJoined(character: BotSpaceCharacter): void {
		this.present.set(character.id, character);
		if (!this.players.some((p) => p.id === character.id)) {
			this.greet(character);
		}
	}

	public onCharacterLeft(characterId: CharacterId): void {
		const character = this.present.get(characterId);
		this.present.delete(characterId);
		if (character && this.players.some((p) => p.id === characterId)) {
			this.unregisterPlayer(character, ' due to leaving the space.');
		}
	}

	private greet(character: BotSpaceCharacter): void {
		wait(2000)
			.then(async () => {
				// The character may have left (or the game been destroyed) in the meantime
				if (this.destroyed || !this.present.has(character.id)) return;
				await this.whisper(character, WELCOME_MESSAGE);
			})
			.catch((err: unknown) => {
				logger.error('Error sending welcome message:', err);
			});
	}

	// ----- internals -------------------------------------------------------

	private async announceWinner(chooser: BotSpaceCharacter, picked: Tease): Promise<void> {
		await this.emote(`GAME: ${this.nameOf(chooser)} chose:\n${picked.text}`);
		await wait(3000);
		await this.emote('This tease is by...');
		const times = Math.floor(Math.random() * 3) + 2;
		for (let j = 0; j < times; j++) {
			await wait(1000);
			await this.emote('...');
		}
		await wait(1000);
		if (this.destroyed) return;
		await this.emote(`... ${this.nameOf(picked.player)} !!!`);
		this.setGameState('waiting_on_next_turn');
	}

	/** Name for printing into chat; appends the character id if another known character has the same name */
	private nameOf(player: BotSpaceCharacter): string {
		const name = player.name.toLowerCase();
		const sameName = new Set<CharacterId>([player.id]);
		for (const c of [...this.present.values(), ...this.players]) {
			if (c.name.toLowerCase() === name) sameName.add(c.id);
		}
		return sameName.size > 1 ? `${player.name} (${player.id})` : player.name;
	}

	private getActive(): BotSpaceCharacter | null {
		return this.players.find((p) => p.id === this.activePlayerId) ?? null;
	}

	private teaserNames(): string[] {
		return this.players.filter((p) => this.teasers.has(p.id)).map((p) => this.nameOf(p));
	}

	/** Takes the next player from the front of the queue, makes them the player at turn and moves them to the back */
	private determineNextPlayer(): BotSpaceCharacter {
		const next = this.players.shift();
		Assert(next != null, 'No players registered');
		this.players.push(next);
		this.activePlayerId = next.id;
		return next;
	}

	private unregisterPlayer(character: BotSpaceCharacter, message: string): void {
		const index = this.players.findIndex((p) => p.id === character.id);
		if (index >= 0) {
			// Name is computed before the splice, so duplicates among the registered players are still detected
			void this.emote(`GAME: ${this.nameOf(character)} was unregistered as an active player` + message);
			this.players.splice(index, 1);

			if (this.activePlayerId === character.id) {
				this.activePlayerId = null;
				// player at turn left during a round -> the round cannot continue
				const roundRunning = this.gameState !== 'game_not_started' && this.gameState !== 'waiting_on_next_turn';
				if (roundRunning && !this.present.has(character.id)) {
					void this.emote('GAME: As the player at turn has left the space, please start the next round using !next.');
					this.setGameState('waiting_on_next_turn');
				}
			}
			if (this.players.length === 0) this.setGameState('game_not_started');
		}
		this.teasers.delete(character.id);
		// the last person we were waiting on left
		if (this.teasers.size === 0 && this.gameState === 'waiting_on_teases') {
			this.revealTeases();
		}
	}

	private revealTeases(): void {
		if (this.teases.length === 0) {
			void this.emote('GAME: As no tease has been received, please start the next round using !next.');
			this.setGameState('waiting_on_next_turn');
			return;
		}
		const active = this.getActive();
		if (active) {
			ShuffleInPlace(this.teases);
			void this.emote(`GAME: Dear ${this.nameOf(active)}, all teases have been received for "I wouldn't mind ${this.statement}". ` +
				`Please choose one using !pick and the number in front of it (for example !pick 2). Time limit: 2.5 minutes.\n ` +
				this.teases.map((t, i) => `(${i + 1}) - ${t.text}`).join('\n '));
		}
		this.setGameState('waiting_on_tease_selection');
	}

	private announceTimer(): void {
		const remaining = Math.ceil(Math.max(0, this.turnTimer - Date.now()) / 1000);
		const crossed = TIMER_ANNOUNCE_AT.filter((t) => remaining <= t && !this.announced.has(t));
		if (crossed.length === 0) return;
		crossed.forEach((t) => this.announced.add(t));
		const active = this.getActive();
		let waitingFor: string;
		switch (this.gameState) {
			case 'waiting_on_statement':
				waitingFor = `the statement of ${active ? this.nameOf(active) : 'the player at turn'}`;
				break;
			case 'waiting_on_teases':
				waitingFor = `teases from: ${this.teaserNames().join(', ')}`;
				break;
			case 'waiting_on_tease_selection':
				waitingFor = `${active ? this.nameOf(active) : 'the player at turn'} to pick a tease`;
				break;
			default:
				return;
		}
		void this.emote(`GAME: ${remaining}s left, waiting for ${waitingFor}.`);
	}

	private tick(): void {
		if (this.gameState === 'game_not_started' || this.gameState === 'waiting_on_next_turn' || this.gameState === 'waiting_on_reveal') return;

		if (Date.now() < this.turnTimer) {
			this.announceTimer();
			return;
		}

		const active = this.getActive();
		if (this.gameState === 'waiting_on_statement' || this.gameState === 'waiting_on_tease_selection') {
			const what = this.gameState === 'waiting_on_statement' ? 'their turn' : 'selecting a tease';
			this.setGameState('waiting_on_next_turn');
			if (active) {
				this.unregisterPlayer(active, ` due to taking too long for ${what}. Please start the next round using !next.`);
			} else {
				logger.error(`Timed out in ${what} state without active player!`);
			}
		} else if (this.gameState === 'waiting_on_teases') {
			if (this.teases.length > 0) {
				if (this.teasers.size === 0) {
					this.revealTeases();
				} else {
					for (const p of this.players.filter((pl) => this.teasers.has(pl.id))) {
						this.unregisterPlayer(p, ' due to taking too long to submit a tease.');
					}
				}
			} else {
				void this.emote('GAME: No tease has been received within the time limit. Please start the next round using !next.');
				this.setGameState('waiting_on_next_turn');
			}
		}
	}

	private setGameState(state: GameState): void {
		logger.debug(`Change gamestate: ${this.gameState}->${state}`);
		this.gameState = state;
		this.announced.clear();
		switch (state) {
			case 'game_not_started':
				this.activePlayerId = null;
				this.teases = [];
				this.teasers.clear();
				this.statement = '';
				break;
			case 'waiting_on_statement':
				this.turnTimer = Date.now() + 120_000;
				break;
			case 'waiting_on_teases':
				this.turnTimer = Date.now() + 240_000;
				break;
			case 'waiting_on_next_turn':
				this.teases = [];
				this.teasers.clear();
				this.statement = '';
				break;
			case 'waiting_on_tease_selection':
				this.turnTimer = Date.now() + 150_000;
				break;
			case 'waiting_on_reveal':
				break;
			default:
				AssertNever(state);
		}
	}
}

// ---------------------------------------------------------------------------
// Bot instance: wraps the connection and owns the game for the lifetime of the space connection
// ---------------------------------------------------------------------------
class IwouldnotmindBotInstance implements SimpleBotOrchestratorBotInstance {
	private readonly botConnection: BotConnection;
	private readonly game: IwouldnotmindGame;
	/** The space state listeners are currently bound to; a new object (after a reload) needs new listeners */
	private boundState: BotSpaceState | null = null;

	constructor(bot: BotId, space: SpaceId, connectionInfo: BotShardConnectionInfo) {
		this.botConnection = new BotConnection(bot, space);
		this.game = new IwouldnotmindGame(this.botConnection);

		this.botConnection.withCommandRouter(this.game.commands);

		this.botConnection.on('connected', () => logger.info('Bot connected to space', bot, space));
		this.botConnection.on('connectError', (err) => logger.warning('Error connecting', bot, space, err));
		// The game intentionally survives disconnects, it is only destroyed in disconnect()
		this.botConnection.on('disconnected', () => logger.info('Bot disconnected from space', bot, space));
		this.botConnection.on('loaded', (spaceState) => {
			logger.info('Space loaded successfully', bot, space);
			// Runs on every (re)load: resync presence, greet everybody not greeted yet, drop registered players that are gone
			this.game.syncPresent(spaceState.characters);

			if (this.boundState !== spaceState) {
				Assert(this.boundState == null);
				this.boundState = spaceState;
				spaceState.on('characterJoined', (c) => this.game.onCharacterJoined(c));
				spaceState.on('characterLeft', (id) => this.game.onCharacterLeft(id));
			}
		});

		this.botConnection.updateConnectionInfo(connectionInfo);
	}

	public disconnect(): void {
		this.game.destroy();
		this.botConnection.disconnect();
	}

	public updateConnectionInfo(newConnectionInfo: BotShardConnectionInfo): void {
		this.botConnection.updateConnectionInfo(newConnectionInfo);
	}
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
export async function RunBots(api: PandoraApi): Promise<void> {
	const tokenInfo = (await api.token.getCurrentTokenInfo()).unwrap();

	logger.info(`Authenticated as account ${tokenInfo.accountId} using token "${tokenInfo.tokenName}" (scopes: ${tokenInfo.tokenScopes.join(', ')})`);
	if (!tokenInfo.tokenScopes.includes('bots:run'))
		throw new Error('Specified token is missing the "bots:run" scope');

	const orchestrator = new SimpleBotOrchestrator(api, CC_BOTS_BOT_ID, (bot, space, connectionInfo) => {
		logger.info('Spawning new connection for bot and space', bot, space, connectionInfo);
		return new IwouldnotmindBotInstance(bot, space, connectionInfo);
	}, 'http://localhost:6969/');

	await orchestrator.start();
}
