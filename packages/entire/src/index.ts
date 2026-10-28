import { parseGitHostingResponse, readGitHostingCredentialFile, removeGitHostingCredentialFile, writeGitHostingCredentialFile, type GitHostingCredential, type GitHostingProvider, type GitHostingRepository, type GitHostingRepositorySearch, type GitHostingValidation } from "@agents-in-the-cloud/core";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const tokenFile = "entire-token";

// Entire login tokens are JWTs whose audience is the account's home login server, which also serves the API.
const tokenClaimsSchema = Type.Object({
  aud: Type.Union([Type.String(), Type.Array(Type.String())]),
  exp: Type.Optional(Type.Number()),
});

const meResponseSchema = Type.Object({
  global: Type.Object({
    handle: Type.String({ minLength: 1 }),
    displayName: Type.Optional(Type.String()),
    handles: Type.Optional(Type.Array(Type.Object({ provider: Type.String(), handle: Type.String(), providerUserId: Type.String() }))),
  }),
  regional: Type.Optional(Type.Object({
    displayName: Type.Optional(Type.String()),
    email: Type.Optional(Type.String()),
  })),
});

const reposResponseSchema = Type.Object({
  repos: Type.Array(Type.Object({
    full_name: Type.String(),
    provider: Type.String(),
    visibility: Type.Optional(Type.String()),
    clusterSlug: Type.Optional(Type.String()),
    placements: Type.Optional(Type.Array(Type.Object({ clusterSlug: Type.String(), mirror: Type.Boolean(), status: Type.String() }))),
  })),
});

interface EntireToken {
  apiBase: string;
  audience: string;
  expiresAt: number | undefined;
}

type TokenClaims = Static<typeof tokenClaimsSchema>;

function decodeClaims(segment: string): TokenClaims | undefined {
  try {
    const claims: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    return Value.Check(tokenClaimsSchema, claims) ? claims : undefined;
  } catch {
    return undefined;
  }
}

function base64UrlJson(json: string): string {
  return Buffer.from(json).toString("base64url");
}

/** Undefined unless the token is a JWT for an https://*.entire.io login server: the token is only ever sent there. */
export function parseEntireToken(token: string): EntireToken | undefined {
  const segments = token.trim().split(".");
  if (segments.length !== 3) return undefined;
  const claims = decodeClaims(segments[1]!);
  if (!claims) return undefined;
  for (const audience of [claims.aud].flat()) {
    let url: URL;
    try {
      url = new URL(audience);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" || !url.hostname.endsWith(".entire.io") || url.pathname !== "/" || url.search || url.username) return undefined;
    return { apiBase: `${url.origin}/api/v1`, audience: url.origin, expiresAt: claims.exp === undefined ? undefined : claims.exp * 1000 };
  }
  return undefined;
}

function headers(token: string): HeadersInit {
  return { accept: "application/json", "user-agent": "agents-in-the-cloud", authorization: `Bearer ${token}` };
}

function optionalTrimmed(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

export async function validateEntireToken(token: string, now = Date.now()): Promise<GitHostingValidation> {
  const trimmed = token.trim();
  if (!trimmed) return { ok: false, message: "Paste the output of entire auth token." };
  const parsed = parseEntireToken(trimmed);
  if (!parsed) return { ok: false, message: "That doesn’t look like an Entire token. Paste the output of entire auth token." };
  if (parsed.expiresAt !== undefined && parsed.expiresAt <= now) return { ok: false, message: "That token has expired. Run entire auth token again." };

  let response: Response;
  try {
    response = await fetch(`${parsed.apiBase}/me`, { headers: headers(trimmed) });
  } catch {
    return { ok: false, message: "Could not reach Entire. Check your network and try again." };
  }
  if (response.status === 401) return { ok: false, message: "Entire rejected that token. Run entire auth token again." };
  if (!response.ok) return { ok: false, message: `Entire token validation failed (${response.status}). Try again.` };

  const body = await parseGitHostingResponse(response, meResponseSchema);
  if (!body) return { ok: false, message: "Entire returned an invalid account response. Try again." };
  const handle = body.global.handle.trim();
  const name = optionalTrimmed(body.regional?.displayName) ?? optionalTrimmed(body.global.displayName) ?? handle;
  const github = body.global.handles?.find((linked) => linked.provider === "github");
  const email = optionalTrimmed(body.regional?.email) ?? (github ? `${github.providerUserId}+${github.handle}@users.noreply.github.com` : undefined);
  if (!email) return { ok: false, message: "Your Entire account has no email address for commits. Add one on entire.com and try again." };
  return { ok: true, identity: { name, email } };
}

/** The entire:// remote that git-remote-entire clones, preferring a repository's primary placement. */
function cloneUrl(repo: Static<typeof reposResponseSchema>["repos"][number]): string | undefined {
  const placement = repo.placements?.find((candidate) => !candidate.mirror && candidate.status === "ready") ?? repo.placements?.find((candidate) => candidate.status === "ready");
  const cluster = placement?.clusterSlug ?? repo.clusterSlug;
  if (!cluster || !/^[a-z0-9-]+$/.test(cluster)) return undefined;
  const namespace = repo.provider === "github" ? "gh" : "et";
  return `entire://${cluster}.entire.io/${namespace}/${repo.full_name}`;
}

export async function searchEntireRepositories(query: string, credential: GitHostingCredential | undefined): Promise<GitHostingRepositorySearch> {
  if (!credential) return { repositories: [], notice: "Connect Entire to search your repositories." };
  const parsed = parseEntireToken(credential.token);
  if (!parsed) return { repositories: [], notice: "Your Entire token is invalid. Connect Entire again." };
  if (parsed.expiresAt !== undefined && parsed.expiresAt <= Date.now()) return { repositories: [], notice: "Your Entire token has expired. Connect Entire again." };

  const url = new URL(`${parsed.apiBase}/repos`);
  url.searchParams.set("q", query.trim());
  url.searchParams.set("pageSize", "25");
  const response = await fetch(url, { headers: headers(credential.token) });
  if (response.status === 401) return { repositories: [], notice: "Entire rejected your token. Connect Entire again." };
  if (!response.ok) throw new Error(`Entire repository search failed: ${response.status} ${await response.text()}`);
  const body = await parseGitHostingResponse(response, reposResponseSchema);
  if (!body) throw new Error("Entire returned an invalid repository search response");
  return {
    repositories: body.repos.flatMap((repo): GitHostingRepository[] => {
      const url = cloneUrl(repo);
      return url ? [{ fullName: repo.full_name, description: null, private: repo.visibility !== "public", cloneUrl: url, personal: true }] : [];
    }),
  };
}

/**
 * git-remote-entire reads the token's audience before it sends anything, so workspaces get a JWT-shaped stand-in
 * carrying only the real audience. The egress proxy swaps the whole stand-in for the real token.
 */
export function entireWorkspacePlaceholder(credential: GitHostingCredential, placeholder: string): string {
  const parsed = parseEntireToken(credential.token);
  if (!parsed) return placeholder;
  return `${base64UrlJson(JSON.stringify({ alg: "EdDSA", typ: "JWT" }))}.${base64UrlJson(JSON.stringify({ aud: [parsed.audience] }))}.${placeholder}`;
}

export const entireProvider: GitHostingProvider = {
  id: "entire",
  label: "Entire",
  // Entire remotes use entire:// URLs; git-remote-entire sends ENTIRE_TOKEN itself.
  tokenEnvVar: "ENTIRE_TOKEN",
  tokenEnvAliases: [],
  tokenHosts: ["*.entire.io"],
  sshKnownHosts: "",
  connectForm: {
    instructionsHtml: `<p>Run this on a computer where you’re logged in to <a class="settings-link" href="https://docs.entire.com/installation.md" target="_blank" rel="noopener noreferrer">Entire</a>:</p>
    <pre class="settings-command">entire auth token</pre>
    <p>Paste the token below. It lasts 8 hours, so you’ll need to connect again after that.</p>`,
    tokenPlaceholder: "Paste output from entire auth token",
  },
  credential() {
    const token = readGitHostingCredentialFile(tokenFile);
    return token ? { token } : undefined;
  },
  saveCredential(credential) {
    writeGitHostingCredentialFile(tokenFile, `${credential.token.trim()}\n`);
  },
  clearCredential() {
    removeGitHostingCredentialFile(tokenFile);
  },
  workspacePlaceholder: entireWorkspacePlaceholder,
  workspaceEnv: () => ({}),
  validateCredential: (credential) => validateEntireToken(credential.token),
  searchRepositories: searchEntireRepositories,
};
