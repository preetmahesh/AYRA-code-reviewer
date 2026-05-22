const BACKEND = "http://127.0.0.1:8000";
const WS_BACKEND = "ws://127.0.0.1:8000";

let editor;
let mode = "general";
let messages = [];
let chatCollapsed = false;

// Diff state
let originalCode = "";
let fixedCode = "";

// Collab state
let collabSocket = null;
let collabRoom = null;
let collabUser = null;
let isSyncingFromRemote = false;

// ─────────────────────────────────────────────────────────────
//  MYERS DIFF ALGORITHM  (O(ND) — classic CS algorithm)
//  Produces the shortest edit script between two sequences.
//  Used to compute line-level diffs between original and fixed code.
// ─────────────────────────────────────────────────────────────

/**
 * Myers diff — Shortest Edit Script via the Myers O(ND) algorithm.
 *
 * Phase 1 (forward pass): For each edit distance d = 0,1,2,...
 *   track V[k] = furthest x reachable on diagonal k with exactly d edits.
 *   Record every frontier snapshot in `trace`.
 *
 * Phase 2 (backtrack): Walk the trace in reverse to reconstruct the
 *   exact sequence of equal / delete / insert ops.
 *
 * This is the algorithm used by Git, GNU diff, and most modern VCS tools.
 * Time O(N·D), Space O(N+D) where D = edit distance.
 */
function myersDiff(a, b) {
  const N = a.length, M = b.length;
  if (N === 0 && M === 0) return [];

  // ── Phase 1: forward pass, record trace ──────────────────────
  const MAX = N + M;
  const V = new Int32Array(2 * MAX + 2); // offset by MAX so k can be negative
  const trace = [];

  outer: for (let d = 0; d <= MAX; d++) {
    trace.push(V.slice());
    for (let k = -d; k <= d; k += 2) {
      const ki = k + MAX;
      // Decide: come from k-1 (insert) or k+1 (delete)?
      let x = (k === -d || (k !== d && V[ki - 1] < V[ki + 1]))
        ? V[ki + 1]        // came from diagonal k+1 → move down (insert)
        : V[ki - 1] + 1;  // came from diagonal k-1 → move right (delete)
      let y = x - k;
      // Extend snake: consume matching lines for free
      while (x < N && y < M && a[x] === b[y]) { x++; y++; }
      V[ki] = x;
      if (x >= N && y >= M) { trace.push(V.slice()); break outer; }
    }
  }

  // ── Phase 2: backtrack to build the edit script ───────────────
  const ops = [];
  let x = N, y = M;

  for (let d = trace.length - 1; d > 0; d--) {
    const Vd = trace[d];
    const Vprev = trace[d - 1];
    const k = x - y;
    const ki = k + MAX;

    // Which diagonal did we come from one step earlier?
    const fromInsert = (k === -(d - 1)) || (k !== (d - 1) && Vprev[ki - 1] < Vprev[ki + 1]);
    const prevK = fromInsert ? k + 1 : k - 1;
    const px = Vprev[prevK + MAX];
    const py = px - prevK;

    // Walk the snake (equal lines) from (px,py) → (x,y) minus the edit
    while (x > px + (fromInsert ? 0 : 1) && y > py + (fromInsert ? 1 : 0)) {
      ops.unshift({ type: "equal", line: a[x - 1] });
      x--; y--;
    }

    // The single edit at the start of this snake
    if (fromInsert) {
      ops.unshift({ type: "insert", line: b[y - 1] });
      y--;
    } else {
      ops.unshift({ type: "delete", line: a[x - 1] });
      x--;
    }
  }

  // Any remaining lines at the start are all equal
  while (x > 0 && y > 0) {
    ops.unshift({ type: "equal", line: a[x - 1] });
    x--; y--;
  }

  return ops;
}

/**
 * Groups consecutive diff ops with context lines (±3) for a clean
 * unified-diff display — the same hunk format used by `git diff`.
 */
function buildHunks(ops, contextLines = 3) {
  const changes = [];
  ops.forEach((op, i) => { if (op.type !== "equal") changes.push(i); });
  if (!changes.length) return [];

  const hunks = [];
  let i = 0;
  while (i < changes.length) {
    let start = Math.max(0, changes[i] - contextLines);
    let j = i;
    while (j + 1 < changes.length && changes[j + 1] - changes[j] <= contextLines * 2) j++;
    let end = Math.min(ops.length - 1, changes[j] + contextLines);
    hunks.push(ops.slice(start, end + 1));
    i = j + 1;
  }
  return hunks;
}

// ─────────────────────────────────────────────────────────────
//  DIFF RENDERER
// ─────────────────────────────────────────────────────────────
function renderDiff(original, fixed) {
  const aLines = original.split("\n");
  const bLines = fixed.split("\n");
  const ops = myersDiff(aLines, bLines);
  const hunks = buildHunks(ops);

  const diffContent = document.getElementById("diff-content");
  const diffStats = document.getElementById("diff-stats");
  diffContent.innerHTML = "";

  let additions = 0, deletions = 0;
  ops.forEach(op => {
    if (op.type === "insert") additions++;
    if (op.type === "delete") deletions++;
  });

  diffStats.innerHTML =
    `<span class="stat-add">+${additions}</span>` +
    `<span class="stat-del">-${deletions}</span>`;

  if (!hunks.length) {
    diffContent.innerHTML = `<div class="diff-no-change">No changes detected.</div>`;
    return;
  }

  let aLine = 1, bLine = 1;

  hunks.forEach((hunk, hi) => {
    // Hunk header
    const header = document.createElement("div");
    header.className = "diff-hunk-header";
    let aStart = aLine, bStart = bLine;
    // Re-count offsets for hunk header
    header.textContent = `@@ hunk ${hi + 1} @@`;
    diffContent.appendChild(header);

    hunk.forEach(op => {
      const row = document.createElement("div");
      row.className = `diff-row diff-${op.type}`;

      const gutter = document.createElement("span");
      gutter.className = "diff-gutter";

      const prefix = document.createElement("span");
      prefix.className = "diff-prefix";

      const content = document.createElement("span");
      content.className = "diff-line-content";
      content.textContent = op.line;

      if (op.type === "equal") {
        gutter.textContent = `${aLine}  ${bLine}`;
        prefix.textContent = " ";
        aLine++; bLine++;
      } else if (op.type === "delete") {
        gutter.textContent = `${aLine}`;
        prefix.textContent = "−";
        row.title = "Removed by Ayra";
        aLine++;
      } else {
        gutter.textContent = `  ${bLine}`;
        prefix.textContent = "+";
        row.title = "Added by Ayra";
        bLine++;
      }

      row.appendChild(gutter);
      row.appendChild(prefix);
      row.appendChild(content);
      diffContent.appendChild(row);
    });

    // separator between hunks
    if (hi < hunks.length - 1) {
      const sep = document.createElement("div");
      sep.className = "diff-separator";
      sep.textContent = "⋯";
      diffContent.appendChild(sep);
    }
  });
}

function showDiff(original, fixed) {
  originalCode = original;
  fixedCode = fixed;
  renderDiff(original, fixed);
  document.getElementById("diff-panel").classList.remove("hidden");
  document.getElementById("diff-btn").classList.remove("hidden");
}

function closeDiff() {
  document.getElementById("diff-panel").classList.add("hidden");
}

// ─────────────────────────────────────────────────────────────
//  INIT
// ─────────────────────────────────────────────────────────────
window.addEventListener("load", () => {
  setTimeout(() => {
    const intro = document.getElementById("intro");
    const app = document.getElementById("app");
    intro.classList.add("fade-out");
    setTimeout(() => {
      intro.style.display = "none";
      app.classList.remove("hidden");
      initEditor();
    }, 800);
  }, 3000);
});

function initEditor() {
  const modeMap = {
    python: "python", javascript: "javascript", typescript: "javascript",
    cpp: "text/x-c++src", c: "text/x-csrc", java: "text/x-java",
    go: "go", rust: "rust", php: "php", ruby: "ruby",
    swift: "swift", kotlin: "text/x-kotlin"
  };

  editor = CodeMirror(document.getElementById("editor-container"), {
    mode: "python",
    theme: "one-dark",
    lineNumbers: true,
    matchBrackets: true,
    autoCloseBrackets: true,
    indentUnit: 4,
    tabSize: 4,
    indentWithTabs: false,
    lineWrapping: false,
    autofocus: true,
    extraKeys: {
      Tab: (cm) => cm.replaceSelection("    "),
      "Ctrl-Enter": runCode,
      "Cmd-Enter": runCode,
    }
  });

  editor.on("change", (cm, change) => {
    if (isSyncingFromRemote) return;
    if (collabSocket && collabSocket.readyState === WebSocket.OPEN) {
      collabSocket.send(JSON.stringify({ type: "code_change", code: cm.getValue() }));
    }
  });

  document.getElementById("language-select").addEventListener("change", (e) => {
    const m = modeMap[e.target.value] || "python";
    editor.setOption("mode", m);
    if (collabSocket && collabSocket.readyState === WebSocket.OPEN) {
      collabSocket.send(JSON.stringify({ type: "language_change", language: e.target.value }));
    }
  });
}

// ─────────────────────────────────────────────────────────────
//  LIVE CODE EXECUTION
// ─────────────────────────────────────────────────────────────
async function runCode() {
  const code = editor ? editor.getValue() : "";
  const language = document.getElementById("language-select").value;
  if (!code.trim()) return;

  const outputPanel = document.getElementById("output-panel");
  const outputContent = document.getElementById("output-content");
  const outputExit = document.getElementById("output-exit");
  const runBtn = document.getElementById("run-btn");

  outputPanel.classList.remove("hidden");
  outputContent.innerHTML = `<span class="output-running"><span class="output-dot"></span>Running...</span>`;
  outputExit.textContent = "";
  runBtn.disabled = true;

  try {
    const res = await fetch(`${BACKEND}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, language })
    });
    const data = await res.json();

    const exitCode = data.code ?? 0;
    const stdout = data.stdout || "";
    const stderr = data.stderr || "";

    outputExit.textContent = exitCode === 0 ? "✓ exit 0" : `✗ exit ${exitCode}`;
    outputExit.className = `output-exit-badge ${exitCode === 0 ? "exit-ok" : "exit-err"}`;

    let html = "";
    if (stdout) html += `<pre class="out-stdout">${escapeHtml(stdout)}</pre>`;
    if (stderr) html += `<pre class="out-stderr">${escapeHtml(stderr)}</pre>`;
    if (!stdout && !stderr) html = `<span class="output-empty">No output.</span>`;
    outputContent.innerHTML = html;
  } catch (err) {
    outputContent.innerHTML = `<pre class="out-stderr">Could not reach execution service.\n${err.message}</pre>`;
  }

  runBtn.disabled = false;
}

document.getElementById("run-btn").addEventListener("click", runCode);
document.getElementById("close-output").addEventListener("click", () => {
  document.getElementById("output-panel").classList.add("hidden");
});

document.getElementById("apply-diff-btn").addEventListener("click", () => {
  if (editor && fixedCode) {
    editor.setValue(fixedCode);
    closeDiff();
    document.getElementById("diff-btn").classList.add("hidden");
    appendMessage("ayra", "✓ Fix applied to editor.");
    messages.push({ role: "model", content: "✓ Fix applied to editor." });
  }
});

document.getElementById("run-fixed-btn").addEventListener("click", async () => {
  if (!fixedCode) return;
  const language = document.getElementById("language-select").value;

  const outputPanel = document.getElementById("output-panel");
  const outputContent = document.getElementById("output-content");
  const outputExit = document.getElementById("output-exit");
  const runFixedBtn = document.getElementById("run-fixed-btn");

  outputPanel.classList.remove("hidden");
  outputContent.innerHTML = `<span class="output-running"><span class="output-dot"></span>Running fixed code...</span>`;
  outputExit.textContent = "";
  runFixedBtn.disabled = true;

  try {
    const res = await fetch(`${BACKEND}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: fixedCode, language })
    });
    const data = await res.json();
    const exitCode = data.code ?? 0;
    const stdout = data.stdout || "";
    const stderr = data.stderr || "";

    outputExit.textContent = exitCode === 0 ? "✓ exit 0" : `✗ exit ${exitCode}`;
    outputExit.className = `output-exit-badge ${exitCode === 0 ? "exit-ok" : "exit-err"}`;

    let html = "";
    if (stdout) html += `<pre class="out-stdout">${escapeHtml(stdout)}</pre>`;
    if (stderr) html += `<pre class="out-stderr">${escapeHtml(stderr)}</pre>`;
    if (!stdout && !stderr) html = `<span class="output-empty">No output.</span>`;
    outputContent.innerHTML = html;
  } catch (err) {
    outputContent.innerHTML = `<pre class="out-stderr">Could not reach execution service.\n${err.message}</pre>`;
  }
  runFixedBtn.disabled = false;
});

document.getElementById("close-diff-btn").addEventListener("click", closeDiff);
document.getElementById("diff-btn").addEventListener("click", () => {
  document.getElementById("diff-panel").classList.toggle("hidden");
});

// ─────────────────────────────────────────────────────────────
//  REAL-TIME COLLABORATION
// ─────────────────────────────────────────────────────────────
document.getElementById("collab-btn").addEventListener("click", () => {
  document.getElementById("collab-modal").classList.remove("hidden");
});
document.getElementById("collab-modal-close").addEventListener("click", () => {
  document.getElementById("collab-modal").classList.add("hidden");
});

document.getElementById("gen-room-btn").addEventListener("click", () => {
  const words = ["alpha", "beta", "gamma", "delta", "sigma", "omega", "nova", "echo", "pixel", "stack"];
  const w1 = words[Math.floor(Math.random() * words.length)];
  const w2 = words[Math.floor(Math.random() * words.length)];
  const num = Math.floor(Math.random() * 90) + 10;
  document.getElementById("collab-room").value = `${w1}-${w2}-${num}`;
});

document.getElementById("join-room-btn").addEventListener("click", joinRoom);
document.getElementById("leave-room-btn").addEventListener("click", leaveRoom);

function joinRoom() {
  const username = document.getElementById("collab-username").value.trim();
  const roomId = document.getElementById("collab-room").value.trim();
  const status = document.getElementById("collab-status");

  if (!username || !roomId) {
    status.textContent = "Enter your name and a room code.";
    status.className = "collab-status error";
    return;
  }

  if (collabSocket) collabSocket.close();

  collabUser = username;
  collabRoom = roomId;
  status.textContent = "Connecting...";
  status.className = "collab-status";

  collabSocket = new WebSocket(`${WS_BACKEND}/collab/${encodeURIComponent(roomId)}/${encodeURIComponent(username)}`);

  collabSocket.onopen = () => {
    status.textContent = `Connected to room "${roomId}"`;
    status.className = "collab-status success";
    document.getElementById("join-room-btn").classList.add("hidden");
    document.getElementById("leave-room-btn").classList.remove("hidden");
    document.getElementById("collab-btn").classList.add("collab-active");
  };

  collabSocket.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    handleCollabMessage(msg);
  };

  collabSocket.onerror = () => {
    status.textContent = "Connection failed. Is the backend running?";
    status.className = "collab-status error";
  };

  collabSocket.onclose = () => {
    document.getElementById("collab-btn").classList.remove("collab-active");
    updateCollabUsers([]);
  };
}

function leaveRoom() {
  if (collabSocket) { collabSocket.close(); collabSocket = null; }
  collabRoom = null; collabUser = null;
  const status = document.getElementById("collab-status");
  status.textContent = "Left the room.";
  status.className = "collab-status";
  document.getElementById("join-room-btn").classList.remove("hidden");
  document.getElementById("leave-room-btn").classList.add("hidden");
  updateCollabUsers([]);
}

function handleCollabMessage(msg) {
  switch (msg.type) {
    case "init":
      isSyncingFromRemote = true;
      if (msg.code && editor) editor.setValue(msg.code);
      if (msg.language) {
        document.getElementById("language-select").value = msg.language;
        document.getElementById("language-select").dispatchEvent(new Event("change"));
      }
      isSyncingFromRemote = false;
      updateCollabUsers(msg.users || []);
      break;

    case "code_change":
      if (msg.from !== collabUser && editor) {
        isSyncingFromRemote = true;
        const cursor = editor.getCursor();
        editor.setValue(msg.code);
        editor.setCursor(cursor);
        isSyncingFromRemote = false;
      }
      break;

    case "language_change":
      if (msg.from !== collabUser) {
        document.getElementById("language-select").value = msg.language;
        document.getElementById("language-select").dispatchEvent(new Event("change"));
      }
      break;

    case "user_joined":
      updateCollabUsers(msg.users || []);
      showCollabToast(`${msg.username} joined the room`);
      break;

    case "user_left":
      updateCollabUsers(msg.users || []);
      showCollabToast(`${msg.username} left the room`);
      break;
  }
}

function updateCollabUsers(users) {
  const container = document.getElementById("collab-users");
  if (!users.length || !collabRoom) {
    container.classList.add("hidden");
    return;
  }
  container.classList.remove("hidden");
  container.innerHTML = users.map(u =>
    `<span class="collab-avatar" title="${escapeHtml(u)}" style="background:${stringToColor(u)}">${u[0].toUpperCase()}</span>`
  ).join("");
}

function stringToColor(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  const colors = ["#14b8a6","#3b82f6","#8b5cf6","#f59e0b","#ec4899","#10b981","#ef4444","#06b6d4"];
  return colors[Math.abs(hash) % colors.length];
}

function showCollabToast(msg) {
  const toast = document.createElement("div");
  toast.className = "collab-toast";
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => toast.classList.add("toast-visible"), 10);
  setTimeout(() => { toast.classList.remove("toast-visible"); setTimeout(() => toast.remove(), 300); }, 3000);
}

// ─────────────────────────────────────────────────────────────
//  TOPBAR CONTROLS
// ─────────────────────────────────────────────────────────────
document.getElementById("theme-toggle").addEventListener("click", () => {
  document.body.classList.toggle("light");
  document.getElementById("theme-toggle").textContent = document.body.classList.contains("light") ? "🌙" : "☀️";
});

document.querySelectorAll(".mode-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".mode-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    mode = btn.dataset.mode;
  });
});

document.getElementById("collapse-chat").addEventListener("click", () => {
  const panel = document.getElementById("chat-panel");
  chatCollapsed = true;
  panel.classList.add("collapsed");
  document.getElementById("expand-tab").classList.remove("hidden");
});

document.getElementById("expand-tab").addEventListener("click", () => {
  document.getElementById("chat-panel").classList.remove("collapsed");
  chatCollapsed = false;
  document.getElementById("expand-tab").classList.add("hidden");
});

document.getElementById("clear-code").addEventListener("click", () => {
  if (editor) editor.setValue("");
});

// ─────────────────────────────────────────────────────────────
//  CHAT MESSAGING
// ─────────────────────────────────────────────────────────────
document.getElementById("send-btn").addEventListener("click", sendMessage);
document.getElementById("query-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});
document.getElementById("query-input").addEventListener("input", function () {
  this.style.height = "auto";
  this.style.height = Math.min(this.scrollHeight, 120) + "px";
});

async function sendMessage() {
  const input = document.getElementById("query-input");
  const query = input.value.trim();
  if (!query) return;

  const code = editor ? editor.getValue() : "";
  const language = document.getElementById("language-select").value;
  input.value = "";
  input.style.height = "auto";

  if (chatCollapsed) {
    document.getElementById("chat-panel").classList.remove("collapsed");
    chatCollapsed = false;
    document.getElementById("expand-tab").classList.add("hidden");
  }

  appendMessage("user", query);
  messages.push({ role: "user", content: query });

  const sendBtn = document.getElementById("send-btn");
  sendBtn.disabled = true;
  const typing = showTyping();

  try {
    const res = await fetch(`${BACKEND}/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages, code, language, mode })
    });
    const data = await res.json();
    removeTyping(typing);

    let reply = data.response || "Something went wrong.";

    // Extract fixed_code block if present and auto-show diff
    const fixedMatch = reply.match(/<fixed_code>\s*([\s\S]*?)\s*<\/fixed_code>/);
    if (fixedMatch && code.trim()) {
      const extracted = fixedMatch[1];
      // Remove the tag from displayed message
      const displayReply = reply.replace(/<fixed_code>[\s\S]*?<\/fixed_code>/, "").trim();
      appendMessage("ayra", displayReply + "\n\n*Diff view opened automatically ↑*");
      messages.push({ role: "model", content: displayReply });
      showDiff(code, extracted);
    } else {
      appendMessage("ayra", reply);
      messages.push({ role: "model", content: reply });
    }
  } catch (err) {
    removeTyping(typing);
    appendMessage("ayra", "Can't reach the backend. Make sure it's running.");
  }

  sendBtn.disabled = false;
}

// ─────────────────────────────────────────────────────────────
//  MESSAGE RENDERING
// ─────────────────────────────────────────────────────────────
function appendMessage(role, text) {
  const container = document.getElementById("chat-messages");
  const wrap = document.createElement("div");
  wrap.className = `message ${role}`;

  const label = document.createElement("div");
  label.className = "msg-label";
  label.textContent = role === "user" ? "You" : "Ayra";

  const bubble = document.createElement("div");
  bubble.className = "msg-bubble";
  bubble.innerHTML = formatMessage(text);

  wrap.appendChild(label);
  wrap.appendChild(bubble);
  container.appendChild(wrap);
  container.scrollTop = container.scrollHeight;

  const welcome = container.querySelector(".ayra-welcome");
  if (welcome) welcome.remove();
}

const COPY_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
const TICK_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;

function formatMessage(text) {
  text = text.replace(/```(\w+)?\n?([\s\S]*?)```/g, (_, lang, code) => {
    const id = "cb_" + Math.random().toString(36).substr(2, 9);
    return `\x00CB\x00<div class="code-block-wrap"><pre><code id="${id}">${escapeHtml(code.trim())}</code></pre><button class="copy-btn" onclick="copyCode('${id}')" title="Copy">${COPY_ICON}</button></div>\x00ENDCB\x00`;
  });
  text = text.replace(/\x00CB\x00/g, "").replace(/\x00ENDCB\x00/g, "");
  text = text.replace(/`([^`]+)`/g, (_, code) => `<code>${escapeHtml(code)}</code>`);
  text = text.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/\*(.*?)\*/g, "<em>$1</em>");
  text = text.split("\n").map(line =>
    line.startsWith('<div class="code-block-wrap">') ? line : line + "<br>"
  ).join("");
  return text;
}

function copyCode(id) {
  const code = document.getElementById(id).innerText;
  navigator.clipboard.writeText(code);
  const btn = document.querySelector(`#${id}`).parentElement.querySelector(".copy-btn");
  btn.innerHTML = TICK_ICON;
  btn.classList.add("copied");
  setTimeout(() => { btn.innerHTML = COPY_ICON; btn.classList.remove("copied"); }, 2000);
}

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function showTyping() {
  const container = document.getElementById("chat-messages");
  const wrap = document.createElement("div");
  wrap.className = "message ayra typing-wrap";
  const indicator = document.createElement("div");
  indicator.className = "typing-indicator";
  indicator.innerHTML = "<span></span><span></span><span></span>";
  wrap.appendChild(indicator);
  container.appendChild(wrap);
  container.scrollTop = container.scrollHeight;
  return wrap;
}

function removeTyping(el) {
  if (el && el.parentNode) el.parentNode.removeChild(el);
}