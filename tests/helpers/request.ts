import { NextRequest } from "next/server";

interface RequestOptions {
  method?: string;
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
  searchParams?: Record<string, string>;
}

export function createRequest(
  path: string,
  options: RequestOptions = {}
): NextRequest {
  const {
    method = "GET",
    body,
    headers = {},
    cookies = {},
    searchParams = {},
  } = options;

  const url = new URL(path, "http://localhost:3000");
  for (const [key, value] of Object.entries(searchParams)) {
    url.searchParams.set(key, value);
  }

  const init: RequestInit & { headers: Record<string, string> } = {
    method,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  };

  if (body && method !== "GET") {
    init.body = JSON.stringify(body);
  }

  const request = new NextRequest(url, init);

  for (const [name, value] of Object.entries(cookies)) {
    request.cookies.set(name, value);
  }

  return request;
}

export function createAuthenticatedRequest(
  path: string,
  token: string,
  options: RequestOptions = {}
): NextRequest {
  return createRequest(path, {
    ...options,
    cookies: {
      "rbai-token": token,
      ...options.cookies,
    },
  });
}

export async function parseJsonResponse(response: Response) {
  return response.json();
}
