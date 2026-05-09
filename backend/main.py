from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv
import httpx
import os

load_dotenv()

OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY")

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5500", "http://localhost:5500"],
    allow_methods=["*"],
    allow_headers=["*"],
)

AYRA_SYSTEM_PROMPT = """You are Ayra, an expert AI code review assistant. You are sharp, direct, and efficient.

Rules:
- Never be long-winded or unnecessarily detailed
- Do exactly what the user asks, nothing more
- When you make changes, clearly state what you changed in 1-2 lines
- End responses with one smart follow-up suggestion when relevant
- You support all programming languages
- You understand natural language queries about code
- In Mentor mode: briefly explain the why behind fixes
- In Roast mode: be brutally honest but still helpful
- In General mode: balanced, professional, direct

Never act like a chatbot. You are a coding tool with personality."""

class Message(BaseModel):
    role: str
    content: str

class ReviewRequest(BaseModel):
    messages: list[Message]
    code: str
    language: str
    mode: str

@app.post("/review")
async def review_code(request: ReviewRequest):
    user_message = request.messages[-1].content
    full_prompt = f"Mode: {request.mode}\nLanguage: {request.language}\n\nCode:\n```{request.language}\n{request.code}\n```\n\nUser: {user_message}"

    history = [{"role": "system", "content": AYRA_SYSTEM_PROMPT}]

    for msg in request.messages[:-1]:
        role = "user" if msg.role == "user" else "assistant"
        history.append({"role": role, "content": msg.content})

    history.append({"role": "user", "content": full_prompt})

    async with httpx.AsyncClient() as client:
        response = await client.post(
            "https://openrouter.ai/api/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {OPENROUTER_API_KEY}",
                "Content-Type": "application/json",
            },
            json={
                "model": "poolside/laguna-m.1:free",
                "messages": history,
            },
            timeout=30.0
        )

    data = response.json()
    print(data)
    reply = data.get("choices", [{}])[0].get("message", {}).get("content", "Something went wrong.")
    return {"response": reply}
    return {"response": reply}

@app.get("/")
async def root():
    return {"status": "Ayra backend running"}