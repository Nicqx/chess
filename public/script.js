document.addEventListener('DOMContentLoaded', () => {
  const boardElement = document.getElementById('board');
  const statusElement = document.getElementById('status');
  const promotionModal = document.getElementById('promotion-modal');
  const cancelPromotionBtn = document.getElementById('cancel-promotion');
  let selectedSquare = null;
  let sessionId = null;
  let currentFen = null;
  let board = []; // 2D tömb a négyzetek tárolásához
  let legalMoves = [];
  let pendingMove = null; // olyan lépés, amely promóciót igényel
  let playerColor = 'white'; // alapértelmezett: lokális játék esetén fehér
  let isLocal = false; // true: lokális játék
  let lastMove = null; // utolsó lépés tárolása
  let gameEndedShown = false; // biztosítja, hogy a végállapot popup egyszer jelenjen meg

  // updateStatus: Ha a backend a végállapotot jelzi, akkor:
  // - checkmate, stalemate, draw esetén popup alert és "Game ended: ..." üzenet,
  // - check esetén csak "Check!" jelenik meg.
  function updateStatus(data) {
    if (data.status && data.status !== 'ongoing') {
      let statusText = "";
      if (data.status === 'checkmate') {
        const currentTurn = currentFen.split(' ')[1];
        statusText = currentTurn === 'w' ? 'Black wins by checkmate' : 'White wins by checkmate';
        if (!gameEndedShown) {
          alert(`Game ended: ${statusText}`);
          gameEndedShown = true;
        }
        statusElement.innerText = `Session: ${sessionId} (${playerColor}) | Game ended: ${statusText}`;
      } else if (data.status === 'stalemate') {
        statusText = "Draw (stalemate)";
        if (!gameEndedShown) {
          alert(`Game ended: ${statusText}`);
          gameEndedShown = true;
        }
        statusElement.innerText = `Session: ${sessionId} (${playerColor}) | Game ended: ${statusText}`;
      } else if (data.status === 'draw') {
        statusText = "Draw";
        if (!gameEndedShown) {
          alert(`Game ended: ${statusText}`);
          gameEndedShown = true;
        }
        statusElement.innerText = `Session: ${sessionId} (${playerColor}) | Game ended: ${statusText}`;
      } else if (data.status === 'check') {
        // Sakk esetén csak a státusz frissül, nincs popup.
        statusText = "Check!";
        statusElement.innerText = `Session: ${sessionId} (${playerColor}) | ${statusText}`;
      } else {
        statusText = data.status;
        statusElement.innerText = `Session: ${sessionId} (${playerColor}) | Game ended: ${statusText}`;
      }
    } else {
      const turn = currentFen.split(' ')[1];
      statusElement.innerText = `Session: ${sessionId} (${playerColor}) | Next: ${turn === 'w' ? 'White' : 'Black'}`;
    }
  }

  // Remote mód: ha az URL-ben van session id
  const pathParts = window.location.pathname.split('/').filter(Boolean);
  if (pathParts.length === 1) {
    sessionId = pathParts[0];
    const storageKey = `chess_game_${sessionId}_color`;
    const storedColor = localStorage.getItem(storageKey);
    if (storedColor) {
      playerColor = storedColor;
    } else {
      playerColor = 'black';
      localStorage.setItem(storageKey, 'black');
    }
    // Remote mód: a "flipped" osztály gondoskodik arról, hogy a fekete játékos saját bábuit alul lássa
    if (playerColor === 'black') {
      boardElement.classList.add('flipped');
    } else {
      boardElement.classList.remove('flipped');
    }
    fetchSessionState();
    setInterval(pollGame, 3000);
  }

  // Lokális játék: "New game" gombnál (reseteljük a gameEndedShown flag-et)
  document.getElementById('new-game').addEventListener('click', () => {
    fetch(`${window.location.origin}/new-session`, { method: 'POST' })
      .then(response => response.json())
      .then(data => {
        sessionId = data.sessionId;
        currentFen = data.fen;
        isLocal = true;
        playerColor = 'white';
        localStorage.setItem(`chess_game_${sessionId}_color`, 'white');
        boardElement.classList.remove('flipped');
        gameEndedShown = false;
        loadGame(currentFen);
        statusElement.innerText = `Session: ${sessionId} (${playerColor})`;
      })
      .catch(console.error);
  });

  // Remote "New session" gomb
  document.getElementById('new-session').addEventListener('click', () => {
    fetch(`${window.location.origin}/new-session`, { method: 'POST' })
      .then(response => response.json())
      .then(data => {
        localStorage.setItem(`chess_game_${data.sessionId}_color`, 'white');
        window.location.href = `/${data.sessionId}`;
      })
      .catch(console.error);
  });

  function fetchSessionState() {
    if (!sessionId) return;
    fetch(`${window.location.origin}/session/${sessionId}`)
      .then(res => res.json())
      .then(data => {
        currentFen = data.fen;
        loadGame(currentFen);
        if (lastMove) {
          highlightLastMove(lastMove);
        }
        updateStatus(data);
      })
      .catch(console.error);
  }

  function pollGame() {
    if (!sessionId) return;
    fetch(`${window.location.origin}/session/${sessionId}`)
      .then(res => res.json())
      .then(data => {
        if (data.fen !== currentFen) {
          currentFen = data.fen;
          loadGame(currentFen);
          if (lastMove) {
            highlightLastMove(lastMove);
          }
        }
        updateStatus(data);
      })
      .catch(console.error);
  }

  // 8x8-as tábla létrehozása
  function createBoard() {
    boardElement.innerHTML = '';
    board = [];
    for (let row = 0; row < 8; row++) {
      let rowArray = [];
      for (let col = 0; col < 8; col++) {
        const square = document.createElement('div');
        square.classList.add('square');
        square.classList.add((row + col) % 2 === 0 ? 'white' : 'black');
        square.dataset.row = row;
        square.dataset.col = col;
        square.addEventListener('click', () => onSquareClick(row, col));
        boardElement.appendChild(square);
        rowArray.push(square);
      }
      board.push(rowArray);
    }
  }

  // FEN alapján kirajzolja a táblát
  function loadGame(fen) {
    const parts = fen.split(' ');
    const position = parts[0];
    const rows = position.split('/');
    createBoard();
    for (let r = 0; r < 8; r++) {
      let col = 0;
      for (const char of rows[r]) {
        if (isNaN(char)) {
          const square = board[r][col];
          const piece = document.createElement('img');
          piece.src = `images/${char}.png`;
          piece.classList.add('piece');
          square.appendChild(piece);
          col++;
        } else {
          col += parseInt(char, 10);
        }
      }
    }
  }

  // clearHighlights: törli a "highlight" osztályt, de nem érinti a "last-move" osztályt
  function clearHighlights() {
    board.forEach(row => row.forEach(square => square.classList.remove('highlight')));
  }

  // Highlight legal moves (yellow)
  function highlightLegalMoves(fromSquare, moves) {
    moves.forEach(move => {
      const target = getSquareElementFromAlgebraic(move.to);
      target.classList.add('highlight');
    });
  }

  // Konvertálja a (row, col) értékeket algebrai jelöléssé (a-h, 1-8)
  function getAlgebraic(row, col) {
    const files = 'abcdefgh';
    const rank = 8 - row;
    return files[col] + rank;
  }

  // Négyzet keresése algebrai jelöléssel
  function getSquareElementFromAlgebraic(algebraic) {
    const files = 'abcdefgh';
    const file = algebraic[0];
    const rank = parseInt(algebraic[1], 10);
    const col = files.indexOf(file);
    const row = 8 - rank;
    return board[row][col];
  }

  // getPieceColor: meghatározza a bábu színét a kép neve alapján.
  function getPieceColor(pieceElement) {
    const filename = pieceElement.src.split('/').pop();
    const letter = filename.charAt(0);
    return letter === letter.toUpperCase() ? 'white' : 'black';
  }

  // Highlight the last move: módosítjuk úgy, hogy a mezők háttérszínét állítjuk zöld árnyalatra
  function highlightLastMove(move) {
    const fromSquare = getSquareElementFromAlgebraic(move.from);
    const toSquare = getSquareElementFromAlgebraic(move.to);
    if (fromSquare) fromSquare.classList.add('last-move');
    if (toSquare) toSquare.classList.add('last-move');
  }

  // Square click handler
  function onSquareClick(row, col) {
    const clickedSquare = board[row][col];
    if (promotionModal.style.display === 'block') return;

    // Lokális játéknál nem korlátozunk, remote-nál ellenőrizzük a köröket.
    if (!isLocal && currentFen) {
      const turn = currentFen.split(' ')[1];
      if ((playerColor === 'white' && turn !== 'w') || (playerColor === 'black' && turn !== 'b')) {
        alert("Not your turn!");
        return;
      }
    }

    const toCoord = getAlgebraic(row, col);

    if (selectedSquare) {
      const moveCandidate = legalMoves.find(m => m.to === toCoord);
      if (moveCandidate) {
        pendingMove = { from: moveCandidate.from, to: moveCandidate.to };
        const pieceImg = selectedSquare.querySelector('img.piece');
        if (pieceImg) {
          const src = pieceImg.src;
          const isPawn = src.includes('P.png') || src.includes('p.png');
          const destRank = parseInt(toCoord[1]);
          if (isPawn && ((src.includes('P.png') && destRank === 8) || (src.includes('p.png') && destRank === 1))) {
            showPromotionModal();
            return;
          }
        }
        sendMove(pendingMove.from, pendingMove.to);
        return;
      } else if (clickedSquare.querySelector('img.piece')) {
        const piece = clickedSquare.querySelector('img.piece');
        if (!isLocal && getPieceColor(piece) !== playerColor) {
          alert("This is not your piece!");
          return;
        }
        clearHighlights();
        selectedSquare = clickedSquare;
        clickedSquare.classList.add('highlight');
        const from = getAlgebraic(row, col);
        if (sessionId) {
          fetch(`${window.location.origin}/session/${sessionId}/legal-moves?from=${from}`)
            .then(res => res.json())
            .then(data => {
              legalMoves = data.moves;
              highlightLegalMoves(clickedSquare, legalMoves);
            })
            .catch(console.error);
        }
        return;
      } else {
        alert('Invalid move!');
        return;
      }
    }
    if (!selectedSquare) {
      if (clickedSquare.querySelector('img.piece')) {
        const piece = clickedSquare.querySelector('img.piece');
        if (!isLocal && getPieceColor(piece) !== playerColor) {
          alert("This is not your piece!");
          return;
        }
        selectedSquare = clickedSquare;
        clickedSquare.classList.add('highlight');
        const from = getAlgebraic(row, col);
        if (sessionId) {
          fetch(`${window.location.origin}/session/${sessionId}/legal-moves?from=${from}`)
            .then(res => res.json())
            .then(data => {
              legalMoves = data.moves;
              highlightLegalMoves(clickedSquare, legalMoves);
            })
            .catch(console.error);
        }
      }
      return;
    }
  }

  function sendMove(from, to, promotion = null) {
    const payload = { from, to };
    if (promotion) payload.promotion = promotion;
    const url = `${window.location.origin}/session/${sessionId}/move`;
    console.log("Sending move:", payload, "to", url);
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(res => res.json())
      .then(data => {
        console.log("Move response:", data);
        if (data.error) {
          alert(data.error);
        } else {
          currentFen = data.fen;
          lastMove = data.move; // Utolsó lépés elmentése
          loadGame(currentFen);
          highlightLastMove(lastMove);
          // Ha a move response status nem "ongoing", akkor popup
          if (data.status && data.status !== 'ongoing') {
            updateStatus({ status: data.status });
          } else {
            fetchSessionState();
          }
        }
        clearHighlights();
        selectedSquare = null;
        legalMoves = [];
        pendingMove = null;
      })
      .catch(err => {
        console.error("Error sending move:", err);
      });
  }

  function showPromotionModal() {
    promotionModal.style.display = 'block';
  }

  function hidePromotionModal() {
    promotionModal.style.display = 'none';
    pendingMove = null;
    clearHighlights();
    selectedSquare = null;
  }

  document.querySelectorAll('.promotion-options img').forEach(img => {
    img.addEventListener('click', () => {
      const promotionChoice = img.dataset.promotion;
      if (pendingMove) {
        sendMove(pendingMove.from, pendingMove.to, promotionChoice);
        hidePromotionModal();
      }
    });
  });

  cancelPromotionBtn.addEventListener('click', hidePromotionModal);

  document.getElementById('undo').addEventListener('click', () => {
    if (!sessionId) return;
    fetch(`${window.location.origin}/session/${sessionId}/undo`, { method: 'POST' })
      .then(res => res.json())
      .then(data => {
        if (data.error) {
          alert(data.error);
        } else {
          currentFen = data.fen;
          loadGame(currentFen);
          statusElement.innerText = `Session: ${sessionId} (${playerColor}) | Next: ongoing`;
        }
      })
      .catch(console.error);
  });

  document.getElementById('resign').addEventListener('click', () => {
    if (!sessionId) return;
    const resignColor = playerColor === 'white' ? 'w' : 'b';
    fetch(`${window.location.origin}/session/${sessionId}/resign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ color: resignColor })
    })
      .then(res => res.json())
      .then(data => {
        alert(data.message);
        statusElement.innerText = `Game ended: ${data.message}`;
      })
      .catch(console.error);
  });

  // Remote mode: "New game" button resets current session (preserving colors)
  document.getElementById('remote-newgame')?.addEventListener('click', () => {
    if (!sessionId) return;
    fetch(`${window.location.origin}/session/${sessionId}/newgame`, { method: 'POST' })
      .then(res => res.json())
      .then(data => {
        currentFen = data.fen;
        loadGame(currentFen);
        if (lastMove) {
          highlightLastMove(lastMove);
        }
        fetchSessionState();
      })
      .catch(console.error);
  });

  createBoard();
});
