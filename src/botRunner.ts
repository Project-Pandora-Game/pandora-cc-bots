import { PandoraApi } from 'pandora-api/api';
import { BotCommandRepository, BotConnection, CreateBotRepositoryCommand, SimpleBotOrchestrator } from 'pandora-api/bots';
import { CharacterId, CommandSelectorNumber, GetLogger } from 'pandora-common';
import { ENV } from './config.ts';

const { CC_BOTS_BOT_ID } = ENV;
const logger = GetLogger('IWouldNotMind');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function ShuffleArray<T>(arr: T[]): void {
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

interface Player {
	id: CharacterId;
	name: string;
}

interface Tease {
	player: Player;
	text: string;
}

const BOT_IDENTITY = { id: 'bot', name: 'Game Mistress', labelColor: '#ce4676' } as const;

/** Remaining seconds at which the timer is announced in chat (kept sparse to not be annoying) */
const TIMER_ANNOUNCE_AT = [60, 30, 10];

/** Grace period before a character that left the space is unregistered */
const LEAVE_GRACE_MS = 60_000;

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

// ---------------------------------------------------------------------------
// Game logic (one instance per space connection)
// ---------------------------------------------------------------------------
class IwouldnotmindGame {
	private players: Player[] = [];
	/** ids of players that still need to submit a tease */
	private teasers = new Set<CharacterId>();
	private activePlayerId: CharacterId | null = null;
	private teases: Tease[] = [];
	private statement = '';
	private gameState: GameState = 'game_not_started';
	private turnTimer = 0;
	/** Timer announcement thresholds that were already announced in the current phase */
	private announced = new Set<number>();

	/** Characters currently present in the space */
	public present = new Map<CharacterId, Player>();

	private tickTimer: NodeJS.Timeout;
	private leaveTimers = new Map<CharacterId, ReturnType<typeof setTimeout>>();

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
	}

	public destroy(): void {
		this.destroyed = true;
		clearInterval(this.tickTimer);
		this.leaveTimers.forEach((t) => clearTimeout(t));
		this.leaveTimers.clear();
	}

	// ----- sending ---------------------------------------------------------

	private send(message: Parameters<BotConnection['chatSender']['sendMessage']>[0]): Promise<void> {
		const result = this.sendQueue.then(async () => {
			if (this.destroyed) return;
			try {
				(await this.conn.chatSender.sendMessage(message)).unwrap();
			} catch (err) {
				logger.warning('Failed to send message', err);
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
	private whisper(to: Player, message: string): Promise<void> {
		return this.send({ type: 'chat', message, as: BOT_IDENTITY, to: [to.id] });
	}

	// ----- space events ----------------------------------------------------

	public async onCharacterJoined(character: Player): Promise<void> {
		this.present.set(character.id, character);
		const idx = this.players.findIndex((p) => p.id === character.id);
		if (idx >= 0) {
			// returning player: cancel pending unregister
			const t = this.leaveTimers.get(character.id);
			if (t) clearTimeout(t);
			this.leaveTimers.delete(character.id);
			this.players[idx] = character;
		} else {
			await wait(2000);
			// The character may have left (or the game been destroyed) in the meantime
			if (this.destroyed || !this.present.has(character.id)) return;
			void this.whisper(character,
				`Welcome to 'I wouldn't mind', a kinky and fun multiplayer game. Use !manual to read the rules and !joingame to take part. ` +
				`It is best played with four to five players, but can be started with three.`);
		}
	}

	public onCharacterLeft(characterId: CharacterId): void {
		const character = this.present.get(characterId);
		this.present.delete(characterId);
		if (!character || !this.players.some((p) => p.id === characterId)) return;
		// The new API does not tell us whether the leave was intentional, so always apply the grace period
		const old = this.leaveTimers.get(characterId);
		if (old) clearTimeout(old);
		this.leaveTimers.set(characterId, setTimeout(() => {
			this.leaveTimers.delete(characterId);
			try {
				this.unregisterPlayer(character, ' due to leaving the space.');
			} catch (err) {
				logger.error('Error while unregistering a player that left', err);
			}
		}, LEAVE_GRACE_MS));
	}

	// ----- commands --------------------------------------------------------

	public handleManual(sender: Player): void {
		void this.whisper(sender, MANUAL);
	}

	public handleStatus(sender: Player): void {
		const active = this.getActive();
		const next = this.players.length > 1 && active
			? this.players[(this.players.findIndex((p) => p.id === active.id) + 1) % this.players.length]
			: null;
		void this.whisper(sender, `This is the current status of the game:\n` +
			`The game has the following registered players:\n` +
			(this.players.map((p) => this.nameOf(p)).join(', ') || 'none') +
			`\nThe player at turn is: ${active ? this.nameOf(active) : 'none'}\n` +
			`The player next turn will be: ${next ? this.nameOf(next) : 'none'}` +
			(this.gameState === 'waiting_on_teases'
				? `\nThe following players still need to submit a tease for ${active ? this.nameOf(active) : 'none'}:\n${this.teaserNames().join(', ')}`
				: ''));
	}

	public async handleJoingame(sender: Player): Promise<void> {
		if (this.players.some((p) => p.id === sender.id)) {
			void this.whisper(sender, 'GAME: You are already registered as a player.');
			return;
		}
		this.players.push(sender);
		await this.emote(`GAME: ${this.nameOf(sender)} was registered as an active player.`);
	}

	public handleNext(sender: Player): void {
		if (!this.players.some((p) => p.id === sender.id)) {
			void this.whisper(sender, 'GAME: Please register first by using !joingame.');
		} else if (this.gameState === 'game_not_started' || this.gameState === 'waiting_on_next_turn') {
			if (this.players.length < 3) {
				void this.whisper(sender, 'GAME: The game needs a minimum of three registered players to start the next round.');
				return;
			}
			this.setGameState('waiting_on_statement');
			const next = this.determineNextPlayer();
			void this.emote(`GAME: ${this.nameOf(sender)} started the next round. It is ${this.nameOf(next)}'s turn to announce an 'I wouldn't mind' statement ` +
				`using !iwouldnotmind [text]. Time limit: 2 minutes.`);
		} else {
			void this.whisper(sender, 'GAME: A round is currently already in progress. You will be part of the next round.');
		}
	}

	public handleStatement(sender: Player, rawText: string): void {
		if (this.activePlayerId !== sender.id || this.gameState !== 'waiting_on_statement') {
			void this.whisper(sender, 'GAME: It is currently not your turn to announce a statement.');
			return;
		}
		// Allow people to type the full sentence out of habit
		const text = CleanText(rawText).replace(/^i\s+(wouldn['’]?t|would\s+not)\s+mind\s*/i, '').trim();
		if (!text) {
			void this.whisper(sender, 'GAME: Please provide a statement, for example: !iwouldnotmind being tied up a little bit');
			return;
		}
		this.statement = text;
		this.teasers.clear();
		for (const p of this.players) {
			if (p.id !== sender.id) this.teasers.add(p.id);
		}
		void this.emote(`GAME: ${this.nameOf(sender)} says: "I wouldn't mind ${text}"`);
		void this.emote(`GAME: The game proceeds when the following players have secretly submitted a tease using !tease [text]: ` +
			`${this.teaserNames().join(', ')}. Time limit: 4 minutes.`);
		this.setGameState('waiting_on_teases');
	}

	public handleTease(sender: Player, rawText: string): void {
		if (this.gameState !== 'waiting_on_teases' || !this.teasers.has(sender.id)) {
			void this.whisper(sender, 'GAME: You are currently not expected to submit a tease.');
			return;
		}
		const text = CleanText(rawText);
		if (!text) {
			void this.whisper(sender, 'GAME: Please provide your tease, for example: !tease I would tie you up so tightly you could not move!');
			return;
		}
		this.teases.push({ player: sender, text });
		this.teasers.delete(sender.id);
		void this.whisper(sender, `GAME: Your tease was received: ${text}`);

		if (this.teasers.size === 0) {
			this.revealTeases();
			return;
		}
		if (this.teasers.size === 2) {
			this.turnTimer = Math.min(this.turnTimer, Date.now() + 120_000);
		} else if (this.teasers.size === 1) {
			this.turnTimer = Math.min(this.turnTimer, Date.now() + 60_000);
		}
		void this.emote(`GAME: A tease was received. Still waiting for: ${this.teaserNames().join(', ')}.`);
		this.tick();
	}

	public handlePick(choice: number, sender: Player): void {
		if (this.activePlayerId !== sender.id || this.gameState !== 'waiting_on_tease_selection') {
			void this.whisper(sender, 'GAME: You cannot pick a tease right now.');
			return;
		}
		const i = choice - 1;
		if (!(Number.isInteger(i) && i >= 0 && i < this.teases.length)) {
			void this.whisper(sender, 'Invalid number, expected !pick [number] from the numbers in front of one of the teases, for example !pick 2');
			return;
		}
		// special state so the player cannot time out between pick and reveal
		this.setGameState('waiting_on_reveal');
		const picked = this.teases[i];

		this.announceWinner(sender, picked)
			.catch((err) => {
				logger.error('Error while announcing the winner', err);
				if (this.gameState === 'waiting_on_reveal') {
					this.setGameState('waiting_on_next_turn');
				}
			}); // No await: Handler returns quickly
	}

	// ----- internals -------------------------------------------------------

	private async announceWinner(chooser: Player, picked: Tease): Promise<void> {
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
	private nameOf(player: Player): string {
		const name = player.name.toLowerCase();
		const sameName = new Set<CharacterId>([player.id]);
		for (const c of [...this.present.values(), ...this.players]) {
			if (c.name.toLowerCase() === name) sameName.add(c.id);
		}
		return sameName.size > 1 ? `${player.name} [${player.id}]` : player.name;
	}

	private getActive(): Player | null {
		return this.players.find((p) => p.id === this.activePlayerId) ?? null;
	}

	private teaserNames(): string[] {
		return this.players.filter((p) => this.teasers.has(p.id)).map((p) => this.nameOf(p));
	}

	private determineNextPlayer(): Player {
		const idx = this.players.findIndex((p) => p.id === this.activePlayerId);
		const next = this.players[idx < 0 ? 0 : (idx + 1) % this.players.length];
		this.activePlayerId = next.id;
		return next;
	}

	private unregisterPlayer(character: Player, message: string): void {
		const index = this.players.findIndex((p) => p.id === character.id);
		if (index >= 0) {
			// Name is computed before the splice, so duplicates among the registered players are still detected
			void this.emote(`GAME: ${this.nameOf(character)} was unregistered as an active player` + message);
			// player at turn left -> soft reset: step back so the next player is the right one
			if (this.activePlayerId === character.id && this.players.length > 1) {
				this.activePlayerId = this.players[index === 0 ? this.players.length - 1 : index - 1].id;
				if (!this.present.has(character.id)) {
					void this.emote('GAME: As the player at turn has left the space, please start the next round using !next.');
					this.setGameState('waiting_on_next_turn');
				}
			}
			this.players.splice(index, 1);
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
			ShuffleArray(this.teases);
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
		}
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
		const botConnection = new BotConnection(bot, space);
		let game: IwouldnotmindGame | null = null;
		const listeningStates = new WeakSet<object>();

		const toPlayer = (c: { id: CharacterId; name: string; }): Player => ({ id: c.id, name: c.name });

		/** Returns the running game, or logs if there is none yet */
		const requireGame = (): IwouldnotmindGame | null => {
			if (!game) {
				logger.warning('Command received while no game is running');
			}
			return game;
		};

		/** Command without arguments, forwarded to the game together with the sending player */
		const simpleCommand = (run: (g: IwouldnotmindGame, sender: Player) => void | Promise<void>) =>
			CreateBotRepositoryCommand().handler(async ({ character }) => {
				const g = requireGame();
				if (!g) return false;
				await run(g, toPlayer(character));
				return true;
			});

		/** Command taking the rest of the line as free text */
		const textCommand = (run: (g: IwouldnotmindGame, sender: Player, text: string) => void) =>
			CreateBotRepositoryCommand().handler({ restArgName: 'text' }, ({ character }, _args, text) => {
				const g = requireGame();
				if (!g) return false;
				run(g, toPlayer(character), text);
				return true;
			});

		// Built per connection so the handlers can close over this space's game instance
		const commands = new BotCommandRepository()
			.registerCommand({
				key: 'manual',
				description: 'Show the manual of the game',
				handler: simpleCommand((g, sender) => g.handleManual(sender)),
			})
			.registerCommand({
				key: 'status',
				description: 'Get information about the running game',
				handler: simpleCommand((g, sender) => g.handleStatus(sender)),
			})
			.registerCommand({
				key: 'joingame',
				description: 'Register as a new player',
				handler: simpleCommand((g, sender) => g.handleJoingame(sender)),
			})
			.registerCommand({
				key: 'next',
				description: 'Start a new round after registering (needs 3+ players)',
				handler: simpleCommand((g, sender) => g.handleNext(sender)),
			})
			.registerCommand({
				key: 'iwouldnotmind',
				description: 'When it is your turn: announce your statement, e.g. !iwouldnotmind being tied up',
				usage: '[text]',
				handler: textCommand((g, sender, text) => g.handleStatement(sender, text)),
			})
			.registerCommand({
				key: 'tease',
				description: 'Secretly submit your tease for the current statement',
				usage: '[text]',
				handler: textCommand((g, sender, text) => g.handleTease(sender, text)),
			})
			.registerCommand({
				key: 'pick',
				description: 'Pick the tease you like most',
				usage: '[number]',
				handler: CreateBotRepositoryCommand()
					.argument('choice', CommandSelectorNumber({ min: 1, max: 50 }))
					.handler(({ character }, { choice }) => {
						const g = requireGame();
						if (!g) return false;
						g.handlePick(choice, toPlayer(character));
						return true;
					}),
			});

		botConnection.withCommandRouter(commands);

		botConnection.on('connected', () => logger.info('Bot connected to space', bot, space));
		botConnection.on('connectError', (err) => logger.warning('Error connecting', bot, space, err));
		botConnection.on('disconnected', () => {
			logger.info('Bot disconnected from space', bot, space);
			game?.destroy();
			game = null;
		});
		botConnection.on('loaded', (spaceState) => {
			logger.info('Space loaded successfully', bot, space);
			// 'loaded' may fire again after a reconnect: keep the running game, only (re)bind listeners once per state object
			game ??= new IwouldnotmindGame(botConnection);
			const g = game;

			if (!listeningStates.has(spaceState)) {
				listeningStates.add(spaceState);
				g.present.clear();
				for (const c of spaceState.characters) {
					g.present.set(c.id, toPlayer(c));
				}
				spaceState.on('characterJoined', (c) => void g.onCharacterJoined(toPlayer(c)));
				spaceState.on('characterLeft', (id) => g.onCharacterLeft(id));
			}
		});

		botConnection.updateConnectionInfo(connectionInfo);
		return botConnection;
	}, 'http://localhost:6969/');

	await orchestrator.start();
}
