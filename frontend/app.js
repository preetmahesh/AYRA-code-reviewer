const BACKEND = "http://127.0.0.1:8000";

let editor;
let mode = "general";
let messages = [];
let chatCollapsed = false;

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
    go: "go", rust: "rust", php: "php", ruby: "ruby", swift: "swift", kotlin: "text/x-kotlin"
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
    extraKeys: { Tab: (cm) => cm.replaceSelection("    ") }
  });

  document.getElementById("language-select").addEventListener("change", (e) => {
    const m = modeMap[e.target.value] || "python";
    editor.setOption("mode", m);
  });
}

document.getElementById("theme-toggle").addEventListener("click", () => {
  document.body.classList.toggle("light");
  document.getElementById("theme-toggle").textContent =
    document.body.classList.contains("light") ? "🌙" : "☀️";
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
  const btn = document.getElementById("collapse-chat");
  const tab = document.getElementById("expand-tab");
  chatCollapsed = true;
  panel.classList.add("collapsed");
  btn.textContent = "→";
  tab.classList.remove("hidden");
});

document.getElementById("expand-tab").addEventListener("click", () => {
  const panel = document.getElementById("chat-panel");
  const btn = document.getElementById("collapse-chat");
  const tab = document.getElementById("expand-tab");
  chatCollapsed = false;
  panel.classList.remove("collapsed");
  btn.textContent = "→";
  tab.classList.add("hidden");
});

document.getElementById("clear-code").addEventListener("click", () => {
  if (editor) editor.setValue("");
});

document.getElementById("send-btn").addEventListener("click", sendMessage);

document.getElementById("query-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
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
    chatCollapsed = false;
    document.getElementById("chat-panel").classList.remove("collapsed");
    document.getElementById("collapse-chat").textContent = "→";
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

    const reply = data.response || "Something went wrong.";
    appendMessage("ayra", reply);
    messages.push({ role: "model", content: reply });

  } catch (err) {
    removeTyping(typing);
    appendMessage("ayra", "Can't reach the backend. Make sure it's running.");
  }

  sendBtn.disabled = false;
}

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
      return `\x00CODEBLOCK\x00<div class="code-block-wrap"><pre><code id="${id}">${escapeHtml(code.trim())}</code></pre><button class="copy-btn" onclick="copyCode('${id}')" title="Copy">${COPY_ICON}</button></div>\x00ENDBLOCK\x00`;
    });
    text = text.replace(/\x00CODEBLOCK\x00/g, "");
    text = text.replace(/\x00ENDBLOCK\x00/g, "");
    text = text.replace(/`([^`]+)`/g, (_, code) => `<code>${escapeHtml(code)}</code>`);
    text = text.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
    text = text.split("\n").map(line => line.startsWith("<div class=\"code-block-wrap\">") ? line : line + "<br>").join("");
    return text;
}

function copyCode(id) {
  const code = document.getElementById(id).innerText;
  navigator.clipboard.writeText(code);
  const btn = document.querySelector(`#${id}`).parentElement.querySelector(".copy-btn");
  btn.innerHTML = TICK_ICON;
  btn.classList.add("copied");
  setTimeout(() => {
    btn.innerHTML = COPY_ICON;
    btn.classList.remove("copied");
  }, 2000);
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