// import React, { useEffect, useMemo, useRef, useState } from "react";

// Single‑file Go game (Chinese/area scoring, simple-ko).  
// Features: 9x9 / 11x11 / 19x19, human vs AI (levels 1–5), choose color, pass, undo, live score.
// Tailwind for styling; no external deps. Designed for clarity and reasonably strong lightweight AI.

// --- Types & Utilities --------------------------------------------------------
const EMPTY = 0, BLACK = 1, WHITE = 2;
const OTHER = (c) => (c === BLACK ? WHITE : BLACK);

function makeBoard(size) {
  return Array.from({ length: size }, () => Array(size).fill(EMPTY));
}

function cloneBoard(board) {
  return board.map((row) => row.slice());
}

function boardKey(board) {
  // Serialize for simple-ko (only compare to last position)
  return board.map((r) => r.join("")) .join("|");
}

function inBounds(size, r, c) {
  return r >= 0 && r < size && c >= 0 && c < size;
}

function neighbors(size, r, c) {
  return [
    [r - 1, c],
    [r + 1, c],
    [r, c - 1],
    [r, c + 1],
  ].filter(([rr, cc]) => inBounds(size, rr, cc));
}

function floodGroup(board, r, c) {
  const size = board.length;
  const color = board[r][c];
  const stack = [[r, c]];
  const stones = new Set();
  const libs = new Set();
  const key = (rr, cc) => rr + "," + cc;
  while (stack.length) {
    const [rr, cc] = stack.pop();
    const k = key(rr, cc);
    if (stones.has(k)) continue;
    stones.add(k);
    for (const [ar, ac] of neighbors(size, rr, cc)) {
      const v = board[ar][ac];
      if (v === EMPTY) libs.add(key(ar, ac));
      else if (v === color && !stones.has(key(ar, ac))) stack.push([ar, ac]);
    }
  }
  return {
    color,
    stones: Array.from(stones).map((s) => s.split(",").map(Number)),
    liberties: Array.from(libs).map((s) => s.split(",").map(Number)),
  };
}

function placeAndCapture(board, r, c, color) {
  // Returns { board: newBoard, captured: number } or null if illegal (suicide/ko).
  const size = board.length;
  if (board[r][c] !== EMPTY) return null;
  const newB = cloneBoard(board);
  newB[r][c] = color;

  // Capture opponent groups with no liberties
  let captured = 0;
  const opp = OTHER(color);
  const seen = new Set();
  for (const [nr, nc] of neighbors(size, r, c)) {
    if (newB[nr][nc] === opp) {
      const keyN = nr + "," + nc;
      if (seen.has(keyN)) continue;
      seen.add(keyN);
      const grp = floodGroup(newB, nr, nc);
      if (grp.liberties.length === 0) {
        for (const [sr, sc] of grp.stones) {
          newB[sr][sc] = EMPTY;
          captured++;
        }
      }
    }
  }
  // Check self-capture (suicide)
  const self = floodGroup(newB, r, c);
  if (self.liberties.length === 0) return null;
  return { board: newB, captured };
}

function legalMoves(board, color, koKeyLast = null) {
  const size = board.length;
  const list = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (board[r][c] !== EMPTY) continue;
      const res = placeAndCapture(board, r, c, color);
      if (!res) continue; // illegal by suicide
      // simple-ko: disallow if equals previous board position key
      const k = boardKey(res.board);
      if (koKeyLast && k === koKeyLast) continue;
      list.push({ r, c, res });
    }
  }
  // always include PASS as a legal action
  list.push({ r: -1, c: -1, res: { board: cloneBoard(board), captured: 0 }, pass: true });
  return list;
}

function chineseScore(board) {
  // Area scoring: stones on board + surrounded empty points
  const size = board.length;
  let black = 0, white = 0;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (board[r][c] === BLACK) black++;
      else if (board[r][c] === WHITE) white++;
    }
  }
  // Territory: BFS over empty regions
  const seen = Array.from({ length: size }, () => Array(size).fill(false));
  const q = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (board[r][c] !== EMPTY || seen[r][c]) continue;
      let owner = 0; // 0 = dame/mixed, 1 = black, 2 = white
      let count = 0;
      q.push([r, c]);
      seen[r][c] = true;
      const border = new Set();
      while (q.length) {
        const [rr, cc] = q.pop();
        count++;
        for (const [ar, ac] of neighbors(size, rr, cc)) {
          const v = board[ar][ac];
          if (v === EMPTY && !seen[ar][ac]) {
            seen[ar][ac] = true;
            q.push([ar, ac]);
          } else if (v !== EMPTY) border.add(v);
        }
      }
      if (border.size === 1) owner = border.has(BLACK) ? BLACK : WHITE;
      if (owner === BLACK) black += count; else if (owner === WHITE) white += count;
    }
  }
  return { black, white };
}

function heuristic(board, move, color) {
  // Fast eval: captures, atari, center influence, connect
  if (move.pass) return -0.2; // discourage pass in the midgame
  const size = board.length;
  const center = (size - 1) / 2;
  const { r, c } = move;
  const dCenter = Math.hypot(r - center, c - center);
  let score = 0;
  // Prefer captures
  score += (move.res.captured || 0) * 5;
  // Prefer adding liberties to own adjacent groups
  for (const [nr, nc] of neighbors(size, r, c)) {
    if (board[nr][nc] === color) {
      const grp = floodGroup(board, nr, nc);
      score += Math.max(0, 3 - grp.liberties.length); // help weak groups
    }
  }
  // Avoid moves that create immediate atari for placed stone
  const self = floodGroup(move.res.board, r, c);
  if (self.liberties.length === 1) score -= 3;
  // Center / influence bias
  score += (size / 2 - dCenter) * 0.2;
  return score;
}

// Random playout policy (very light) ------------------------------------------------
function randomPlayoutWinner(startBoard, colorToPlay, plies = 120) {
  // Returns BLACK/WHITE winner by simple area at cutoff.
  let board = cloneBoard(startBoard);
  let koKeyLast = null;
  let lastPass = false;
  let turn = colorToPlay;
  for (let t = 0; t < plies; t++) {
    const moves = legalMoves(board, turn, koKeyLast);
    // Bias: prefer captures or higher heuristic
    const scored = moves.map((m) => ({ m, s: heuristic(board, m, turn) + Math.random() * 0.3 }));
    scored.sort((a, b) => b.s - a.s);
    // Sample top K
    const K = Math.min(10, scored.length);
    const pick = scored[Math.floor(Math.random() * K)].m;

    const next = pick.res.board;
    const newKey = boardKey(next);
    lastPass = !!pick.pass;
    board = next;
    koKeyLast = newKey; // simple-ko against immediate repetition
    turn = OTHER(turn);
    if (lastPass) {
      // if two passes in a row, end early
      const replyMoves = legalMoves(board, turn, koKeyLast);
      const replyIsPass = replyMoves.length && replyMoves[replyMoves.length - 1].pass && replyMoves.length === 1;
      if (replyIsPass) break;
    }
  }
  const { black, white } = chineseScore(board);
  return black > white ? BLACK : WHITE;
}

// AI move selection ------------------------------------------------------------
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function chooseAIMoveAsync(board, color, level, koKeyLast, onProgress, cancelRef, blitz = false) {
  const moves = legalMoves(board, color, koKeyLast);
  if (moves.length === 1 && moves[0].pass) { onProgress?.(100); return moves[0]; }

  const sz = board.length;
  // Much smaller candidate set on small boards/low levels
  const candidateLimit = sz <= 9 ? 18 : (sz === 11 ? 28 : (level <= 2 ? 22 : 45));

  // Candidate pruning: include all capture moves + top-N others by heuristic
  const captures = moves.filter((m) => (m.res.captured || 0) > 0);
  const noncaps = moves.filter((m) => (m.res.captured || 0) === 0)
    .sort((a, b) => heuristic(board, b, color) - heuristic(board, a, color))
    .slice(0, Math.max(0, candidateLimit - captures.length));

  const candidates = [...captures, ...noncaps];
  if (candidates.length === 0) candidates.push(...moves);

  // Level → playout budget (reduced) and plies per playout by board size
  const playoutsTable = [0, 6, 20, 60, 120]; // index: level-1 (L1 uses heuristic-only below)
  const plies9 =      [0, 30, 60, 100, 140];
  const plies11 =     [0, 40, 80, 120, 160];
  const plies19 =     [0, 50, 100, 140, 180];
  const L = Math.max(1, Math.min(5, level));
  const playouts = playoutsTable[L-1];
  const plies = (sz <= 9 ? plies9 : (sz === 11 ? plies11 : plies19))[L-1];

  // Time budget for responsiveness on low levels
  const start = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  const timeBudgetMs = blitz ? 150 : ((L <= 2) ? (sz <= 9 ? 300 : 500) : Infinity);

  // Fast path for Level 1: best heuristic
  if (L === 1) {
    let best = candidates[0], bestS = -1e9;
    for (const m of candidates) {
      if (cancelRef?.current) return null;
      const s = heuristic(board, m, color);
      if (s > bestS) { best = m; bestS = s; }
    }
    onProgress?.(100);
    return best;
  }

  // Monte Carlo selection with cooperative yielding, progress, and time cap
  let best = candidates[0];
  let bestScore = -Infinity;
  const totalWork = Math.max(1, candidates.length * Math.max(1, playouts));
  let done = 0;

  for (let ci = 0; ci < candidates.length; ci++) {
    if (cancelRef?.current) return null;
    const m = candidates[ci];
    let wins = 0;
    const nextBoard = m.res.board;

    for (let i = 0; i < playouts; i++) {
      if (cancelRef?.current) return null;
      const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      if (now - start > timeBudgetMs) { // time cap reached
        break;
      }
      const winner = randomPlayoutWinner(nextBoard, OTHER(color), plies);
      if (winner === color) wins++;
      done++;
      if (i % 8 === 7) { // yield periodically
        onProgress?.(Math.min(99, Math.round((done / totalWork) * 100)));
        await sleep(0);
      }
    }
    const tie = heuristic(board, m, color) * 0.1;
    const score = wins + tie;
    if (score > bestScore) { bestScore = score; best = m; }
    onProgress?.(Math.min(99, Math.round((done / totalWork) * 100)));
    await sleep(0);

    // If time cap hit, stop evaluating remaining candidates and return best so far
    const now2 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    if (now2 - start > timeBudgetMs) break;
  }
  onProgress?.(100);
  return best;
}

// --- UI Components ------------------------------------------------------------
function Stone({ color }) {
  const cls = color === BLACK ? "bg-black" : color === WHITE ? "bg-white" : "";
  const border = color === WHITE ? "border border-gray-400" : "";
  return <div className={`w-6 h-6 rounded-full ${cls} ${border}`}></div>;
}

function usePrevious(value) {
  const ref = useRef();
  useEffect(() => { ref.current = value; }, [value]);
  return ref.current;
}

/*export default */function App() {
  const [size, setSize] = useState(9);
  const [board, setBoard] = useState(makeBoard(9));
  const [toPlay, setToPlay] = useState(BLACK);
  const [lastKey, setLastKey] = useState(null); // for simple-ko
  const [history, setHistory] = useState([]); // stack of {boardKey, board, toPlay}
  const [passes, setPasses] = useState(0);
  const [komi, setKomi] = useState(7.5);
  const [humanColor, setHumanColor] = useState(BLACK);
  const [aiLevel, setAiLevel] = useState(2);
  const [aiThinking, setAiThinking] = useState(false);
  const [aiProgress, setAiProgress] = useState(0);
  const [blitz, setBlitz] = useState(false);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(""), 1600);
    return () => clearTimeout(t);
  }, [notice]);
  const prevBoard = usePrevious(board);

  // Recompute score
  const score = useMemo(() => chineseScore(board), [board]);
  const resultText = useMemo(() => {
    const b = score.black;
    const w = score.white + komi;
    const diff = (b - w).toFixed(1);
    if (passes < 2) return `Black: ${b} — White: ${score.white} + komi ${komi} → Δ ${(diff)}`;
    return diff > 0 ? `Result: Black wins by ${diff}` : diff < 0 ? `Result: White wins by ${(-diff).toFixed(1)}` : `Result: Jigo (tie)`;
  }, [score, komi, passes]);

  // Handle size change
  function newGame(newSize = size) {
    setSize(newSize);
    setBoard(makeBoard(newSize));
    setToPlay(BLACK);
    setLastKey(null);
    setHistory([]);
    setPasses(0);
  }

  // Make move if legal
  function playAt(r, c) {
    if (aiThinking) return;
    if (toPlay !== humanColor) return;
    const res = placeAndCapture(board, r, c, toPlay);
    if (!res) return; // illegal
    const k = boardKey(res.board);
    if (lastKey && k === lastKey) return; // simple-ko
    setHistory((h) => [...h, { boardKey: boardKey(board), board, toPlay }]);
    setBoard(res.board);
    setToPlay(OTHER(toPlay));
    setLastKey(k);
    setPasses(0);
  }

  function passMove() {
    if (aiThinking) return;
    setHistory((h) => [...h, { boardKey: boardKey(board), board, toPlay }]);
    setToPlay(OTHER(toPlay));
    setLastKey(boardKey(board)); // passing stores current state as last
    setPasses((p) => p + 1);
  }

  function undo() {
    if (!history.length || aiThinking) return;
    const prev = history[history.length - 1];
    setHistory((h) => h.slice(0, -1));
    setBoard(prev.board);
    setToPlay(prev.toPlay);
    setLastKey(prev.boardKey);
    setPasses(0);
  }

  // AI turn effect
  useEffect(() => {
    const isAITurn = toPlay !== humanColor;
    if (!isAITurn) return;
    const cancelRef = { current: false };

    async function think() {
      setAiThinking(true);
      setAiProgress(0);
      await sleep(10); // allow paint

      const move = await chooseAIMoveAsync(board, toPlay, aiLevel, lastKey, (p) => setAiProgress(p), cancelRef, blitz);
      if (cancelRef.current || !move) { setAiThinking(false); return; }

      if (move.pass) {
        setHistory((h) => [...h, { boardKey: boardKey(board), board, toPlay }]);
        setToPlay(OTHER(toPlay));
        setLastKey(boardKey(board));
        setPasses((p) => p + 1);
        setNotice("AI passed");
        setAiThinking(false);
        setAiProgress(0);
        return;
      }
      const k = boardKey(move.res.board);
      setHistory((h) => [...h, { boardKey: boardKey(board), board, toPlay }]);
      setBoard(move.res.board);
      setToPlay(OTHER(toPlay));
      setLastKey(k);
      setPasses(0);
      setAiThinking(false);
      setAiProgress(0);
    }
    think();
    return () => { cancelRef.current = true; };
  }, [board, toPlay, humanColor, aiLevel, lastKey]);

  // Board rendering
  const cellSize = 36; // px
  const gridPx = size * cellSize;

  function BoardGrid() {
    const lines = [];
    for (let i = 0; i < size; i++) {
      // horizontal
      lines.push(
        <line key={"h" + i} x1={cellSize / 2} y1={cellSize / 2 + i * cellSize} x2={gridPx - cellSize / 2} y2={cellSize / 2 + i * cellSize} stroke="#222" strokeWidth="1" />
      );
      // vertical
      lines.push(
        <line key={"v" + i} x1={cellSize / 2 + i * cellSize} y1={cellSize / 2} x2={cellSize / 2 + i * cellSize} y2={gridPx - cellSize / 2} stroke="#222" strokeWidth="1" />
      );
    }
    // star points for 9x9 and 19x19 (and 11x11 modest points)
    const starPts = [];
    const star = (r, c) => starPts.push(<circle key={`s-${r}-${c}`} cx={cellSize / 2 + c * cellSize} cy={cellSize / 2 + r * cellSize} r={2.5} fill="#222" />);
    if (size === 19) {
      [3, 9, 15].forEach((x) => [3, 9, 15].forEach((y) => star(x, y)));
    } else if (size === 9) {
      [2, 4, 6].forEach((x) => [2, 4, 6].forEach((y) => star(x, y)));
    } else if (size === 11) {
      [3, 5, 7].forEach((x) => [3, 5, 7].forEach((y) => star(x, y)));
    }

    return (
      <svg width={gridPx} height={gridPx} className="bg-amber-200 rounded-xl shadow-inner">
        {lines}
        {starPts}
      </svg>
    );
  }

  function handleBoardClick(e) {
    if (passes >= 2) return; // game ended
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const c = Math.round((x - cellSize / 2) / cellSize);
    const r = Math.round((y - cellSize / 2) / cellSize);
    if (!inBounds(size, r, c)) return;
    playAt(r, c);
  }

  return (
    <div className="min-h-screen w-full bg-slate-50 text-slate-900 p-4">
      {notice && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 bg-slate-900 text-white px-4 py-2 rounded-xl shadow-lg z-50">
          {notice}
        </div>
      )}
      <div className="max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-5 gap-4">
        <div className="lg:col-span-3">
          <div className="flex items-center justify-between mb-2">
            <h1 className="text-2xl font-semibold">Go (Weiqi) — Chinese Rules, Simple Ko</h1>
            <button
              onClick={() => newGame(size)}
              className="px-3 py-1.5 rounded-xl bg-slate-900 text-white shadow hover:opacity-90"
            >New Game</button>
          </div>

          <div className="relative inline-block" onClick={handleBoardClick}>
            <BoardGrid />
            {/* stones */}
            <div
              className="absolute left-0 top-0"
              style={{ width: gridPx, height: gridPx }}
            >
              {board.map((row, r) => (
                <div key={r} className="flex" style={{ height: cellSize }}>
                  {row.map((v, c) => (
                    <div
                      key={c}
                      className="flex items-center justify-center"
                      style={{ width: cellSize, height: cellSize }}
                    >
                      {v !== EMPTY && <div className={`w-7 h-7 rounded-full ${v === BLACK ? "bg-black" : "bg-white border border-gray-400"}`} />}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>

          <div className="mt-3 flex items-center gap-2">
            <button onClick={passMove} className="px-3 py-1.5 rounded-xl bg-amber-500 text-white shadow disabled:opacity-50" disabled={aiThinking || passes >= 2}>
              Pass
            </button>
            <button onClick={undo} className="px-3 py-1.5 rounded-xl bg-slate-200 text-slate-900 shadow disabled:opacity-50" disabled={!history.length || aiThinking}>
              Undo
            </button>
            <div className="text-sm text-slate-600 ml-2 flex items-center gap-2">
              {aiThinking ? (
                <>
                  <span>AI thinking… {aiProgress}%</span>
                  <span className="w-24 h-2 bg-slate-200 rounded overflow-hidden">
                    <span style={{ width: `${aiProgress}%` }} className="block h-full bg-amber-500 transition-[width]" />
                  </span>
                </>
              ) : (
                <span>{`Turn: ${toPlay === BLACK ? "Black" : "White"}`}</span>
              )}
            </div>
          </div>

          <div className="mt-2 text-lg font-medium">{resultText}</div>
        </div>

        <div className="lg:col-span-2">
          <div className="bg-white rounded-2xl shadow p-4 space-y-4">
            <h2 className="text-xl font-semibold">Settings</h2>

            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className="text-sm text-slate-600">Board Size</span>
                <select
                  className="w-full mt-1 rounded-xl border p-2"
                  value={size}
                  onChange={(e) => newGame(parseInt(e.target.value))}
                >
                  <option value={9}>9×9</option>
                  <option value={11}>11×11</option>
                  <option value={19}>19×19</option>
                </select>
              </label>

              <label className="block">
                <span className="text-sm text-slate-600">Komi (White)</span>
                <input
                  type="number" step="0.5" className="w-full mt-1 rounded-xl border p-2" value={komi}
                  onChange={(e) => setKomi(parseFloat(e.target.value))}
                />
              </label>

              <label className="block">
                <span className="text-sm text-slate-600">You Play</span>
                <select
                  className="w-full mt-1 rounded-xl border p-2"
                  value={humanColor}
                  onChange={(e) => { setHumanColor(parseInt(e.target.value)); newGame(size); }}
                >
                  <option value={BLACK}>Black</option>
                  <option value={WHITE}>White</option>
                </select>
              </label>

              <label className="block">
                <span className="text-sm text-slate-600">AI Level</span>
                <input
                  type="range" min={1} max={5} value={aiLevel}
                  onChange={(e) => setAiLevel(parseInt(e.target.value))}
                  className="w-full"
                />
                <div className="text-sm">{aiLevel} / 5</div>
              </label>

              <label className="block flex items-center gap-2 mt-1">
                <input type="checkbox" checked={blitz} onChange={(e) => setBlitz(e.target.checked)} className="w-4 h-4" />
                <span className="text-sm text-slate-600">Blitz mode (≈150ms/turn cap)</span>
              </label>
            </div>

            <div className="text-sm text-slate-700 leading-relaxed">
              <p><strong>Rules:</strong> Chinese/area scoring, simple-ko (no immediate repetition), no suicide. Two consecutive passes end the game; score shows stones + surrounded territory (White gets komi).</p>
              <p className="mt-2"><strong>Tips:</strong> Start on 9×9 for quick games. Level 1 moves are heuristic-only; Levels 2–5 add increasingly many Monte Carlo playouts.</p>
            </div>

            <div className="text-xs text-slate-500">
              Built as a single-file demo — performance on 19×19 at high AI levels may vary by device.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
