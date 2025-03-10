// Copyright (c) 2024 Cloudflare, Inc.
// Licensed under the MIT license found in the LICENSE file or at https://opensource.org/licenses/MIT

type Env = {
  OPENROUTER_API_KEY: string;
};

interface ChatMessage {
  role: string;
  content: string;
}

interface RequestBody {
  model?: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  [key: string]: unknown;
}

const DEBUG = false; // set as true to see debug logs
const MODEL = "google/gemini-2.0-pro-exp-02-05:free"; // default model
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

function owrLog(...args: unknown[]) {
  if (DEBUG) {
    console.log("[owr]", ...args);
  }
}

function owrError(...args: unknown[]) {
  console.error("[owr error]", ...args);
}

async function handleStream(
  request: Request,
  env: Env,
  ctx: ExecutionContext
): Promise<Response> {
  const apiKey = env.OPENROUTER_API_KEY;

  if (!apiKey) {
    owrError(
      "Missing OpenRouter API key. Did you forget to set OPENROUTER_API_KEY in .dev.vars (for local dev) or with wrangler secret put OPENROUTER_API_KEY (for production)?"
    );
    return new Response("Missing API key", { status: 401 });
  }

  // Parse the incoming request body
  let requestBody: RequestBody;
  try {
    requestBody = await request.json() as RequestBody;
  } catch (e) {
    owrError("Error parsing request body", e);
    return new Response("Invalid request body", { status: 400 });
  }

  // Prepare the request to OpenRouter
  const { messages, model: requestModel, ...restOfBody } = requestBody;
  const payload = {
    model: requestModel || MODEL,
    messages,
    stream: true,
    ...restOfBody,
  };

  // Create transform stream to handle SSE data
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();
  const encoder = new TextEncoder();

  // Make request to OpenRouter
  try {
    const response = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": request.headers.get("origin") || "https://localhost",
        "X-Title": "OpenRouter Relay"
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const error = await response.text();
      owrError("OpenRouter API error", error);
      return new Response(`OpenRouter API error: ${error}`, { status: response.status });
    }

    if (!response.body) {
      throw new Error("No response body");
    }

    // Process the stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    // Read the stream
    const processStream = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            await writer.close();
            break;
          }

          buffer += decoder.decode(value, { stream: true });

          // Process complete lines
          let lineEnd;
          while ((lineEnd = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, lineEnd).trim();
            buffer = buffer.slice(lineEnd + 1);

            if (line.startsWith("data: ")) {
              const data = line.slice(6);
              
              if (data === "[DONE]") {
                continue;
              }

              try {
                const parsed = JSON.parse(data);
                await writer.write(encoder.encode(`data: ${JSON.stringify(parsed)}\n\n`));
              } catch (e) {
                owrError("Error parsing SSE data", e);
              }
            }
          }
        }
      } catch (e) {
        owrError("Error processing stream", e);
        await writer.abort(e);
      }
    };

    // Start processing the stream
    ctx.waitUntil(processStream());

    // Return the stream
    return new Response(stream.readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  } catch (e) {
    owrError("Error making request to OpenRouter", e);
    return new Response("Error making request to OpenRouter", { status: 500 });
  }
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    // Only accept POST requests
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    return handleStream(request, env, ctx);
  },
};
