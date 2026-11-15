from app.services.llm.openai_compat import OpenAICompatibleProvider


class LocalProvider(OpenAICompatibleProvider):
    name = "local_llm"
    is_cloud = False
