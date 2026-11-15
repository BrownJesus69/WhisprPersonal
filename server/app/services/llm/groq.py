from app.services.llm.openai_compat import OpenAICompatibleProvider


class GroqProvider(OpenAICompatibleProvider):
    name = "groq"
    max_tokens_field = "max_completion_tokens"
