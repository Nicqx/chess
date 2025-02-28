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
  let isLocal = false; // alapból remote mód

  // Ha az URL-ben szerepel egy session azonosító, akkor remote mód
  const pathParts = window.location.pathname.split('/').filter(Boolean);
  if (pathParts.length === 1) {
    sessionId = pathParts[0];
    // Remote mód: a localStorage-ben tárolt színt vesszük, ha nincs, a csatlakozó játékos automatikusan feketével indul
    const storageKey = `chess_game_${sessionId}_color`;
    const storedColor = localStorage.getItem(storageKey);
    if (storedColor) {
      playerColor = storedColor;
    } else {
      playerColor = 'black';
      localStorage.setItem(storageKey, 'black');
    }
    // A remote mód esetében a board CSS-ben "flipped" osztályát alkalmazzuk
    if (playerColor === 'black') {
      boardElement.classList.add('flipped');
    } else {
      boardElement.classList.remove('flipped');
    }
    fetchSessionState();
    setInterval(pollGame, 3000);
  }

  // Lokális játék: "Új játék" gombnál állítjuk be
  // (Az ilyen esetben ugyanabban a böngészőben két játékos játszik, ezért nem korlátozunk a saját szín alapján.)
  // Ekkor a session id ugyanúgy jön létre, de isLocal = true, és playerColor mindig fehérnek jelenik meg (display miatt).
  document.getElementById('new-game').addEventListener('click', () => {
    fetch(`${window.location.origin}/new-session`, { method: 'POST' })
      .then(response => response.json())
      .then(data => {
        sessionId = data.sessionId;
        currentFen = data.fen;
        isLocal = true;
        playerColor = 'white';
        // Lokális játék esetén nem alkalmazzuk a flipped osztályt
        boardElement.classList.remove('flipped');
        loadGame(currentFen);
        statusElement.innerText = `Session: ${sessionId} (${playerColor})`;
      })
      .catch(console.error);
  });

  // Remote "Új session" gomb
  document.getElementById('new-session').addEventListener('click', () => {
    fetch(`${window.location.origin}/new-session`, { method: 'POST' })
      .then(response => response.json())
      .then(data => {
        // A session létrehozó mindig fehér; mentsük el ezt
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
        const turn = currentFen.split(' ')[1];
        statusElement.innerText = `Session: ${sessionId} (${playerColor}) | Next: ${turn === 'w' ? 'White' : 'Black'}`;
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
        }
        const turn = currentFen.split(' ')[1];
        statusElement.innerText = `Session: ${sessionId} (${playerColor}) | Next: ${turn === 'w' ? 'White' : 'Black'}`;
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

  function clearHighlights() {
    board.forEach(row => row.forEach(square => square.classList.remove('highlight')));
  }

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

  // A getPieceColor függvény meghatározza a bábu színét a kép neve alapján.
  function getPieceColor(pieceElement) {
    const filename = pieceElement.src.split('/').pop();
    const letter = filename.charAt(0);
    return letter === letter.toUpperCase() ? 'white' : 'black';
  }

  // Négyzet kattintás kezelése
  function onSquareClick(row, col) {
    const clickedSquare = board[row][col];
    if (promotionModal.style.display === 'block') return;

    // Ha lokális játékmódban vagyunk, ne korlátozzuk a saját bábu alapján a kör ellenőrzést.
    if (!isLocal) {
      if (currentFen) {
        const turn = currentFen.split(' ')[1]; // "w" vagy "b"
        if ((playerColor === 'white' && turn !== 'w') || (playerColor === 'black' && turn !== 'b')) {
          alert("Not your turn!");
          return;
        }
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
        if (getPieceColor(piece) !== (isLocal ? getPieceColor(piece) : playerColor)) {
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
          loadGame(currentFen);
          const turn = currentFen.split(' ')[1];
          statusElement.innerText = `Session: ${sessionId} (${playerColor}) | Next: ${turn === 'w' ? 'White' : 'Black'}`;
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

  // "New session" button (remote game)
  document.getElementById('new-session').addEventListener('click', () => {
    fetch(`${window.location.origin}/new-session`, { method: 'POST' })
      .then(response => response.json())
      .then(data => {
        localStorage.setItem(`chess_game_${data.sessionId}_color`, 'white');
        window.location.href = `/${data.sessionId}`;
      })
      .catch(console.error);
  });

  // "New game" button (local game)
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
        loadGame(currentFen);
        statusElement.innerText = `Session: ${sessionId} (${playerColor})`;
      })
      .catch(console.error);
  });

  document.getElementById('undo').addEventListener('click', () => {
    alert('Undo not implemented yet.');
  });

  document.getElementById('resign').addEventListener('click', () => {
    alert('Resign not implemented yet.');
  });

  createBoard();
});
