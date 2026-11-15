from app.services.llm.openai_compat import OpenAICompatibleProvider


class SambaNovaProvider(OpenAICompatibleProvider):
    name = "sambanova"
