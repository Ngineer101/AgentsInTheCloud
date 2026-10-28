import { createGitHostingCache, parseGitHostingResponse, readGitHostingCredentialFile, removeGitHostingCredentialFile, writeGitHostingCredentialFile, type GitHostingCredential, type GitHostingProvider, type GitHostingRepository, type GitHostingRepositorySearch, type GitHostingValidation } from "@agents-in-the-cloud/core";
import { Type, type Static, type TSchema } from "typebox";
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
    visibility: Type.String(),
    placements: Type.Array(Type.Object({ clusterSlug: Type.String(), mirror: Type.Boolean(), status: Type.String() })),
  })),
});

const clustersResponseSchema = Type.Object({
  clusters: Type.Array(Type.Object({ slug: Type.String(), publicUrl: Type.String() })),
});

interface EntireToken {
  /** The home login server, which also serves the API. */
  origin: string;
  expired: boolean;
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

/** The https://*.entire.io origin of a URL, or undefined: tokens are only ever sent there. */
function entireOrigin(value: string): string | undefined {
  const url = URL.parse(value);
  return url?.protocol === "https:" && url.hostname.endsWith(".entire.io") && url.pathname === "/" && !url.search && !url.username ? url.origin : undefined;
}

/** Undefined unless the token is a JWT for an Entire login server. Opaque audiences such as the OAuth client id are skipped. */
export function parseEntireToken(token: string): EntireToken | undefined {
  const segments = token.trim().split(".");
  const claims = segments.length === 3 ? decodeClaims(segments[1]!) : undefined;
  const audience = claims && [claims.aud].flat().find((candidate) => URL.canParse(candidate));
  const origin = audience && entireOrigin(audience);
  return origin ? { origin, expired: claims.exp !== undefined && claims.exp * 1000 <= Date.now() } : undefined;
}

function headers(token: string): HeadersInit {
  return { accept: "application/json", "user-agent": "agents-in-the-cloud", authorization: `Bearer ${token}` };
}

function optionalTrimmed(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

export async function validateEntireToken(token: string): Promise<GitHostingValidation> {
  const trimmed = token.trim();
  if (!trimmed) return { ok: false, message: "Paste the output of entire auth token." };
  const parsed = parseEntireToken(trimmed);
  if (!parsed) return { ok: false, message: "That doesn’t look like an Entire token. Paste the output of entire auth token." };
  if (parsed.expired) return { ok: false, message: "That token has expired. Run entire auth token again." };

  let response: Response;
  try {
    response = await fetch(`${parsed.origin}/api/v1/me`, { headers: headers(trimmed) });
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

type EntireRepository = Static<typeof reposResponseSchema>["repos"][number];

/** The entire:// remote git-remote-entire clones: a native repository's primary placement, or any ready GitHub mirror. */
function cloneUrl(repo: EntireRepository, clusterHosts: ReadonlyMap<string, string>): string | undefined {
  const ready = repo.placements.filter((placement) => placement.status === "ready");
  const placement = ready.find((candidate) => !candidate.mirror) ?? ready[0];
  const host = placement && clusterHosts.get(placement.clusterSlug);
  return host ? `entire://${host}/${repo.provider === "github" ? "gh" : "et"}/${repo.full_name}` : undefined;
}

class EntireAccessError extends Error {}

async function fetchEntire<Schema extends TSchema>(origin: string, path: string, token: string, schema: Schema): Promise<Static<Schema>> {
  const response = await fetch(`${origin}/api/v1${path}`, { headers: headers(token) });
  if (response.status === 401) throw new EntireAccessError();
  if (!response.ok) throw new Error(`Entire ${path} failed: ${response.status} ${await response.text()}`);
  const body = await parseGitHostingResponse(response, schema);
  if (!body) throw new Error(`Entire returned an invalid ${path} response`);
  return body;
}

const clusterCache = createGitHostingCache<ReadonlyMap<string, string>>(10 * 60_000);

/** Cluster slug to clone host, keeping only clusters whose public URL is an Entire origin. */
async function loadClusterHosts(origin: string, token: string): Promise<ReadonlyMap<string, string>> {
  const { clusters } = await fetchEntire(origin, "/clusters", token, clustersResponseSchema);
  return new Map(clusters.flatMap((cluster) => {
    const clusterOrigin = entireOrigin(cluster.publicUrl);
    return clusterOrigin ? [[cluster.slug, new URL(clusterOrigin).host] as const] : [];
  }));
}

export async function searchEntireRepositories(query: string, credential: GitHostingCredential | undefined): Promise<GitHostingRepositorySearch> {
  if (!credential) return { repositories: [], notice: "Connect Entire to search your repositories." };
  const parsed = parseEntireToken(credential.token);
  if (!parsed || parsed.expired) return { repositories: [], notice: "Your Entire token has expired. Connect Entire again." };
  const { origin } = parsed;
  try {
    const [clusterHosts, { repos }] = await Promise.all([
      clusterCache(credential, "clusters", () => loadClusterHosts(origin, credential.token)),
      fetchEntire(origin, `/repos?${new URLSearchParams({ q: query, pageSize: "25" })}`, credential.token, reposResponseSchema),
    ]);
    return {
      repositories: repos.flatMap((repo): GitHostingRepository[] => {
        const url = cloneUrl(repo, clusterHosts);
        return url ? [{ fullName: repo.full_name, description: null, private: repo.visibility !== "public", cloneUrl: url, personal: true }] : [];
      }),
    };
  } catch (error) {
    if (error instanceof EntireAccessError) return { repositories: [], notice: "Entire rejected your token. Connect Entire again." };
    throw error;
  }
}

// git-remote-entire refuses unsigned (alg: none) tokens without verifying signatures, so the stand-in claims EdDSA.
const placeholderHeader = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT" })).toString("base64url");

/**
 * git-remote-entire reads the token's audience before it sends anything, so workspaces get a JWT-shaped stand-in
 * carrying only the real audience. The egress proxy swaps the whole stand-in for the real token.
 */
export function entireWorkspacePlaceholder(credential: GitHostingCredential, placeholder: string): string {
  const parsed = parseEntireToken(credential.token);
  // A stored token that isn't an Entire token can't authenticate anyway; the plain placeholder fails just as visibly.
  if (!parsed) return placeholder;
  const claims = Buffer.from(JSON.stringify({ aud: [parsed.origin] })).toString("base64url");
  return `${placeholderHeader}.${claims}.${placeholder}`;
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
