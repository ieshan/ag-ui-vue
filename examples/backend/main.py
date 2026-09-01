"""
Minimal AG-UI + ADK backend example.

Run with:
    uvicorn main:app --host 0.0.0.0 --port 8000 --reload

Requires GOOGLE_API_KEY env var for Gemini.
"""

from google.adk.agents import Agent
from ag_ui_adk import ADKAgent, create_adk_app
from fastapi.middleware.cors import CORSMiddleware

adk_agent = Agent(
    name="assistant",
    model="gemini-2.0-flash",
    instruction=(
        "You are a helpful assistant. "
        "You can use tools provided by the user's browser when available."
    ),
)

agent = ADKAgent(
    adk_agent=adk_agent,
    app_name="ag-ui-vue-example",
    user_id="default-user",
)

app = create_adk_app(agent)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
