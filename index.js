import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from 'redis';
import { Chess } from 'chess.js';

const app = express();

// ES modulban meghatározzuk az __dirname-t
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const redisUrl = process.env.REDIS_URL || 'redis://redis-service:6379';
const sessionTimeout = parseInt(process.env.SESSION_TIMEOUT) || 10800; // 3 óra

// Redis kliens inicializálása
const redisClient = createClient({ url: redisUrl });
redisClient.connect().catch(console.error);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Új session létrehozása
app.post('/new-session', async (req, res) => {
  const sessionId = Math.floor(10000 + Math.random() * 90000).toString();
  const game = new Chess();
  await redisClient.set(`session:${sessionId}`, game.fen(), { EX: sessionTimeout });
  // Alapértelmezésként a session létrehozó fehér, és flip flag alapértelmezetten false
  await redisClient.set(`session:${sessionId}:flip`, 'false');
  res.json({ sessionId, fen: game.fen() });
});

// Session állapot lekérdezése – visszaadja a FEN‑t és a flip flag‑et
app.get('/session/:id', async (req, res) => {
  const sessionId = req.params.id;
  const fen = await redisClient.get(`session:${sessionId}`);
  if (!fen) return res.status(404).json({ error: 'Session not found or expired' });
  let flip = await redisClient.get(`session:${sessionId}:flip`);
  if (!flip) flip = 'false';
  res.json({ fen, flip });
});

// Lehetséges lépések lekérése egy adott bábuhoz
app.get('/session/:id/legal-moves', async (req, res) => {
  const sessionId = req.params.id;
  const from = req.query.from;
  if (!from) return res.status(400).json({ error: "Missing 'from' query parameter" });
  const fen = await redisClient.get(`session:${sessionId}`);
  if (!fen) return res.status(404).json({ error: 'Session not found or expired' });
  const game = new Chess(fen);
  const moves = game.moves({ square: from, verbose: true });
  res.json({ moves });
});

// Léptetés végrehajtása
app.post('/session/:id/move', async (req, res) => {
  const sessionId = req.params.id;
  const { from, to, promotion } = req.body;
  const fen = await redisClient.get(`session:${sessionId}`);
  console.log("Received move request:", { from, to, promotion, fen });
  if (!fen) return res.status(404).json({ error: 'Session not found or expired' });
  
  const game = new Chess(fen);
  const move = game.move({ from, to, promotion });
  console.log("Processed move:", move);
  if (!move) return res.status(400).json({ error: 'Invalid move: a lépés nem megengedett.' });
  
  const newFen = game.fen();
  await redisClient.set(`session:${sessionId}`, newFen, { EX: sessionTimeout });
  
  let status = 'ongoing';
  try {
    if (typeof game.in_checkmate === 'function' && game.in_checkmate()) {
      status = 'checkmate';
    } else if (typeof game.in_stalemate === 'function' && game.in_stalemate()) {
      status = 'stalemate';
    } else if (typeof game.in_draw === 'function' && game.in_draw()) {
      status = 'draw';
    }
  } catch (err) {
    console.error("Error checking game status:", err);
  }
  
  console.log("New FEN:", newFen);
  res.json({ move, fen: newFen, status });
});

// Flip endpoint – kapcsolja a flip flag értékét
app.post('/session/:id/flip', async (req, res) => {
  const sessionId = req.params.id;
  let flip = await redisClient.get(`session:${sessionId}:flip`);
  flip = flip === 'true' ? 'false' : 'true';
  await redisClient.set(`session:${sessionId}:flip`, flip);
  console.log(`Flip flag for session ${sessionId} is now: ${flip}`);
  res.json({ flip });
});

// Catch-all route a remote session URL-khez (pl. /96863)
app.get('/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const port = process.env.PORT || 8099;
app.listen(port, () => {
  console.log(`Chess game server running on port ${port}`);
});
