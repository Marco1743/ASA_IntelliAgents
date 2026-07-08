import 'dotenv/config';
import OpenAI from 'openai';

// Thin wrapper around the hosted LLM (OpenAI-compatible API). The client is
// injectable so the agent can be tested with a fake.
export class LlmClient {

    constructor(opts = {}) {
        this.model = opts.model || process.env.LLM_MODEL || 'llama-3.3-70b-lmstudio';
        this.defaultTemperature = opts.temperature ?? 0.1;
        this._client = opts.client || new OpenAI({
            baseURL: opts.baseURL || process.env.LITELLM_BASE_URL || 'https://llm.bears.disi.unitn.it/v1',
            apiKey:  opts.apiKey  || process.env.LITELLM_API_KEY
        });
    }

    async chat(messages, { temperature = this.defaultTemperature } = {}) {
        const res = await this._client.chat.completions.create({ model: this.model, messages, temperature });
        return res.choices?.[0]?.message?.content ?? '';
    }
}
