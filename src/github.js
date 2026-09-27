const { Octokit } = require('@octokit/rest');

/**
 * GitHub API wrapper.
 * Handles repo validation, branch management, and per-file commits.
 */
class GitHubClient {
  constructor(token) {
    this.octokit = new Octokit({ auth: token });
    this.owner = null;
    this.repo = null;
  }

  // ── Auth & repo setup ────────────────────────────────────────────────────────

  /** Verify the token and return the authenticated user's login. */
  async getAuthenticatedUser() {
    const { data } = await this.octokit.users.getAuthenticated();
    return data.login;
  }

  /**
   * Parse "owner/repo" or just "repo" (uses authenticated user as owner).
   * Sets this.owner and this.repo.
   */
  async resolveRepo(repoInput) {
    if (repoInput.includes('/')) {
      const [owner, repo] = repoInput.split('/');
      this.owner = owner.trim();
      this.repo = repo.trim();
    } else {
      this.owner = await this.getAuthenticatedUser();
      this.repo = repoInput.trim();
    }
    return { owner: this.owner, repo: this.repo };
  }

  /** Get repo info — throws if repo doesn't exist / token has no access. */
  async getRepoInfo() {
    const { data } = await this.octokit.repos.get({
      owner: this.owner,
      repo: this.repo
    });
    return data;
  }

  /**
   * Create the repo if it doesn't exist yet.
   * Returns the repo data object.
   */
  async ensureRepoExists(isPrivate = false, description = '') {
    try {
      return await this.getRepoInfo();
    } catch (err) {
      if (err.status === 404) {
        const { data } = await this.octokit.repos.createForAuthenticatedUser({
          name: this.repo,
          private: isPrivate,
          description,
          auto_init: true // creates default branch with initial commit
        });
        return data;
      }
      throw err;
    }
  }

  // ── Branch helpers ───────────────────────────────────────────────────────────

  /** Return the SHA of the HEAD commit on the default branch. */
  async getDefaultBranchSha() {
    const repoInfo = await this.getRepoInfo();
    const branch = repoInfo.default_branch;
    const { data } = await this.octokit.repos.getBranch({
      owner: this.owner,
      repo: this.repo,
      branch
    });
    return { sha: data.commit.sha, branch };
  }

  // ── File operations ──────────────────────────────────────────────────────────

  /**
   * Get the current SHA of a file (needed for updates).
   * Returns null if the file doesn't exist yet.
   */
  async getFileSha(filePath) {
    try {
      const { data } = await this.octokit.repos.getContent({
        owner: this.owner,
        repo: this.repo,
        path: filePath
      });
      return data.sha;
    } catch (err) {
      if (err.status === 404) return null;
      throw err;
    }
  }

  /**
   * Commit a single file to the repository.
   *
   * @param {string} filePath     - Repo-relative path e.g. "src/index.js"
   * @param {Buffer|string} content - Raw file content
   * @param {string} commitMessage - Commit message (from AI or fallback)
   * @returns {object} commit data
   */
  async commitFile(filePath, content, commitMessage) {
    // GitHub API requires base64-encoded content
    const contentBase64 = Buffer.isBuffer(content)
      ? content.toString('base64')
      : Buffer.from(content).toString('base64');

    // Check if file already exists (need SHA for updates)
    const existingSha = await this.getFileSha(filePath);

    const params = {
      owner: this.owner,
      repo: this.repo,
      path: filePath,
      message: commitMessage,
      content: contentBase64
    };

    if (existingSha) {
      params.sha = existingSha; // required for updating an existing file
    }

    const { data } = await this.octokit.repos.createOrUpdateFileContents(params);
    return data;
  }

  /**
   * List all files currently in the repo (flat list of paths).
   * Used to decide create vs update.
   */
  async listAllFiles(treeSha = null) {
    if (!treeSha) {
      const { sha } = await this.getDefaultBranchSha();
      treeSha = sha;
    }

    const { data } = await this.octokit.git.getTree({
      owner: this.owner,
      repo: this.repo,
      tree_sha: treeSha,
      recursive: '1'
    });

    return data.tree
      .filter((item) => item.type === 'blob')
      .map((item) => item.path);
  }

  /** Validate that the token has write access to this repo. */
  async validateAccess() {
    const user = await this.getAuthenticatedUser();
    const repoInfo = await this.getRepoInfo();
    const hasAccess = repoInfo.permissions?.push === true;
    return { user, hasAccess, repoInfo };
  }
}

module.exports = { GitHubClient };
