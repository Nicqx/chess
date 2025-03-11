function onSquareClick(row, col) {
  if (isProcessingMove) return; // Ne enged újabb kattintást, ha már folyamatban van a move
  
  const clickedSquare = board[row][col];
  if (promotionModal.style.display === 'block') return;
  
  if (!isLocal && currentFen) {
    const turn = currentFen.split(' ')[1];
    if ((playerColor === 'white' && turn !== 'w') || (playerColor === 'black' && turn !== 'b')) {
      alert("Not your turn!");
      return;
    }
  }
  
  const toCoord = getAlgebraic(row, col);
  
  // Ha már van kijelölt mező...
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
      // Új kijelölés, ha más bábu
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
  
  // Kijelölés, ha nincs még kijelölt mező
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
  isProcessingMove = true;
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
        // Frissítsük a boardot a válasz alapján
        loadGame(currentFen);
        if (data.move) {
          lastMove = data.move;
          highlightLastMove(lastMove);
        }
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
      isProcessingMove = false;
    })
    .catch(err => {
      console.error("Error sending move:", err);
      isProcessingMove = false;
    });
}
