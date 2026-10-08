// Optional Claude integration. When ANTHROPIC_API_KEY is set the operator uses Claude to read
// free-form requests and as a fallback reader for invoices its parser cannot handle. Without a
// key, it uses its built-in interpreter, so the demo runs offline and deterministically.
const MODEL = process.env.LEDGERHAND_MODEL || 'claude-sonnet-5-5';

export const llmEnabled = () => Boolean(process.env.ANTHROPIC_API_KEY);

export async function askJson(system, user, { maxTokens = 800 } = {}) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system: system + '\nRespond with a single JSON object and nothing else.', messages: [{ role: 'user', content: user }] }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  const text = body.content.map((c) => c.text || '').join('');
  return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
}
