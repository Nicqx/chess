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
const redisKeyPrefix = process.env.REDIS_KEY_PREFIX || 'chess:session';
const sessionTimeout = parseInt(process.env.SESSION_TIMEOUT, 10) || 10800;
const stockfishPath = process.env.STOCKFISH_PATH || '/usr/games/stockfish';

function normalizeBasePath(value) {
  if (!value || value === '/') return '';
  const withLeadingSlash = value.startsWith('/') ? value : `/${value}`;
  return withLeadingSlash.replace(/\/+$/, '');
}

const basePath = normalizeBasePath(process.env.BASE_PATH || '/chess');

const redisClient = createClient({ url: redisUrl });

redisClient.on('error', (err) => {
  console.error('Redis client error:', err);
});

redisClient.connect().catch((err) => {
  console.error('Redis connection error:', err);
});

app.use(express.json());

app.get('/livez', (req, res) => {
  res.json({ ok: true });
});

function httpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function sessionKey(sessionId, suffix = '') {
  return suffix
    ? `${redisKeyPrefix}:${sessionId}:${suffix}`
    : `${redisKeyPrefix}:${sessionId}`;
}

function legacySessionKey(sessionId, suffix = '') {
  return suffix
    ? `session:${sessionId}:${suffix}`
    : `session:${sessionId}`;
}

async function getFen(sessionId) {
  return (
    await redisClient.get(sessionKey(sessionId)) ||
    await redisClient.get(legacySessionKey(sessionId))
  );
}

async function getStringKey(sessionId, suffix) {
  return (
    await redisClient.get(sessionKey(sessionId, suffix)) ||
    await redisClient.get(legacySessionKey(sessionId, suffix))
  );
}

async function deleteSessionRuntimeKeys(sessionId) {
  const suffixes = ['history', 'ended', 'winner', 'lastMove', 'ai_lock'];

  const keys = [];
  for (const suffix of suffixes) {
    keys.push(sessionKey(sessionId, suffix));
    keys.push(legacySessionKey(sessionId, suffix));
  }

  if (keys.length > 0) {
    await redisClient.del(keys);
  }
}

async function deleteSessionStatusKeys(sessionId) {
  await redisClient.del([
    sessionKey(sessionId, 'ended'),
    legacySessionKey(sessionId, 'ended'),
    sessionKey(sessionId, 'winner'),
    legacySessionKey(sessionId, 'winner'),
  ]);
}

async function deleteSessionLastMoveKey(sessionId) {
  await redisClient.del([
    sessionKey(sessionId, 'lastMove'),
    legacySessionKey(sessionId, 'lastMove'),
  ]);
}

async function getActiveListKey(sessionId, suffix) {
  const newKey = sessionKey(sessionId, suffix);
  const legacyKey = legacySessionKey(sessionId, suffix);

  const newLength = await redisClient.lLen(newKey);
  if (newLength > 0) return newKey;

  const legacyLength = await redisClient.lLen(legacyKey);
  if (legacyLength > 0) return legacyKey;

  return newKey;
}

async function withSessionLock(sessionId, action) {
  const lockKey = sessionKey(sessionId, 'move_lock');
  const token = `${process.pid}-${Date.now()}-${Math.random()}`;

  const locked = await redisClient.set(lockKey, token, {
    NX: true,
    EX: 10,
  });

  if (!locked) {
    throw httpError(409, 'Session is busy, please retry.');
  }

  try {
    return await action();
  } finally {
    const current = await redisClient.get(lockKey);
    if (current === token) {
      await redisClient.del(lockKey);
    }
  }
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

function safeJsonParse(raw, fallback = null) {
  if (!raw) return fallback;

  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function pushHistory(sessionId, fen) {
  const key = sessionKey(sessionId, 'history');
  await redisClient.lPush(key, fen);
  await redisClient.expire(key, sessionTimeout);
}

async function getSessionConfig(sessionId) {
  const newKey = sessionKey(sessionId, 'config');
  const legacyKey = legacySessionKey(sessionId, 'config');

  let raw = await redisClient.get(newKey);
  if (raw) {
    await redisClient.expire(newKey, sessionTimeout);
    return safeJsonParse(raw, { mode: 'remote' });
  }

  raw = await redisClient.get(legacyKey);
  if (raw) {
    return safeJsonParse(raw, { mode: 'remote' });
  }

  return { mode: 'remote' };
}

async function saveSessionConfig(sessionId, config) {
  await redisClient.set(
    sessionKey(sessionId, 'config'),
    JSON.stringify(config),
    { EX: sessionTimeout }
  );
}

async function buildState(sessionId) {
  const fen = await getFen(sessionId);
  if (!fen) return null;

  const game = new Chess(fen);
  const status = parseGameStatus(game);
  const endedRaw = await getStringKey(sessionId, 'ended');
  const winner = await getStringKey(sessionId, 'winner');
  const lastMoveRaw = await getStringKey(sessionId, 'lastMove');

  return {
    fen,
    status,
    ended: endedRaw === 'true',
    winner,
    lastMove: lastMoveRaw ? safeJsonParse(lastMoveRaw, null) : null,
  };
}

async function createSession(config = { mode: 'remote' }) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const sessionId = randomSessionId();
    const fen = initializeGame();

    const result = await redisClient.set(sessionKey(sessionId), fen, {
      EX: sessionTimeout,
      NX: true,
    });

    if (result === 'OK') {
      await deleteSessionRuntimeKeys(sessionId);
      await saveSessionConfig(sessionId, config);
      return { sessionId, fen };
    }
  }

  throw new Error('Could not allocate unique session id');
}

function uciMoveToObject(bestmove) {
  if (!bestmove || bestmove === '(none)' || bestmove.length < 4) return null;

  return {
    from: bestmove.slice(0, 2),
    to: bestmove.slice(2, 4),
    promotion: bestmove.length > 4 ? bestmove.slice(4, 5) : undefined,
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
        resolved = true;
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
        resolved = true;
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

async function updateGameEndState(sessionId, game, status, winnerOverride = null) {
  if (status === 'checkmate') {
    const winner = winnerOverride || (game.turn() === 'w' ? 'b' : 'w');

    await redisClient.set(sessionKey(sessionId, 'ended'), 'true', {
      EX: sessionTimeout,
    });

    await redisClient.set(sessionKey(sessionId, 'winner'), winner, {
      EX: sessionTimeout,
    });

    return;
  }

  if (status === 'stalemate' || status === 'draw') {
    await redisClient.set(sessionKey(sessionId, 'ended'), 'true', {
      EX: sessionTimeout,
    });

    await redisClient.del([
      sessionKey(sessionId, 'winner'),
      legacySessionKey(sessionId, 'winner'),
    ]);

    return;
  }

  await deleteSessionStatusKeys(sessionId);
}

async function maybeTriggerAiMove(sessionId) {
  const config = await getSessionConfig(sessionId);
  if (config.mode !== 'ai') return null;

  const lockKey = sessionKey(sessionId, 'ai_lock');

  const lock = await redisClient.set(lockKey, '1', {
    NX: true,
    EX: 15,
  });

  if (!lock) return null;

  try {
    const fen = await getFen(sessionId);
    if (!fen) return null;

    const ended = await getStringKey(sessionId, 'ended');
    if (ended === 'true') return null;

    const game = new Chess(fen);
    const status = parseGameStatus(game);

    if (status !== 'ongoing' && status !== 'check') {
      return null;
    }

    if (game.turn() !== config.aiColor) {
      return null;
    }

    const bestmove = await runStockfish(fen, config.difficulty);
    const aiMoveObj = uciMoveToObject(bestmove);

    if (!aiMoveObj) {
      return null;
    }

    await pushHistory(sessionId, fen);

    const move = game.move(aiMoveObj);
    if (!move) {
      throw new Error(`Stockfish returned invalid move: ${bestmove}`);
    }

    const newFen = game.fen();
    const newStatus = parseGameStatus(game);

    await redisClient.set(sessionKey(sessionId), newFen, {
      EX: sessionTimeout,
    });

    await redisClient.set(
      sessionKey(sessionId, 'lastMove'),
      JSON.stringify(move),
      { EX: sessionTimeout }
    );

    await updateGameEndState(sessionId, game, newStatus, config.aiColor);

    return move;
  } finally {
    await redisClient.del(lockKey);
  }
}

async function healthHandler(req, res) {
  try {
    await redisClient.ping();

    res.json({
      ok: true,
      redis: 'ok',
      basePath: basePath || '/',
      redisKeyPrefix,
    });
  } catch (err) {
    console.error('Health check failed:', err);

    res.status(500).json({
      ok: false,
      redis: 'error',
    });
  }
}

app.get('/healthz', healthHandler);

if (basePath) {
  app.use(basePath, express.static(publicDir));
} else {
  app.use(express.static(publicDir));
}

const router = express.Router();

router.get('/healthz', healthHandler);

router.post('/session/:id/undo', async (req, res) => {
  const sessionId = req.params.id;

  try {
    const result = await withSessionLock(sessionId, async () => {
      const historyKey = await getActiveListKey(sessionId, 'history');
      const currentFen = await getFen(sessionId);

      if (!currentFen) {
        throw httpError(404, 'Session not found or expired');
      }

      const config = await getSessionConfig(sessionId);
      const historyLength = await redisClient.lLen(historyKey);

      if (historyLength === 0) {
        throw httpError(400, 'No undo available');
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
        throw httpError(400, 'No undo available');
      }

      await redisClient.set(sessionKey(sessionId), prevFen, {
        EX: sessionTimeout,
      });

      await deleteSessionStatusKeys(sessionId);
      await deleteSessionLastMoveKey(sessionId);

      const state = await buildState(sessionId);

      return {
        ...state,
        message: 'Undo successful',
        stepsUndone: steps,
      };
    });

    res.json(result);
  } catch (err) {
    console.error('Undo error:', err);
    res.status(err.statusCode || 500).json({
      error: err.message || 'Server error',
    });
  }
});

router.post('/session/:id/resign', async (req, res) => {
  const sessionId = req.params.id;

  try {
    const result = await withSessionLock(sessionId, async () => {
      const { color } = req.body;

      if (!color || (color !== 'w' && color !== 'b')) {
        throw httpError(400, 'Invalid color');
      }

      const fen = await getFen(sessionId);
      if (!fen) {
        throw httpError(404, 'Session not found or expired');
      }

      const winner = color === 'w' ? 'b' : 'w';

      await redisClient.set(sessionKey(sessionId, 'ended'), 'true', {
        EX: sessionTimeout,
      });

      await redisClient.set(sessionKey(sessionId, 'winner'), winner, {
        EX: sessionTimeout,
      });

      return {
        message: `Player ${winner === 'w' ? 'White' : 'Black'} wins by resignation`,
      };
    });

    res.json(result);
  } catch (err) {
    console.error('Resign error:', err);
    res.status(err.statusCode || 500).json({
      error: err.message || 'Server error',
    });
  }
});

router.post('/session/:id/newgame', async (req, res) => {
  const sessionId = req.params.id;

  try {
    const result = await withSessionLock(sessionId, async () => {
      const config = await getSessionConfig(sessionId);
      const newFen = initializeGame();

      await redisClient.set(sessionKey(sessionId), newFen, {
        EX: sessionTimeout,
      });

      await deleteSessionRuntimeKeys(sessionId);
      await saveSessionConfig(sessionId, config);

      let aiMove = null;

      if (config.mode === 'ai' && config.aiColor === 'w') {
        aiMove = await maybeTriggerAiMove(sessionId);
      }

      const state = await buildState(sessionId);

      return {
        ...state,
        aiMove,
        message: 'New game started',
      };
    });

    res.json(result);
  } catch (err) {
    console.error('New game error:', err);
    res.status(err.statusCode || 500).json({
      error: err.message || 'Server error',
    });
  }
});

router.post('/new-session', async (req, res) => {
  try {
    const session = await createSession({ mode: 'remote' });
    res.json(session);
  } catch (err) {
    console.error('Error creating remote session:', err);

    res.status(503).json({
      error: 'Could not create session',
    });
  }
});

router.post('/new-machine-session', async (req, res) => {
  try {
    const humanColor = req.body?.humanColor === 'b' ? 'b' : 'w';
    const aiColor = humanColor === 'w' ? 'b' : 'w';
    const difficulty = clampDifficulty(req.body?.difficulty);

    const session = await createSession({
      mode: 'ai',
      humanColor,
      aiColor,
      difficulty,
    });

    const sessionId = session.sessionId;

    let aiMove = null;

    if (aiColor === 'w') {
      aiMove = await withSessionLock(sessionId, async () => {
        return await maybeTriggerAiMove(sessionId);
      });
    }

    const state = await buildState(sessionId);

    res.json({
      sessionId,
      humanColor,
      aiColor,
      difficulty,
      aiMove,
      ...state,
    });
  } catch (err) {
    console.error('Error creating AI session:', err);

    res.status(503).json({
      error: 'Could not create machine session',
    });
  }
});

router.get('/session/:id/config', async (req, res) => {
  try {
    const config = await getSessionConfig(req.params.id);
    res.json(config);
  } catch (err) {
    console.error('Config error:', err);

    res.status(500).json({
      error: 'Server error',
    });
  }
});

router.get('/session/:id', async (req, res) => {
  try {
    const sessionId = req.params.id;
    const state = await buildState(sessionId);

    if (!state) {
      return res.status(404).json({
        error: 'Session not found or expired',
      });
    }

    const config = await getSessionConfig(sessionId);

    res.json({
      ...state,
      config,
    });
  } catch (err) {
    console.error('Session state error:', err);

    res.status(500).json({
      error: 'Server error',
    });
  }
});

router.get('/session/:id/legal-moves', async (req, res) => {
  try {
    const sessionId = req.params.id;
    const { from } = req.query;

    if (!from) {
      return res.status(400).json({
        error: "Missing 'from' query parameter",
      });
    }

    const fen = await getFen(sessionId);

    if (!fen) {
      return res.status(404).json({
        error: 'Session not found or expired',
      });
    }

    const game = new Chess(fen);
    const moves = game.moves({
      square: from,
      verbose: true,
    });

    res.json({ moves });
  } catch (err) {
    console.error('Legal moves error:', err);

    res.status(500).json({
      error: 'Server error',
    });
  }
});

router.post('/session/:id/move', async (req, res) => {
  const sessionId = req.params.id;

  try {
    const result = await withSessionLock(sessionId, async () => {
      const { from, to, promotion } = req.body;

      const fen = await getFen(sessionId);

      if (!fen) {
        throw httpError(404, 'Session not found or expired');
      }

      const ended = await getStringKey(sessionId, 'ended');

      if (ended === 'true') {
        throw httpError(400, 'Game already ended.');
      }

      const config = await getSessionConfig(sessionId);
      const game = new Chess(fen);
      const statusBefore = parseGameStatus(game);

      if (
        statusBefore === 'checkmate' ||
        statusBefore === 'stalemate' ||
        statusBefore === 'draw'
      ) {
        throw httpError(400, 'Game already ended.');
      }

      if (config.mode === 'ai' && game.turn() !== config.humanColor) {
        throw httpError(400, 'It is not the human player turn.');
      }

      const move = game.move({ from, to, promotion });

      if (!move) {
        throw httpError(400, 'Invalid move');
      }

      await pushHistory(sessionId, fen);

      const newFen = game.fen();
      const status = parseGameStatus(game);

      await redisClient.set(sessionKey(sessionId), newFen, {
        EX: sessionTimeout,
      });

      await redisClient.set(
        sessionKey(sessionId, 'lastMove'),
        JSON.stringify(move),
        { EX: sessionTimeout }
      );

      await updateGameEndState(sessionId, game, status);

      let aiMove = null;

      if (
        config.mode === 'ai' &&
        status !== 'checkmate' &&
        status !== 'stalemate' &&
        status !== 'draw'
      ) {
        aiMove = await maybeTriggerAiMove(sessionId);
      }

      const state = await buildState(sessionId);

      return {
        move,
        aiMove,
        ...state,
      };
    });

    res.json(result);
  } catch (err) {
    console.error('Move error:', err);

    res.status(err.statusCode || 500).json({
      error: err.message || 'Server error',
    });
  }
});

router.post('/session/:id/load', async (req, res) => {
  const sessionId = req.params.id;

  try {
    const result = await withSessionLock(sessionId, async () => {
      const { fen } = req.body;

      if (!fen || typeof fen !== 'string') {
        throw httpError(400, 'Missing fen');
      }

      let game;

      try {
        game = new Chess(fen);
      } catch {
        throw httpError(400, 'Invalid FEN');
      }

      const config = await getSessionConfig(sessionId);

      await redisClient.set(sessionKey(sessionId), game.fen(), {
        EX: sessionTimeout,
      });

      await deleteSessionRuntimeKeys(sessionId);
      await saveSessionConfig(sessionId, config);

      let aiMove = null;
      const status = parseGameStatus(game);

      if (
        config.mode === 'ai' &&
        (status === 'ongoing' || status === 'check') &&
        game.turn() === config.aiColor
      ) {
        aiMove = await maybeTriggerAiMove(sessionId);
      }

      const state = await buildState(sessionId);

      return {
        ...state,
        aiMove,
        message: 'Game loaded',
      };
    });

    res.json(result);
  } catch (err) {
    console.error('Load error:', err);

    res.status(err.statusCode || 500).json({
      error: err.message || 'Server error',
    });
  }
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
  console.log(`Chess game server running on port ${port}`);
  console.log(`Base path: ${basePath || '/'}`);
  console.log(`Redis URL: ${redisUrl}`);
  console.log(`Redis key prefix: ${redisKeyPrefix}`);
});
