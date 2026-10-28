import { existsSync } from "node:fs";
import { gitHostingCredentialPath, readGitHostingCredentialFile, removeGitHostingCredentialFile, writeGitHostingCredentialFile, type GitHostingProvider } from "@agents-in-the-cloud/core";
import { validateGitHubToken } from "./auth.ts";
import { gitHubKnownHosts } from "./host-keys.ts";
import { searchGitHubRepositories } from "./repository-search.ts";

// Keep the existing credential paths so older installations retain their GitHub connection.
const tokenFile = "github-token";
const disabledHostTokenFile = "github-token-disabled";

function discoverGitHubToken(): string | undefined {
  const stored = readGitHostingCredentialFile(tokenFile);
  if (stored) return stored;
  if (existsSync(gitHostingCredentialPath(disabledHostTokenFile))) return undefined;
  return process.env.GH_TOKEN?.trim() || undefined;
}

export const gitHubProvider: GitHostingProvider = {
  id: "github",
  label: "GitHub",
  httpsGit: { host: "github.com", username: "x-access-token" },
  tokenEnvVar: "GH_TOKEN",
  tokenEnvAliases: [],
  tokenHosts: ["github.com", "api.github.com"],
  sshKnownHosts: gitHubKnownHosts,
  connectForm: {
    instructionsHtml: `<p>Run these commands on your own computer:</p>
    <pre class="settings-command">gh auth login
gh auth token</pre>
    <p>Paste the token below.</p>`,
    tokenPlaceholder: "Paste output from gh auth token",
  },
  credential() {
    const token = discoverGitHubToken();
    return token ? { token } : undefined;
  },
  saveCredential(credential) {
    writeGitHostingCredentialFile(tokenFile, `${credential.token.trim()}\n`);
    removeGitHostingCredentialFile(disabledHostTokenFile);
  },
  clearCredential() {
    removeGitHostingCredentialFile(tokenFile);
    // A GH_TOKEN inherited from the host stays disconnected until a token is connected again.
    writeGitHostingCredentialFile(disabledHostTokenFile, "");
  },
  workspaceEnv: () => ({}),
  validateCredential: (credential) => validateGitHubToken(credential.token),
  searchRepositories: (query, credential) => searchGitHubRepositories(query, credential?.token),
};
