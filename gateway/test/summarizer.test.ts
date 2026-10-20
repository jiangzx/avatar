import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { QwenSummarizer } from '../src/session/qwenSummarizer.ts';

describe('QwenSummarizer', () => {
  const servers: Server[] = [];
  afterEach(async () => { for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve())); });

  it('sends user lines only and returns only the model content', async () => {
    let seen = '';
    const server = createServer((req, res) => {
      expect(req.method).toBe('POST');
      expect(req.headers.authorization).toBe('Bearer fixture-key');
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        seen = body;
        const payload = JSON.parse(body) as { model: string; messages: Array<{ role: string; content: string }> };
        expect(payload.model).toBe('fixture-model');
        expect(payload.messages.map((message) => message.role)).toEqual(['system', 'user']);
        expect(payload.messages[0]?.content).toContain('中文摘要');
        expect(payload.messages[1]?.content).toContain('fixture user');
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content: 'fixture summary' } }] }));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const summarizer = new QwenSummarizer({ apiKey: 'fixture-key', endpoint: `http://127.0.0.1:${port}/chat/completions`, model: 'fixture-model' });
    await expect(summarizer.summarize('', [
      { role: 'user', text: 'fixture user', ts: 1 },
      { role: 'assistant', text: 'fixture assistant', ts: 2 },
    ])).resolves.toBe('fixture summary');
    expect(seen).toContain('用户：fixture user');
    expect(seen).not.toContain('fixture assistant');
  });

  it('uses the Japanese system prompt when language is ja', async () => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const payload = JSON.parse(body) as { messages: Array<{ role: string; content: string }> };
        expect(payload.messages[0]?.content).toContain('日本語');
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content: 'fixture summary' } }] }));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const summarizer = new QwenSummarizer({ apiKey: 'fixture-key', endpoint: `http://127.0.0.1:${port}/chat/completions`, model: 'fixture-model', language: 'ja' });
    await expect(summarizer.summarize('', [{ role: 'user', text: 'fixture user', ts: 1 }])).resolves.toBe('fixture summary');
  });

  it('keeps the Chinese system prompt when language is zh', async () => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const payload = JSON.parse(body) as { messages: Array<{ role: string; content: string }> };
        expect(payload.messages[0]?.content).toContain('中文摘要');
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content: 'fixture summary' } }] }));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const summarizer = new QwenSummarizer({ apiKey: 'fixture-key', endpoint: `http://127.0.0.1:${port}/chat/completions`, model: 'fixture-model', language: 'zh' });
    await expect(summarizer.summarize('', [{ role: 'user', text: 'fixture user', ts: 1 }])).resolves.toBe('fixture summary');
  });

  it('rejects malformed or unsuccessful responses without exposing payloads', async () => {
    const server = createServer((_req, res) => { res.statusCode = 502; res.end('upstream detail'); });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const summarizer = new QwenSummarizer({ apiKey: 'fixture-key', endpoint: `http://127.0.0.1:${port}/chat/completions`, model: 'fixture-model', timeoutMs: 500 });
    await expect(summarizer.summarize('', [{ role: 'user', text: 'fixture user', ts: 1 }])).rejects.toThrow('summarizer_http_502');
  });
});
