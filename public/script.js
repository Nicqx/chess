document.addEventListener('DOMContentLoaded', () => {
  const boardElement = document.getElementById('board');
  const statusElement = document.getElementById('status');
  const promotionModal = document.getElementById('promotion-modal');
  const cancelPromotionBtn = document.getElementById('cancel-promotion');
  const stateModal = document.getElementById('state-modal');
  const stateModalHeader = document.getElementById('state-modal-header');
  const stateModalMessage = document.getElementById('state-modal-message');
  const closeStateModalBtn = document.getElementById('close-state-modal');
  const capturedSelfElement = document.getElementById('captured-self');
  const capturedOpponentElement = document.getElementById('captured-opponent');
  const boardWrapper = document.getElementById('board-wrapper');

  const humanColorSelect = document.getElementById('human-color');
  const aiDifficultySelect = document.getElementById('ai-difficulty');
  const newVsComputerBtn = document.getElementById('new-vs-computer');

  let selectedSquare = null;
  let sessionId = null;
  let currentFen = null;
  let board = [];
  let legalMoves = [];
  let pendingMove = null;
  let playerColor = 'white';
  let isLocal = false;
  let isVsAI = false;
  let aiColor = null;
  let lastMove = null;
  let gameEndedShown = false;
  let pollIntervalId = null;

  function detectBasePath() {
    const parts = window.location.pathname.split('/').filter(Boolean);
    if (parts.length === 0) return '';

    const last = parts[parts.length - 1];
    const baseParts = /^\d{5}$/.test(last) ? parts.slice(0, -1) : parts;

    return baseParts.length ? `/${baseParts.join('/')}` : '';
  }

  const basePath = detectBasePath();

  function apiUrl(path) {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    return `${window.location.origin}${basePath}${normalizedPath}`;
  }

  function buildSessionUrl(id) {
    return `${window.location.origin}${basePath}/${id}`;
  }

  function setBoardOrientation() {
    if (playerColor === 'black') {
      boardElement.classList.add('flipped');
      boardWrapper.classList.add('flipped-labels');
    } else {
      boardElement.classList.remove('flipped');
      boardWrapper.classList.remove('flipped-labels');
    }
  }

  function isHumanTurn() {
    if (!currentFen) return true;
    const turn = currentFen.split(' ')[1];
    return (playerColor === 'white' && turn === 'w') || (playerColor === 'black' && turn === 'b');
  }

  function canControlPiece(pieceElement) {
    if (!pieceElement) return false;
    const pieceColor = getPieceColor(pieceElement);

    if (isVsAI) {
      return pieceColor === playerColor && isHumanTurn();
    }

    if (!isLocal) {
      return pieceColor === playerColor;
    }

    return true;
  }

  function updateCapturedPieces(fen) {
    const initialCounts = {
      white: { P: 8, R: 2, N: 2, B: 2, Q: 1 },
      black: { p: 8, r: 2, n: 2, b: 2, q: 1 }
    };

    const placement = fen.split(' ')[0];
    const currentCounts = {
      white: { P: 0, R: 0, N: 0, B: 0, Q: 0 },
      black: { p: 0, r: 0, n: 0, b: 0, q: 0 }
    };

    for (const char of placement) {
      if (/[PRNBQ]/.test(char)) {
        currentCounts.white[char] = (currentCounts.white[char] || 0) + 1;
      } else if (/[prnbq]/.test(char)) {
        currentCounts.black[char] = (currentCounts.black[char] || 0) + 1;
      }
    }

    const capturedWhite = {};
    const capturedBlack = {};

    for (const piece in initialCounts.white) {
      capturedWhite[piece] = initialCounts.white[piece] - (currentCounts.white[piece] || 0);
    }
    for (const piece in initialCounts.black) {
      capturedBlack[piece] = initialCounts.black[piece] - (currentCounts.black[piece] || 0);
    }

    let myCaptured;
    let opponentCaptured;

    if (playerColor === 'white') {
      myCaptured = capturedBlack;
      opponentCaptured = capturedWhite;
    } else {
      myCaptured = capturedWhite;
      opponentCaptured = capturedBlack;
    }

    function renderCaptured(targetElement, capturedObj) {
      targetElement.innerHTML = '';
      for (const piece in capturedObj) {
        const count = capturedObj[piece];
        for (let i = 0; i < count; i++) {
          const img = document.createElement('img');
          img.src = `images/${piece}.png`;
          img.alt = piece;
          img.style.width = '30px';
          img.style.height = '30px';
          targetElement.appendChild(img);
        }
      }
    }

    renderCaptured(capturedSelfElement, myCaptured);
    renderCaptured(capturedOpponentElement, opponentCaptured);
  }

  function showStateModal(message, header = 'Game Status') {
    stateModalHeader.innerText = header;
    stateModalMessage.innerText = message;
    stateModal.style.display = 'block';
  }

  function hideStateModal() {
    stateModal.style.display = 'none';
  }

  function updateStatus(data) {
    if (!currentFen) return;

    if (data.status && data.status !== 'ongoing') {
      let statusText = '';

      if (data.status === 'checkmate') {
        const currentTurn = currentFen.split(' ')[1];
        statusText = currentTurn === 'w' ? 'Black wins by checkmate' : 'White wins by checkmate';
        if (!gameEndedShown) {
          showStateModal(statusText, 'Checkmate');
          gameEndedShown = true;
        }
        statusElement.innerText = `Session: ${sessionId} (${playerColor}) | Game ended: ${statusText}`;
      } else if (data.status === 'stalemate') {
        statusText = 'Draw (stalemate)';
        if (!gameEndedShown) {
          showStateModal(statusText, 'Stalemate');
          gameEndedShown = true;
        }
        statusElement.innerText = `Session: ${sessionId} (${playerColor}) | Game ended: ${statusText}`;
      } else if (data.status === 'draw') {
        statusText = 'Draw';
        if (!gameEndedShown) {
          showStateModal(statusText, 'Draw');
          gameEndedShown = true;
        }
        statusElement.innerText = `Session: ${sessionId} (${playerColor}) | Game ended: ${statusText}`;
      } else if (data.status === 'check') {
        statusText = 'Check!';
        statusElement.innerText = `Session: ${sessionId} (${playerColor}) | ${statusText}`;
      } else {
        statusText = data.status;
        statusElement.innerText = `Session: ${sessionId} (${playerColor}) | Game ended: ${statusText}`;
      }
    } else if (data.ended && data.winner) {
      const winnerText = data.winner === 'w' ? 'White' : 'Black';
      statusElement.innerText = `Session: ${sessionId} (${playerColor}) | Game ended: ${winnerText} wins`;
    } else {
      const turn = currentFen.split(' ')[1];
      statusElement.innerText = `Session: ${sessionId} (${playerColor}) | Next: ${turn === 'w' ? 'White' : 'Black'}`;
    }
  }

  closeStateModalBtn.addEventListener('click', () => {
    hideStateModal();
  });

  async function bootstrapSessionFromUrl() {
    const pathParts = window.location.pathname.split('/').filter(Boolean);
    if (pathParts.length === 0) return;

    const maybeSessionId = pathParts[pathParts.length - 1];
    if (!/^\d{5}$/.test(maybeSessionId)) return;

    sessionId = maybeSessionId;

    try {
      const [configRes, stateRes] = await Promise.all([
        fetch(apiUrl(`/session/${sessionId}/config`)),
        fetch(apiUrl(`/session/${sessionId}`))
      ]);

      const config = await configRes.json();
      const data = await stateRes.json();

      if (config.mode === 'ai') {
        isLocal = true;
        isVsAI = true;
        playerColor = config.humanColor === 'w' ? 'white' : 'black';
        aiColor = config.aiColor === 'w' ? 'white' : 'black';
      } else {
        const storageKey = `chess_game_${sessionId}_color`;
        const storedColor = localStorage.getItem(storageKey);

        if (storedColor) {
          playerColor = storedColor;
        } else {
          playerColor = 'black';
          localStorage.setItem(storageKey, 'black');
        }

        isLocal = false;
        isVsAI = false;
        aiColor = null;
      }

      setBoardOrientation();

      currentFen = data.fen;
      loadGame(currentFen);
      updateCapturedPieces(currentFen);

      if (data.lastMove) {
        lastMove = data.lastMove;
        highlightLastMove(lastMove);
      }

      updateStatus(data);

      if (!pollIntervalId) {
        pollIntervalId = setInterval(pollGame, 2000);
      }
    } catch (err) {
      console.error(err);
    }
  }

  document.getElementById('new-game').addEventListener('click', () => {
    fetch(apiUrl('/new-session'), { method: 'POST' })
      .then(response => response.json())
      .then(data => {
        sessionId = data.sessionId;
        currentFen = data.fen;
        isLocal = true;
        isVsAI = false;
        aiColor = null;
        playerColor = 'white';

        localStorage.setItem(`chess_game_${sessionId}_color`, 'white');

        setBoardOrientation();
        gameEndedShown = false;

        loadGame(currentFen);
        updateCapturedPieces(currentFen);
        statusElement.innerText = `Session: ${sessionId} (${playerColor})`;
      })
      .catch(console.error);
  });

  document.getElementById('new-session').addEventListener('click', () => {
    fetch(apiUrl('/new-session'), { method: 'POST' })
      .then(response => response.json())
      .then(data => {
        localStorage.setItem(`chess_game_${data.sessionId}_color`, 'white');
        window.location.href = buildSessionUrl(data.sessionId);
      })
      .catch(console.error);
  });

  newVsComputerBtn.addEventListener('click', () => {
    const humanColor = humanColorSelect.value;
    const difficulty = Number(aiDifficultySelect.value);

    fetch(apiUrl('/new-machine-session'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ humanColor, difficulty })
    })
      .then(res => res.json())
      .then(data => {
        localStorage.setItem(
          `chess_game_${data.sessionId}_color`,
          humanColor === 'w' ? 'white' : 'black'
        );
        window.location.href = buildSessionUrl(data.sessionId);
      })
      .catch(console.error);
  });

  function fetchSessionState() {
    if (!sessionId) return;

    fetch(apiUrl(`/session/${sessionId}`))
      .then(res => res.json())
      .then(data => {
        if (data.fen !== currentFen) {
          gameEndedShown = false;
        }

        currentFen = data.fen;
        loadGame(currentFen);
        updateCapturedPieces(currentFen);

        if (data.lastMove) {
          lastMove = data.lastMove;
          highlightLastMove(lastMove);
        }

        updateStatus(data);
      })
      .catch(console.error);
  }

  function pollGame() {
    if (!sessionId) return;

    fetch(apiUrl(`/session/${sessionId}`))
      .then(res => res.json())
      .then(data => {
        if (data.fen !== currentFen) {
          gameEndedShown = false;
          currentFen = data.fen;
          loadGame(currentFen);
          updateCapturedPieces(currentFen);

          if (data.lastMove) {
            lastMove = data.lastMove;
            highlightLastMove(lastMove);
          }
        }

        updateStatus(data);
      })
      .catch(console.error);
  }

  function createBoard() {
    boardElement.innerHTML = '';
    board = [];

    for (let row = 0; row < 8; row++) {
      const rowArray = [];
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
    board.forEach(row => row.forEach(square => {
      square.classList.remove('highlight');
    }));
  }

  function highlightLegalMoves(moves) {
    moves.forEach(move => {
      const target = getSquareElementFromAlgebraic(move.to);
      if (target) {
        target.classList.add('highlight');
      }
    });
  }

  function getAlgebraic(row, col) {
    const files = 'abcdefgh';
    const rank = 8 - row;
    return files[col] + rank;
  }

  function getSquareElementFromAlgebraic(algebraic) {
    const files = 'abcdefgh';
    const file = algebraic[0];
    const rank = parseInt(algebraic[1], 10);
    const col = files.indexOf(file);
    const row = 8 - rank;
    return board[row][col];
  }

  function getPieceColor(pieceElement) {
    const filename = pieceElement.src.split('/').pop();
    const letter = filename.charAt(0);
    return letter === letter.toUpperCase() ? 'white' : 'black';
  }

  function highlightLastMove(move) {
    board.forEach(row => row.forEach(square => square.classList.remove('last-move')));

    const fromSquare = getSquareElementFromAlgebraic(move.from);
    const toSquare = getSquareElementFromAlgebraic(move.to);

    if (fromSquare) fromSquare.classList.add('last-move');
    if (toSquare) toSquare.classList.add('last-move');
  }

  function onSquareClick(row, col) {
    const clickedSquare = board[row][col];
    if (promotionModal.style.display === 'block') return;

    if (currentFen && (isVsAI || !isLocal) && !isHumanTurn()) {
      alert('Not your turn!');
      return;
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
          const destRank = parseInt(toCoord[1], 10);

          if (isPawn && ((src.includes('P.png') && destRank === 8) || (src.includes('p.png') && destRank === 1))) {
            showPromotionModal();
            return;
          }
        }

        sendMove(pendingMove.from, pendingMove.to);
        return;
      }

      if (clickedSquare.querySelector('img.piece')) {
        const piece = clickedSquare.querySelector('img.piece');

        if (!canControlPiece(piece)) {
          alert('Ezzel a bábuval most nem léphetsz.');
          return;
        }

        clearHighlights();
        selectedSquare = clickedSquare;
        clickedSquare.classList.add('highlight');

        const from = getAlgebraic(row, col);
        if (sessionId) {
          fetch(apiUrl(`/session/${sessionId}/legal-moves?from=${from}`))
            .then(res => res.json())
            .then(data => {
              legalMoves = data.moves;
              highlightLegalMoves(legalMoves);
            })
            .catch(console.error);
        }
        return;
      }

      alert('Invalid move!');
      return;
    }

    if (!selectedSquare) {
      if (clickedSquare.querySelector('img.piece')) {
        const piece = clickedSquare.querySelector('img.piece');

        if (!canControlPiece(piece)) {
          alert('Ezzel a bábuval most nem léphetsz.');
          return;
        }

        selectedSquare = clickedSquare;
        clickedSquare.classList.add('highlight');

        const from = getAlgebraic(row, col);
        if (sessionId) {
          fetch(apiUrl(`/session/${sessionId}/legal-moves?from=${from}`))
            .then(res => res.json())
            .then(data => {
              legalMoves = data.moves;
              highlightLegalMoves(legalMoves);
            })
            .catch(console.error);
        }
      }
    }
  }

  function sendMove(from, to, promotion = null) {
    const payload = { from, to };
    if (promotion) payload.promotion = promotion;

    fetch(apiUrl(`/session/${sessionId}/move`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(res => res.json())
      .then(data => {
        if (data.error) {
          alert(data.error);
        } else {
          currentFen = data.fen;
          lastMove = data.aiMove || data.move;

          loadGame(currentFen);

          if (lastMove) {
            highlightLastMove(lastMove);
          }

          gameEndedShown = false;
          updateCapturedPieces(currentFen);
          updateStatus(data);
        }

        clearHighlights();
        selectedSquare = null;
        legalMoves = [];
        pendingMove = null;
      })
      .catch(err => {
        console.error('Error sending move:', err);
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

    fetch(apiUrl(`/session/${sessionId}/undo`), { method: 'POST' })
      .then(res => res.json())
      .then(data => {
        if (data.error) {
          alert(data.error);
        } else {
          currentFen = data.fen;
          loadGame(currentFen);
          updateCapturedPieces(currentFen);
          clearHighlights();
          selectedSquare = null;
          legalMoves = [];
          pendingMove = null;
          gameEndedShown = false;
          updateStatus(data);
        }
      })
      .catch(console.error);
  });

  document.getElementById('resign').addEventListener('click', () => {
    if (!sessionId) return;

    let resignColor = 'w';

    if (isVsAI) {
      resignColor = playerColor === 'white' ? 'w' : 'b';
    } else if (isLocal) {
      resignColor = currentFen && currentFen.split(' ')[1] ? currentFen.split(' ')[1] : 'w';
    } else {
      resignColor = playerColor === 'white' ? 'w' : 'b';
    }

    fetch(apiUrl(`/session/${sessionId}/resign`), {
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

  document.getElementById('remote-newgame').addEventListener('click', () => {
    if (!sessionId) return;

    fetch(apiUrl(`/session/${sessionId}/newgame`), { method: 'POST' })
      .then(res => res.json())
      .then(data => {
        currentFen = data.fen;
        loadGame(currentFen);
        updateCapturedPieces(currentFen);

        if (data.lastMove) {
          lastMove = data.lastMove;
          highlightLastMove(lastMove);
        } else if (data.aiMove) {
          lastMove = data.aiMove;
          highlightLastMove(lastMove);
        }

        gameEndedShown = false;
        updateStatus(data);
      })
      .catch(console.error);
  });

  createBoard();
  bootstrapSessionFromUrl();
});
