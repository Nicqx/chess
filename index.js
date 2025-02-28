import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from 'redis';
import { Chess } from 'chess.js';

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const redisUrl = process.env.REDIS_URL || 'redis://redis-service:6379';
const sessionTimeout = parseInt(process.env.SESSION_TIMEOUT) || 10800;

const redisClient = createClient({ url: redisUrl });
redisClient.connect().catch(console.error);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Helper: initialize a new game and return initial FEN
function initializeGame() {
  const game = new Chess();
  return game.fen();
}

// Push current FEN to history list (for undo)
async function pushHistory(sessionId, fen) {
  await redisClient.lPush(`session:${sessionId}:history`, fen);
}

// Undo endpoint
app.post('/session/:id/undo', async (req, res) => {
  const sessionId = req.params.id;
  const historyKey = `session:${sessionId}:history`;
  const prevFen = await redisClient.lPop(historyKey);
  if (!prevFen) {
    return res.status(400).json({ error: 'No undo available' });
  }
  await redisClient.set(`session:${sessionId}`, prevFen, { EX: sessionTimeout });
  await redisClient.del(`session:${sessionId}:ended`);
  res.json({ fen: prevFen, status: 'ongoing', message: 'Undo successful' });
});

// Resign endpoint
app.post('/session/:id/resign', async (req, res) => {
  const sessionId = req.params.id;
  const { color } = req.body; // expected 'w' or 'b'
  if (!color || (color !== 'w' && color !== 'b')) {
    return res.status(400).json({ error: 'Invalid color' });
  }
  const winner = color === 'w' ? 'b' : 'w';
  await redisClient.set(`session:${sessionId}:ended`, 'true', { EX: sessionTimeout });
  await redisClient.set(`session:${sessionId}:winner`, winner, { EX: sessionTimeout });
  res.json({ message: `Player ${winner === 'w' ? 'White' : 'Black'} wins by resignation` });
});

// New game endpoint (remote): resets game on same session
app.post('/session/:id/newgame', async (req, res) => {
  const sessionId = req.params.id;
  const newFen = initializeGame();
  await redisClient.del(`session:${sessionId}:history`);
  await redisClient.del(`session:${sessionId}:ended`);
  await redisClient.set(`session:${sessionId}`, newFen, { EX: sessionTimeout });
  res.json({ fen: newFen, status: 'ongoing', message: 'New game started' });
});

// New session endpoint
app.post('/new-session', async (req, res) => {
  const sessionId = Math.floor(10000 + Math.random() * 90000).toString();
  const fen = initializeGame();
  await redisClient.set(`session:${sessionId}`, fen, { EX: sessionTimeout });
  await redisClient.del(`session:${sessionId}:history`);
  res.json({ sessionId, fen });
});

// Get session state
app.get('/session/:id', async (req, res) => {
  const sessionId = req.params.id;
  const fen = await redisClient.get(`session:${sessionId}`);
  if (!fen) return res.status(404).json({ error: 'Session not found or expired' });
  const ended = await redisClient.get(`session:${sessionId}:ended`);
  const winner = await redisClient.get(`session:${sessionId}:winner`);
  res.json({ fen, ended: ended || 'false', winner: winner || null });
});

// Get legal moves for a given piece
app.get('/session/:id/legal-moves', async (req, res) => {
  const sessionId = req.params.id;
  const { from } = req.query;
  if (!from) return res.status(400).json({ error: "Missing 'from' query parameter" });
  const fen = await redisClient.get(`session:${sessionId}`);
  if (!fen) return res.status(404).json({ error: 'Session not found or expired' });
  const game = new Chess(fen);
  const moves = game.moves({ square: from, verbose: true });
  res.json({ moves });
});

// Move endpoint
app.post('/session/:id/move', async (req, res) => {
  const sessionId = req.params.id;
  const ended = await redisClient.get(`session:${sessionId}:ended`);
  if (ended === 'true') {
    const winner = await redisClient.get(`session:${sessionId}:winner`);
    return res.status(400).json({ error: `Game ended. Winner is ${winner === 'w' ? 'White' : 'Black'}.` });
  }
  const { from, to, promotion } = req.body;
  const fen = await redisClient.get(`session:${sessionId}`);
  console.log("Received move request:", { from, to, promotion, fen });
  if (!fen) return res.status(404).json({ error: 'Session not found or expired' });
  const game = new Chess(fen);
  await pushHistory(sessionId, fen);
  const move = game.move({ from, to, promotion });
  console.log("Processed move:", move);
  if (!move) return res.status(400).json({ error: 'Invalid move' });
  const newFen = game.fen();
  await redisClient.set(`session:${sessionId}`, newFen, { EX: sessionTimeout });
  let status = 'ongoing';
  if (game.in_checkmate()) status = 'checkmate';
  else if (game.in_stalemate()) status = 'stalemate';
  else if (game.in_draw()) status = 'draw';
  console.log("New FEN:", newFen);
  res.json({ move, fen: newFen, status });
});

// Catch-all: serve index.html for any /<id> request
app.get('/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const port = process.env.PORT || 8099;
app.listen(port, () => {
  console.log(`Chess game server running on port ${port}`);
});
