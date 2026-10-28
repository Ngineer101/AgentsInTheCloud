import { afterEach, describe, expect, test } from "bun:test";
import { entireWorkspacePlaceholder, parseEntireToken, searchEntireRepositories, validateEntireToken } from "../src/index.ts";

const originalFetch = globalThis.fetch;
interface Claims { aud: string | string[]; exp?: number; handle?: string }
const jwt = (claims: Claims) => `${Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT" })).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
const token = jwt({ aud: ["https://eu.auth.entire.io"], exp: 4102444800, handle: "someone" });

function stubFetch(handler: (url: URL, headers: Headers) => Response): URL[] {
  const requests: URL[] = [];
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push(url);
    return handler(url, new Headers(init?.headers));
  }, { preconnect: originalFetch.preconnect });
  return requests;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Entire tokens", () => {
  test("talk to the API of the login server they were issued for", () => {
    expect(parseEntireToken(token)).toEqual({ apiBase: "https://eu.auth.entire.io/api/v1", audience: "https://eu.auth.entire.io", expiresAt: 4102444800_000 });
    // Opaque audiences such as the OAuth client id are skipped.
    expect(parseEntireToken(jwt({ aud: ["entire-cli", "https://us.auth.entire.io"] }))?.apiBase).toBe("https://us.auth.entire.io/api/v1");
  });

  test("are never sent anywhere but an https://*.entire.io origin", () => {
    expect(parseEntireToken(jwt({ aud: "https://evil.example.com" }))).toBeUndefined();
    expect(parseEntireToken(jwt({ aud: "http://eu.auth.entire.io" }))).toBeUndefined();
    expect(parseEntireToken(jwt({ aud: "https://eu.auth.entire.io.evil.test" }))).toBeUndefined();
    expect(parseEntireToken(jwt({ aud: "https://eu.auth.entire.io/redirect" }))).toBeUndefined();
    expect(parseEntireToken("not-a-jwt")).toBeUndefined();
  });

  test("get a workspace stand-in that carries only the audience", () => {
    const placeholder = entireWorkspacePlaceholder({ token }, "AGENTSINTHECLOUD_PROXY_READY_ENTIRE_TOKEN");
    const [header, claims, signature] = placeholder.split(".");
    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({ alg: "EdDSA", typ: "JWT" });
    expect(JSON.parse(Buffer.from(claims!, "base64url").toString())).toEqual({ aud: ["https://eu.auth.entire.io"] });
    expect(signature).toBe("AGENTSINTHECLOUD_PROXY_READY_ENTIRE_TOKEN");
  });
});

describe("Entire credential validation", () => {
  test("uses the regional profile for the commit identity", async () => {
    const requests = stubFetch((_url, headers) => {
      expect(headers.get("authorization")).toBe(`Bearer ${token}`);
      return Response.json({ global: { handle: "someone", displayName: "Global Name" }, regional: { displayName: "Some One", email: "some@example.com" } });
    });
    expect(await validateEntireToken(token)).toEqual({ ok: true, identity: { name: "Some One", email: "some@example.com" } });
    expect(requests.map(String)).toEqual(["https://eu.auth.entire.io/api/v1/me"]);
  });

  test("falls back to the linked GitHub noreply address", async () => {
    stubFetch(() => Response.json({ global: { handle: "someone", handles: [{ provider: "github", handle: "someone", providerUserId: "42" }] } }));
    expect(await validateEntireToken(token)).toEqual({ ok: true, identity: { name: "someone", email: "42+someone@users.noreply.github.com" } });
  });

  test("rejects expired tokens without calling Entire", async () => {
    const requests = stubFetch(() => Response.json({}));
    expect(await validateEntireToken(jwt({ aud: "https://eu.auth.entire.io", exp: 1 }))).toEqual({ ok: false, message: "That token has expired. Run entire auth token again." });
    expect(requests).toEqual([]);
  });
});

describe("Entire repository search", () => {
  test("clones native repositories and GitHub mirrors through their placements", async () => {
    const requests = stubFetch(() => Response.json({ repos: [
      { full_name: "project/native", provider: "entire", visibility: "private", clusterSlug: "aws-us-east-2", placements: [{ clusterSlug: "aws-eu-central-1", mirror: false, status: "ready" }] },
      { full_name: "octo/mirror", provider: "github", visibility: "public", placements: [{ clusterSlug: "aws-us-east-2", mirror: true, status: "ready" }] },
      { full_name: "project/provisioning", provider: "entire", placements: [] },
    ] }));
    expect(await searchEntireRepositories("re", { token })).toEqual({ repositories: [
      { fullName: "project/native", description: null, private: true, cloneUrl: "entire://aws-eu-central-1.entire.io/et/project/native", personal: true },
      { fullName: "octo/mirror", description: null, private: false, cloneUrl: "entire://aws-us-east-2.entire.io/gh/octo/mirror", personal: true },
    ] });
    expect(requests.map(String)).toEqual(["https://eu.auth.entire.io/api/v1/repos?q=re&pageSize=25"]);
  });

  test("asks to reconnect once the token expires", async () => {
    expect(await searchEntireRepositories("re", { token: jwt({ aud: "https://eu.auth.entire.io", exp: 1 }) })).toEqual({ repositories: [], notice: "Your Entire token has expired. Connect Entire again." });
  });
});
