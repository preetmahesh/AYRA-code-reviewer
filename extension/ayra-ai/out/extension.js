"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const BACKEND = 'http://127.0.0.1:8000';
function activate(context) {
    const provider = new AyraSidebarProvider(context.extensionUri);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider('ayra.sidebar', provider));
}
function deactivate() { }
class AyraSidebarProvider {
    _extensionUri;
    _view;
    _messages = [];
    _snapshot = '';
    constructor(_extensionUri) {
        this._extensionUri = _extensionUri;
    }
    resolveWebviewView(webviewView) {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: []
        };
        webviewView.webview.html = this._getHtml();
        webviewView.webview.onDidReceiveMessage(async (msg) => {
            if (msg.command === 'send') {
                await this._handleMessage(msg.text, msg.mode);
            }
            else if (msg.command === 'applyFix') {
                await this._applyFix(msg.code);
            }
            else if (msg.command === 'undo') {
                await this._undoFix();
            }
        });
    }
    async _handleMessage(userText, mode) {
        const editor = vscode.window.activeTextEditor;
        const code = editor ? editor.document.getText() : '';
        const language = editor ? editor.document.languageId : 'plaintext';
        this._messages.push({ role: 'user', content: userText });
        this._post({ command: 'typing' });
        try {
            const res = await fetch(`${BACKEND}/review`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messages: this._messages, code, language, mode }),
            });
            const data = await res.json();
            const reply = data.response;
            this._messages.push({ role: 'model', content: reply });
            this._post({ command: 'reply', text: reply });
            // check if reply contains a code block — offer to apply
            if (reply.includes('```')) {
                this._post({ command: 'showApply' });
            }
        }
        catch {
            this._post({ command: 'reply', text: "Can't reach Ayra backend. Make sure it's running." });
        }
    }
    async _applyFix(code) {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No active file open.');
            return;
        }
        this._snapshot = editor.document.getText();
        await editor.edit(editBuilder => {
            const full = new vscode.Range(editor.document.positionAt(0), editor.document.positionAt(editor.document.getText().length));
            editBuilder.replace(full, code);
        });
        vscode.window.showInformationMessage('Ayra applied the fix.');
        this._post({ command: 'hideApply' });
    }
    async _undoFix() {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !this._snapshot)
            return;
        await editor.edit(editBuilder => {
            const full = new vscode.Range(editor.document.positionAt(0), editor.document.positionAt(editor.document.getText().length));
            editBuilder.replace(full, this._snapshot);
        });
        vscode.window.showInformationMessage('Reverted to previous code.');
        this._post({ command: 'hideApply' });
    }
    _post(msg) {
        this._view?.webview.postMessage(msg);
    }
    _getHtml() {
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #0d1117;
    color: #e2e8f0;
    display: flex;
    flex-direction: column;
    height: 100vh;
    font-size: 12px;
  }

  header {
    padding: 10px 12px;
    border-bottom: 1px solid #1e2d45;
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: #0a0e1a;
  }

  .logo { color: #14b8a6; font-weight: 600; letter-spacing: 0.1em; font-size: 13px; }

  .mode-toggle {
    display: flex;
    gap: 3px;
    background: #111827;
    border: 1px solid #1e2d45;
    border-radius: 6px;
    padding: 2px;
  }

  .mode-btn {
    background: none;
    border: none;
    color: #64748b;
    font-size: 10px;
    padding: 3px 8px;
    border-radius: 4px;
    cursor: pointer;
  }

  .mode-btn.active { background: #14b8a6; color: #fff; }
  .mode-btn[data-mode="roast"].active { background: #9f1239; }
  .mode-btn[data-mode="mentor"].active { background: #3b82f6; }

  #chat {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .msg { display: flex; flex-direction: column; gap: 3px; }
  .msg.user { align-items: flex-end; }
  .msg.ayra { align-items: flex-start; }

  .msg-label { font-size: 9px; color: #334155; text-transform: uppercase; letter-spacing: 0.05em; }

  .bubble {
    max-width: 100%;
    padding: 8px 10px;
    border-radius: 8px;
    line-height: 1.5;
    word-break: break-word;
  }

  .msg.user .bubble { background: #111827; border: 1px solid #1e2d45; }
  .msg.ayra .bubble { background: linear-gradient(135deg, rgba(20,184,166,0.1), rgba(59,130,246,0.07)); border: 1px solid rgba(20,184,166,0.2); }

  pre {
    background: #0a0e1a;
    border: 1px solid #1e2d45;
    border-radius: 5px;
    padding: 8px;
    overflow-x: auto;
    margin: 6px 0;
    font-family: 'JetBrains Mono', 'Courier New', monospace;
    font-size: 11px;
    color: #e2e8f0;
    position: relative;
  }

  code { font-family: 'JetBrains Mono', 'Courier New', monospace; color: #14b8a6; font-size: 11px; }
  pre code { color: #e2e8f0; }

  .copy-btn {
    position: absolute;
    top: 5px;
    right: 5px;
    background: rgba(255,255,255,0.05);
    border: 1px solid #1e2d45;
    color: #64748b;
    width: 22px;
    height: 22px;
    border-radius: 4px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: 0;
    transition: opacity 0.2s;
  }

  pre:hover .copy-btn { opacity: 1; }
  .copy-btn.copied { border-color: #10b981; color: #10b981; opacity: 1; }

  .apply-bar {
    display: none;
    gap: 6px;
    padding: 8px 12px;
    background: #0a0e1a;
    border-top: 1px solid #1e2d45;
  }

  .apply-bar.visible { display: flex; }

  .apply-btn {
    flex: 1;
    padding: 6px;
    border-radius: 6px;
    border: none;
    cursor: pointer;
    font-size: 11px;
    font-weight: 500;
  }

  .apply-btn.yes { background: #14b8a6; color: #fff; }
  .apply-btn.yes:hover { background: #0d9488; }
  .apply-btn.undo { background: #1e2d45; color: #e2e8f0; }
  .apply-btn.undo:hover { background: #9f1239; }

  .query-bar {
    padding: 8px 10px;
    background: #0a0e1a;
    border-top: 1px solid #1e2d45;
    display: flex;
    gap: 6px;
    align-items: flex-end;
  }

  textarea {
    flex: 1;
    background: #111827;
    border: 1px solid #1e2d45;
    border-radius: 7px;
    color: #e2e8f0;
    font-family: inherit;
    font-size: 12px;
    padding: 6px 8px;
    resize: none;
    outline: none;
    max-height: 80px;
    line-height: 1.4;
  }

  textarea:focus { border-color: #14b8a6; }

  #send-btn {
    background: #14b8a6;
    border: none;
    color: #fff;
    width: 28px;
    height: 28px;
    border-radius: 6px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  #send-btn:hover { background: #3b82f6; }
  #send-btn:disabled { opacity: 0.4; cursor: not-allowed; }

  .typing { display: flex; gap: 3px; padding: 8px 10px; }
  .typing span {
    width: 5px; height: 5px;
    background: #14b8a6;
    border-radius: 50%;
    animation: dot 1.2s ease-in-out infinite;
  }
  .typing span:nth-child(2) { animation-delay: 0.2s; }
  .typing span:nth-child(3) { animation-delay: 0.4s; }

  @keyframes dot {
    0%, 60%, 100% { opacity: 0.2; transform: scale(1); }
    30% { opacity: 1; transform: scale(1.3); }
  }

  ::-webkit-scrollbar { width: 3px; }
  ::-webkit-scrollbar-thumb { background: #1e2d45; border-radius: 3px; }
</style>
</head>
<body>

<header>
  <span class="logo">Ayra</span>
  <div class="mode-toggle">
    <button class="mode-btn active" data-mode="general">General</button>
    <button class="mode-btn" data-mode="mentor">Mentor</button>
    <button class="mode-btn" data-mode="roast">Roast</button>
  </div>
</header>

<div id="chat">
  <div class="msg ayra">
    <div class="msg-label">Ayra</div>
    <div class="bubble">Hey. Open a file and tell me what you need.</div>
  </div>
</div>

<div class="apply-bar" id="apply-bar">
  <button class="apply-btn yes" id="apply-btn">Apply Fix</button>
  <button class="apply-btn undo" id="undo-btn">Undo</button>
</div>

<div class="query-bar">
  <textarea id="input" placeholder="Ask Ayra..." rows="1"></textarea>
  <button id="send-btn">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <line x1="22" y1="2" x2="11" y2="13"></line>
      <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
    </svg>
  </button>
</div>

<script>
  const vscode = acquireVsCodeApi();
  let mode = 'general';
  let lastCode = '';

  const COPY_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  const TICK_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>';

  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      mode = btn.dataset.mode;
    });
  });

  document.getElementById('send-btn').addEventListener('click', send);
  document.getElementById('input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });

  document.getElementById('input').addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 80) + 'px';
  });

  document.getElementById('apply-btn').addEventListener('click', () => {
    vscode.postMessage({ command: 'applyFix', code: lastCode });
  });

  document.getElementById('undo-btn').addEventListener('click', () => {
    vscode.postMessage({ command: 'undo' });
  });

  function send() {
    const input = document.getElementById('input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    input.style.height = 'auto';
    appendMsg('user', text);
    document.getElementById('send-btn').disabled = true;
    vscode.postMessage({ command: 'send', text, mode });
  }

  function appendMsg(role, text) {
    const chat = document.getElementById('chat');
    const wrap = document.createElement('div');
    wrap.className = 'msg ' + role;
    const label = document.createElement('div');
    label.className = 'msg-label';
    label.textContent = role === 'user' ? 'You' : 'Ayra';
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.innerHTML = formatText(text);
    wrap.appendChild(label);
    wrap.appendChild(bubble);
    chat.appendChild(wrap);
    chat.scrollTop = chat.scrollHeight;
  }

  function formatText(text) {
    text = text.replace(/\`\`\`(\w+)?\n?([\s\S]*?)\`\`\`/g, (_, lang, code) => {
      const id = 'cb_' + Math.random().toString(36).substr(2, 9);
      lastCode = code.trim();
      return '<div style="position:relative"><pre><code id="' + id + '">' + escHtml(code.trim()) + '</code></pre><button class="copy-btn" onclick="copyCode(\'' + id + '\')">' + COPY_ICON + '</button></div>';
    });
    text = text.replace(/\`([^\`]+)\`/g, (_, c) => '<code>' + escHtml(c) + '</code>');
    text = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/\n/g, '<br>');
    return text;
  }

  function copyCode(id) {
    const code = document.getElementById(id).innerText;
    navigator.clipboard.writeText(code);
    const btn = document.querySelector('#' + id).parentElement.querySelector('.copy-btn');
    btn.innerHTML = TICK_ICON;
    btn.classList.add('copied');
    setTimeout(() => { btn.innerHTML = COPY_ICON; btn.classList.remove('copied'); }, 2000);
  }

  function escHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  window.addEventListener('message', e => {
    const msg = e.data;
    if (msg.command === 'typing') {
      showTyping();
    } else if (msg.command === 'reply') {
      removeTyping();
      appendMsg('ayra', msg.text);
      document.getElementById('send-btn').disabled = false;
    } else if (msg.command === 'showApply') {
      document.getElementById('apply-bar').classList.add('visible');
    } else if (msg.command === 'hideApply') {
      document.getElementById('apply-bar').classList.remove('visible');
    }
  });

  function showTyping() {
    const chat = document.getElementById('chat');
    const div = document.createElement('div');
    div.className = 'msg ayra';
    div.id = 'typing-indicator';
    div.innerHTML = '<div class="typing"><span></span><span></span><span></span></div>';
    chat.appendChild(div);
    chat.scrollTop = chat.scrollHeight;
  }

  function removeTyping() {
    const t = document.getElementById('typing-indicator');
    if (t) t.remove();
  }
</script>
</body>
</html>`;
    }
}
//# sourceMappingURL=extension.js.map