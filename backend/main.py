from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv
import httpx
import os
import json
from typing import Dict, List

load_dotenv()

OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY")

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

AYRA_SYSTEM_PROMPT = """You are Ayra, an expert AI code review assistant. You are sharp, direct, and efficient.

Rules:
- Always give ONE solution only, the best one. Don't give alternatives unless explicitly asked.
- Code you provide must be complete, correct, and directly copy-pasteable with zero changes needed.
- Never give redundant or duplicate functions.
- After providing fixed code, say what you changed in 1-2 lines max.
- End with ONE smart follow-up suggestion only if relevant.
- Never be long-winded. No unnecessary explanations.
- You support all programming languages.
- You understand natural language queries about code.
- In Mentor mode: add one brief explanation of WHY after the fix.
- In Roast mode: be brutally honest but still helpful. Not too long responses.
- In General mode: just fix it and state what changed. That's it.

When you provide a corrected/improved version of code the user already has, wrap the COMPLETE fixed code in a special tag like this:
<fixed_code>
...the complete fixed code here...
</fixed_code>

This allows the diff viewer to activate automatically. Only use this tag when you are actually providing an improved version of their existing code, not for standalone examples.

You are a coding tool with personality, not a chatbot. Stay focused."""


# ─────────────────────────────────────────────
#  In-memory room store for collaboration
# ─────────────────────────────────────────────
class Room:
    def __init__(self, room_id: str):
        self.room_id = room_id
        self.connections: Dict[str, WebSocket] = {}   # username -> ws
        self.code: str = ""
        self.language: str = "python"

    async def broadcast(self, data: dict, exclude: str = None):
        dead = []
        for user, ws in self.connections.items():
            if user == exclude:
                continue
            try:
                await ws.send_json(data)
            except Exception:
                dead.append(user)
        for u in dead:
            self.connections.pop(u, None)

rooms: Dict[str, Room] = {}


# ─────────────────────────────────────────────
#  Models
# ─────────────────────────────────────────────
class Message(BaseModel):
    role: str
    content: str

class ReviewRequest(BaseModel):
    messages: list[Message]
    code: str
    language: str
    mode: str

class ExecuteRequest(BaseModel):
    code: str
    language: str
    stdin: str = ""


# ─────────────────────────────────────────────
#  Review endpoint (streaming SSE)
# ─────────────────────────────────────────────
@app.post("/review")
async def review_code(request: ReviewRequest):
    user_message = request.messages[-1].content
    full_prompt = (
        f"Mode: {request.mode}\n"
        f"Language: {request.language}\n\n"
        f"Code:\n```{request.language}\n{request.code}\n```\n\n"
        f"User: {user_message}"
    )

    history = [{"role": "system", "content": AYRA_SYSTEM_PROMPT}]
    for msg in request.messages[:-1]:
        history.append({"role": "user" if msg.role == "user" else "assistant", "content": msg.content})
    history.append({"role": "user", "content": full_prompt})

    async with httpx.AsyncClient() as client:
        response = await client.post(
            "https://openrouter.ai/api/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {OPENROUTER_API_KEY}",
                "Content-Type": "application/json",
            },
            json={"model": "poolside/laguna-m.1:free", "messages": history},
            timeout=60.0,
        )

    data = response.json()
    reply = data.get("choices", [{}])[0].get("message", {}).get("content", "Something went wrong.")
    return {"response": reply}


# ─────────────────────────────────────────────
#  Code Execution endpoint  (Judge0 CE)
#  Public open instance — no API key needed
#  https://ce.judge0.com
# ─────────────────────────────────────────────

# Judge0 language IDs
JUDGE0_LANG_MAP = {
    "python":     71,
    "javascript": 63,
    "typescript": 74,
    "cpp":        54,
    "c":          50,
    "java":       62,
    "go":         60,
    "rust":       73,
    "php":        68,
    "ruby":       72,
    "swift":      83,
    "kotlin":     78,
}

JUDGE0_URL = "https://ce.judge0.com"

@app.post("/execute")
async def execute_code(req: ExecuteRequest):
    import base64

    lang_id = JUDGE0_LANG_MAP.get(req.language)
    if not lang_id:
        return {"stdout": "", "stderr": f"Language '{req.language}' not supported.", "code": 1}

    payload = {
        "source_code": base64.b64encode(req.code.encode()).decode(),
        "language_id": lang_id,
        "stdin": base64.b64encode(req.stdin.encode()).decode() if req.stdin else "",
        "base64_encoded": True,
        "wait": True,
    }

    def safe_decode(val):
        if not val:
            return ""
        try:
            return base64.b64decode(val).decode("utf-8", errors="replace")
        except Exception:
            return str(val)

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                f"{JUDGE0_URL}/submissions",
                json=payload,
                params={"base64_encoded": "true", "wait": "true"},
                headers={"Content-Type": "application/json"},
            )
        result = resp.json()
        print(f"[execute] Judge0 response: {result}")

        stdout  = safe_decode(result.get("stdout"))
        stderr  = safe_decode(result.get("stderr"))
        compile_out = safe_decode(result.get("compile_output"))
        status  = result.get("status", {})
        status_id = status.get("id", 3) if isinstance(status, dict) else 3

        if not stderr and compile_out:
            stderr = compile_out

        exit_code = 0 if status_id == 3 else 1
        return {"stdout": stdout, "stderr": stderr, "code": exit_code}

    except Exception as e:
        return {"stdout": "", "stderr": f"Execution error: {str(e)}", "code": 1}
# ─────────────────────────────────────────────
#  WebSocket collaboration
# ─────────────────────────────────────────────
@app.websocket("/collab/{room_id}/{username}")
async def collab_ws(websocket: WebSocket, room_id: str, username: str):
    await websocket.accept()

    if room_id not in rooms:
        rooms[room_id] = Room(room_id)
    room = rooms[room_id]
    room.connections[username] = websocket

    # Send current room state to newcomer
    await websocket.send_json({
        "type": "init",
        "code": room.code,
        "language": room.language,
        "users": list(room.connections.keys()),
    })

    # Broadcast join event
    await room.broadcast({"type": "user_joined", "username": username, "users": list(room.connections.keys())}, exclude=username)

    try:
        while True:
            raw = await websocket.receive_text()
            msg = json.loads(raw)

            if msg["type"] == "code_change":
                room.code = msg["code"]
                await room.broadcast({"type": "code_change", "code": msg["code"], "from": username}, exclude=username)

            elif msg["type"] == "language_change":
                room.language = msg["language"]
                await room.broadcast({"type": "language_change", "language": msg["language"], "from": username}, exclude=username)

            elif msg["type"] == "cursor":
                await room.broadcast({"type": "cursor", "username": username, "line": msg.get("line", 0)}, exclude=username)

    except WebSocketDisconnect:
        room.connections.pop(username, None)
        await room.broadcast({"type": "user_left", "username": username, "users": list(room.connections.keys())})
        if not room.connections:
            rooms.pop(room_id, None)


@app.get("/")
async def root():
    return {"status": "Ayra backend running"}