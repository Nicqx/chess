import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from 'redis';
import { Chess } from 'chess.js';
import { spawn } from 'child_process';

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, 'public');

const redisUrl = process.env.REDIS_URL || 'redis://redis-service:6379';
const sessionTimeout = parseInt(process.env.SESSION_TIMEOUT, 10) || 10800;
const stockfishPath = process.env.STOCKFISH_PATH || '/usr/games/stockfish';

function normalizeBasePath(value) {
	  if (!value || value === '/') return '';
	  const withLeadingSlash = value.startsWith('/') ? value : `/${value}`;
	  return withLeadingSlash.replace(/\/+$/, '');
}

const basePath = normalizeBasePath(process.env.BASE_PATH || '/chess');

const redisClient = createClient({ url: redisUrl });
redisClient.connect().catch(console.error);

app.use(express.json());

if (basePath) {
	  app.use(basePath, express.static(publicDir));
} else {
	  app.use(express.static(publicDir));
}

function initializeGame() {
	  const game = new Chess();
	  return game.fen();
}

function randomSessionId() {
	  return Math.floor(10000 + Math.random() * 90000).toString();
}

function parseGameStatus(game) {
	  if (game.in_checkmate()) return 'checkmate';
	  if (game.in_stalemate()) return 'stalemate';
	  if (game.in_draw()) return 'draw';
	  if (game.in_check()) return 'check';
	  return 'ongoing';
}

function clampDifficulty(value) {
	  const n = Number(value);
	  if (Number.isNaN(n)) return 5;
	  return Math.max(1, Math.min(10, n));
}

async function pushHistory(sessionId, fen) {
	  const key = `session:${sessionId}:history`;
	  await redisClient.lPush(key, fen);
	  await redisClient.expire(key, sessionTimeout);
}

async function getSessionConfig(sessionId) {
	  const key = `session:${sessionId}:config`;
	  const raw = await redisClient.get(key);
	  if (raw) {
		      await redisClient.expire(key, sessionTimeout);
		      return JSON.parse(raw);
		    }
	  return { mode: 'remote' };
}

async function saveSessionConfig(sessionId, config) {
	  await redisClient.set(
		      `session:${sessionId}:config`,
		      JSON.stringify(config),
		      { EX: sessionTimeout }
		    );
}

async function clearSessionRuntime(sessionId) {
	  await redisClient.del(`session:${sessionId}:history`);
	  await redisClient.del(`session:${sessionId}:ended`);
	  await redisClient.del(`session:${sessionId}:winner`);
	  await redisClient.del(`session:${sessionId}:lastMove`);
	  await redisClient.del(`session:${sessionId}:ai_lock`);
}

async function buildState(sessionId) {
	  const fen = await redisClient.get(`session:${sessionId}`);
	  if (!fen) return null;

	  const game = new Chess(fen);
	  const status = parseGameStatus(game);
	  const endedRaw = await redisClient.get(`session:${sessionId}:ended`);
	  const winner = await redisClient.get(`session:${sessionId}:winner`);
	  const lastMoveRaw = await redisClient.get(`session:${sessionId}:lastMove`);

	  return {
		      fen,
		      status,
		      ended: endedRaw === 'true',
		      winner,
		      lastMove: lastMoveRaw ? JSON.parse(lastMoveRaw) : null
		    };
}

function uciMoveToObject(bestmove) {
	  if (!bestmove || bestmove === '(none)' || bestmove.length < 4) return null;
	  return {
		      from: bestmove.slice(0, 2),
		      to: bestmove.slice(2, 4),
		      promotion: bestmove.length > 4 ? bestmove.slice(4, 5) : undefined
		    };
}

function runStockfish(fen, difficulty = 5) {
	  return new Promise((resolve, reject) => {
		      const engine = spawn(stockfishPath);
		      const safeDifficulty = clampDifficulty(difficulty);
		      const skillLevel = Math.min(20, Math.max(0, (safeDifficulty - 1) * 2));
		      const moveTime = 150 + safeDifficulty * 150;

		      let buffer = '';
		      let gotUciOk = false;
		      let searchStarted = false;
		      let resolved = false;

		      const cleanup = () => {
			            try {
					            engine.stdin.write('quit\n');
					          } catch {}
			            try {
					            engine.kill();
					          } catch {}
			          };

		      const timeout = setTimeout(() => {
			            if (!resolved) {
					            cleanup();
					            reject(new Error('Stockfish timeout'));
					          }
			          }, 15000);

		      engine.on('error', (err) => {
			            clearTimeout(timeout);
			            cleanup();
			            if (!resolved) {
					            resolved = true;
					            reject(err);
					          }
			          });

		      engine.on('close', () => {
			            if (!resolved) {
					            clearTimeout(timeout);
					            reject(new Error('Stockfish closed without returning a move'));
					          }
			          });

		      engine.stdout.on('data', (data) => {
			            buffer += data.toString();
			            const lines = buffer.split('\n');
			            buffer = lines.pop() || '';

			            for (const rawLine of lines) {
					            const line = rawLine.trim();

					            if (line === 'uciok' && !gotUciOk) {
							              gotUciOk = true;
							              engine.stdin.write(`setoption name Skill Level value ${skillLevel}\n`);
							              engine.stdin.write('isready\n');
							              continue;
							            }

					            if (line === 'readyok' && !searchStarted) {
							              searchStarted = true;
							              engine.stdin.write(`position fen ${fen}\n`);
							              engine.stdin.write(`go movetime ${moveTime}\n`);
							              continue;
							            }

					            if (line.startsWith('bestmove ')) {
							              if (!resolved) {
									                  resolved = true;
									                  clearTimeout(timeout);
									                  const bestmove = line.split(/\s+/)[1];
									                  cleanup();
									                  resolve(bestmove);
									                }
							              return;
							            }
					          }
			          });

		      engine.stdin.write('uci\n');
		    });
}

async function maybeTriggerAiMove(sessionId) {
	  const config = await getSessionConfig(sessionId);
	  if (config.mode !== 'ai') return null;

	  const lockKey = `session:${sessionId}:ai_lock`;
	  const lock = await redisClient.set(lockKey, '1', { NX: true, EX: 15 });
	  if (!lock) return null;

	  try {
		      const fen = await redisClient.get(`session:${sessionId}`);
		      if (!fen) return null;

		      const ended = await redisClient.get(`session:${sessionId}:ended`);
		      if (ended === 'true') return null;

		      const game = new Chess(fen);
		      const status = parseGameStatus(game);
		      if (status !== 'ongoing' && status !== 'check') return null;

		      if (game.turn() !== config.aiColor) return null;

		      const bestmove = await runStockfish(fen, config.difficulty);
		      const aiMoveObj = uciMoveToObject(bestmove);
		      if (!aiMoveObj) return null;

		      await pushHistory(sessionId, fen);

		      const move = game.move(aiMoveObj);
		      if (!move) {
			            throw new Error(`Stockfish returned invalid move: ${bestmove}`);
			          }

		      const newFen = game.fen();
		      const newStatus = parseGameStatus(game);

		      await redisClient.set(`session:${sessionId}`, newFen, { EX: sessionTimeout });
		      await redisClient.set(
			            `session:${sessionId}:lastMove`,
			            JSON.stringify(move),
			            { EX: sessionTimeout }
			          );

		      if (newStatus === 'checkmate') {
			            const winner = config.aiColor;
			            await redisClient.set(`session:${sessionId}:ended`, 'true', { EX: sessionTimeout });
			            await redisClient.set(`session:${sessionId}:winner`, winner, { EX: sessionTimeout });
			          } else if (newStatus === 'stalemate' || newStatus === 'draw') {
					        await redisClient.set(`session:${sessionId}:ended`, 'true', { EX: sessionTimeout });
					        await redisClient.del(`session:${sessionId}:winner`);
					      } else {
						            await redisClient.del(`session:${sessionId}:ended`);
						            await redisClient.del(`session:${sessionId}:winner`);
						          }

		      return move;
		    } finally {
			        await redisClient.del(lockKey);
			      }
}

const router = express.Router();

router.post('/session/:id/undo', async (req, res) => {
	  const sessionId = req.params.id;
	  const historyKey = `session:${sessionId}:history`;

	  const currentFen = await redisClient.get(`session:${sessionId}`);
	  if (!currentFen) {
		      return res.status(404).json({ error: 'Session not found or expired' });
		    }

	  const config = await getSessionConfig(sessionId);
	  const historyLength = await redisClient.lLen(historyKey);

	  if (historyLength === 0) {
		      return res.status(400).json({ error: 'No undo available' });
		    }

	  let steps = 1;

	  if (config.mode === 'ai') {
		      const turn = new Chess(currentFen).turn();
		      if (turn === config.humanColor) {
			            steps = Math.min(2, historyLength);
			          }
		    }

	  let prevFen = null;
	  for (let i = 0; i < steps; i++) {
		      const popped = await redisClient.lPop(historyKey);
		      if (!popped) break;
		      prevFen = popped;
		    }

	  if (!prevFen) {
		      return res.status(400).json({ error: 'No undo available' });
		    }

	  await redisClient.set(`session:${sessionId}`, prevFen, { EX: sessionTimeout });
	  await redisClient.del(`session:${sessionId}:ended`);
	  await redisClient.del(`session:${sessionId}:winner`);
	  await redisClient.del(`session:${sessionId}:lastMove`);

	  const state = await buildState(sessionId);
	  res.json({
		      ...state,
		      message: 'Undo successful',
		      stepsUndone: steps
		    });
});

router.post('/session/:id/resign', async (req, res) => {
	  const sessionId = req.params.id;
	  const { color } = req.body;

	  if (!color || (color !== 'w' && color !== 'b')) {
		      return res.status(400).json({ error: 'Invalid color' });
		    }

	  const winner = color === 'w' ? 'b' : 'w';
	  await redisClient.set(`session:${sessionId}:ended`, 'true', { EX: sessionTimeout });
	  await redisClient.set(`session:${sessionId}:winner`, winner, { EX: sessionTimeout });

	  res.json({
		      message: `Player ${winner === 'w' ? 'White' : 'Black'} wins by resignation`
		    });
});

router.post('/session/:id/newgame', async (req, res) => {
	  const sessionId = req.params.id;
	  const config = await getSessionConfig(sessionId);

	  const newFen = initializeGame();
	  await redisClient.set(`session:${sessionId}`, newFen, { EX: sessionTimeout });
	  await clearSessionRuntime(sessionId);
	  await saveSessionConfig(sessionId, config);

	  let aiMove = null;
	  if (config.mode === 'ai' && config.aiColor === 'w') {
		      aiMove = await maybeTriggerAiMove(sessionId);
		    }

	  const state = await buildState(sessionId);
	  res.json({
		      ...state,
		      aiMove,
		      message: 'New game started'
		    });
});

router.post('/new-session', async (req, res) => {
	  const sessionId = randomSessionId();
	  const fen = initializeGame();

	  await redisClient.set(`session:${sessionId}`, fen, { EX: sessionTimeout });
	  await clearSessionRuntime(sessionId);
	  await saveSessionConfig(sessionId, { mode: 'remote' });

	  res.json({ sessionId, fen });
});

router.post('/new-machine-session', async (req, res) => {
	  const humanColor = req.body?.humanColor === 'b' ? 'b' : 'w';
	  const aiColor = humanColor === 'w' ? 'b' : 'w';
	  const difficulty = clampDifficulty(req.body?.difficulty);

	  const sessionId = randomSessionId();
	  const fen = initializeGame();

	  await redisClient.set(`session:${sessionId}`, fen, { EX: sessionTimeout });
	  await clearSessionRuntime(sessionId);
	  await saveSessionConfig(sessionId, {
		      mode: 'ai',
		      humanColor,
		      aiColor,
		      difficulty
		    });

	  let aiMove = null;
	  if (aiColor === 'w') {
		      aiMove = await maybeTriggerAiMove(sessionId);
		    }

	  const state = await buildState(sessionId);
	  res.json({
		      sessionId,
		      humanColor,
		      aiColor,
		      difficulty,
		      aiMove,
		      ...state
		    });
});

router.get('/session/:id/config', async (req, res) => {
	  const config = await getSessionConfig(req.params.id);
	  res.json(config);
});

router.get('/session/:id', async (req, res) => {
	  const sessionId = req.params.id;
	  const state = await buildState(sessionId);

	  if (!state) {
		      return res.status(404).json({ error: 'Session not found or expired' });
		    }

	  const config = await getSessionConfig(sessionId);
	  res.json({ ...state, config });
});

router.get('/session/:id/legal-moves', async (req, res) => {
	  const sessionId = req.params.id;
	  const { from } = req.query;

	  if (!from) {
		      return res.status(400).json({ error: "Missing 'from' query parameter" });
		    }

	  const fen = await redisClient.get(`session:${sessionId}`);
	  if (!fen) {
		      return res.status(404).json({ error: 'Session not found or expired' });
		    }

	  const game = new Chess(fen);
	  const moves = game.moves({ square: from, verbose: true });
	  res.json({ moves });
});

router.post('/session/:id/move', async (req, res) => {
	  const sessionId = req.params.id;
	  const { from, to, promotion } = req.body;

	  const fen = await redisClient.get(`session:${sessionId}`);
	  if (!fen) {
		      return res.status(404).json({ error: 'Session not found or expired' });
		    }

	  const ended = await redisClient.get(`session:${sessionId}:ended`);
	  if (ended === 'true') {
		      return res.status(400).json({ error: 'Game already ended.' });
		    }

	  const config = await getSessionConfig(sessionId);
	  const game = new Chess(fen);
	  const statusBefore = parseGameStatus(game);

	  if (statusBefore === 'checkmate' || statusBefore === 'stalemate' || statusBefore === 'draw') {
		      return res.status(400).json({ error: 'Game already ended.' });
		    }

	  if (config.mode === 'ai' && game.turn() !== config.humanColor) {
		      return res.status(400).json({ error: 'It is not the human player turn.' });
		    }

	  const move = game.move({ from, to, promotion });
	  if (!move) {
		      return res.status(400).json({ error: 'Invalid move' });
		    }

	  await pushHistory(sessionId, fen);

	  const newFen = game.fen();
	  const status = parseGameStatus(game);

	  await redisClient.set(`session:${sessionId}`, newFen, { EX: sessionTimeout });
	  await redisClient.set(
		      `session:${sessionId}:lastMove`,
		      JSON.stringify(move),
		      { EX: sessionTimeout }
		    );

	  if (status === 'checkmate') {
		      const winner = game.turn() === 'w' ? 'b' : 'w';
		      await redisClient.set(`session:${sessionId}:ended`, 'true', { EX: sessionTimeout });
		      await redisClient.set(`session:${sessionId}:winner`, winner, { EX: sessionTimeout });
		    } else if (status === 'stalemate' || status === 'draw') {
			        await redisClient.set(`session:${sessionId}:ended`, 'true', { EX: sessionTimeout });
			        await redisClient.del(`session:${sessionId}:winner`);
			      } else {
				          await redisClient.del(`session:${sessionId}:ended`);
				          await redisClient.del(`session:${sessionId}:winner`);
				        }

	  let aiMove = null;
	  if (config.mode === 'ai' && status !== 'checkmate' && status !== 'stalemate' && status !== 'draw') {
		      aiMove = await maybeTriggerAiMove(sessionId);
		    }

	  const state = await buildState(sessionId);

	  res.json({
		      move,
		      aiMove,
		      ...state
		    });
});

router.post('/session/:id/load', async (req, res) => {
	  const sessionId = req.params.id;
	  const { fen } = req.body;

	  if (!fen || typeof fen !== 'string') {
		      return res.status(400).json({ error: 'Missing fen' });
		    }

	  let game;
	  try {
		      game = new Chess(fen);
		    } catch {
			        return res.status(400).json({ error: 'Invalid FEN' });
			      }

	  const config = await getSessionConfig(sessionId);

	  await redisClient.set(`session:${sessionId}`, game.fen(), { EX: sessionTimeout });
	  await clearSessionRuntime(sessionId);
	  await saveSessionConfig(sessionId, config);

	  let aiMove = null;
	  const status = parseGameStatus(game);
	  if (config.mode === 'ai' && (status === 'ongoing' || status === 'check') && game.turn() === config.aiColor) {
		      aiMove = await maybeTriggerAiMove(sessionId);
		    }

	  const state = await buildState(sessionId);

	  res.json({
		      ...state,
		      aiMove,
		      message: 'Game loaded'
		    });
});

router.get('/', (req, res) => {
	  res.sendFile(path.join(publicDir, 'index.html'));
});

router.get('/:id', (req, res) => {
	  res.sendFile(path.join(publicDir, 'index.html'));
});

if (basePath) {
	  app.use(basePath, router);

	  app.get('/', (req, res) => {
		      res.redirect(`${basePath}/`);
		    });
} else {
	  app.use('/', router);
}

const port = process.env.PORT || 8099;
app.listen(port, () => {
	  console.log(`Chess game server running on port ${port} with base path ${basePath || '/'}`);
});
