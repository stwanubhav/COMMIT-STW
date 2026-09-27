const axios = require('axios');

const HF_API_BASE = 'https://api-inference.huggingface.co/models';

// Model used for commit message generation (summarization / text2text)
const COMMIT_MSG_MODEL = 'Salesforce/codet5-base-codegen';
// Fallback: a general summarization model that's always warm
const FALLBACK_MODEL = 'facebook/bart-large-cnn';

/**
 * HuggingFace Inference API wrapper.
 * Generates intelligent commit messages for individual files.
 */
class HuggingFaceClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.headers = {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    };
  }

  // ── Core inference call ──────────────────────────────────────────────────────

  /**
   * Call a HuggingFace inference endpoint.
   * Retries once if the model is loading (503).
   */
  async query(model, payload, retries = 2) {
    const url = `${HF_API_BASE}/${model}`;
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const response = await axios.post(url, payload, {
          headers: this.headers,
          timeout: 30000
        });
        return response.data;
      } catch (err) {
        const status = err.response?.status;
        const isLoading = status === 503;
        const isLast = attempt === retries;

        if (isLoading && !isLast) {
          // Model is warming up — wait and retry
          const waitMs = (err.response?.data?.estimated_time || 20) * 1000;
          await this._sleep(Math.min(waitMs, 25000));
          continue;
        }
        throw err;
      }
    }
  }

  // ── Commit message generation ────────────────────────────────────────────────

  /**
   * Generate a concise, meaningful commit message for a single file.
   *
   * @param {string} filePath    - e.g. "src/utils/parser.js"
   * @param {string} fileContent - Raw text content of the file
   * @param {string} extension   - e.g. ".js", ".py"
   * @returns {string} Commit message
   */
  async generateCommitMessage(filePath, fileContent, extension) {
    // Trim content — HF models have token limits
    const snippet = this._trimContent(fileContent, 800);
    const prompt = this._buildPrompt(filePath, snippet, extension);

    try {
      // Try summarization approach with BART (most reliable)
      const result = await this.query(FALLBACK_MODEL, {
        inputs: prompt,
        parameters: {
          max_new_tokens: 60,
          min_length: 10,
          do_sample: false
        }
      });

      const summary = Array.isArray(result)
        ? result[0]?.summary_text
        : result?.summary_text;

      if (summary && summary.trim().length > 5) {
        return this._cleanCommitMessage(summary, filePath);
      }
    } catch (_err) {
      // Fall through to heuristic generator
    }

    // Heuristic fallback — always works offline
    return this._heuristicCommitMessage(filePath, fileContent, extension);
  }

  /**
   * Analyse an entire project summary (all filenames) to generate a
   * repository-level description for the initial commit or README.
   */
  async analyseProject(filePaths) {
    const fileList = filePaths.slice(0, 50).join('\n');
    const prompt =
      `Summarize this software project based on its file structure in 2 sentences:\n${fileList}`;

    try {
      const result = await this.query(FALLBACK_MODEL, {
        inputs: prompt,
        parameters: { max_new_tokens: 80, do_sample: false }
      });
      const summary = Array.isArray(result)
        ? result[0]?.summary_text
        : result?.summary_text;
      return summary || 'Software project with multiple modules.';
    } catch {
      return 'Auto-committed project files.';
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  _buildPrompt(filePath, snippet, extension) {
    const lang = this._extToLang(extension);
    return (
      `File: ${filePath}\nLanguage: ${lang}\n\n` +
      `Code:\n${snippet}\n\n` +
      `Write a concise git commit message describing what this file does:`
    );
  }

  _trimContent(content, maxChars) {
    if (content.length <= maxChars) return content;
    return content.substring(0, maxChars) + '\n... [truncated]';
  }

  _cleanCommitMessage(raw, filePath) {
    let msg = raw.trim().replace(/\n+/g, ' ');
    // Remove any leading "summary:" or "commit:" prefixes
    msg = msg.replace(/^(summary|commit|message|add|update|feat|fix):\s*/i, '');
    // Capitalize first letter
    msg = msg.charAt(0).toUpperCase() + msg.slice(1);
    // Ensure it ends properly
    if (!msg.endsWith('.')) msg += '';
    // Hard limit
    if (msg.length > 120) msg = msg.substring(0, 117) + '...';
    return msg || `Add ${filePath}`;
  }

  _heuristicCommitMessage(filePath, content, extension) {
    const filename = filePath.split('/').pop();
    const name = filename.replace(/\.[^.]+$/, '');
    const lang = this._extToLang(extension);

    // Check for common patterns in content
    const isTest = /test|spec/i.test(filePath) || /describe\(|it\(|test\(/i.test(content);
    const isConfig = /config|\.env|\.json|\.yaml|\.yml|\.toml/i.test(filePath);
    const isStyle = /\.css|\.scss|\.sass|\.less/i.test(filePath);
    const isReadme = /readme/i.test(filePath);
    const hasClass = /class\s+\w+/i.test(content);
    const hasFunctions = (content.match(/function\s+\w+|=>\s*{|def\s+\w+/g) || []).length;

    if (isReadme) return `Add project README documentation`;
    if (isTest) return `Add ${lang} tests for ${name}`;
    if (isConfig) return `Add configuration file: ${filename}`;
    if (isStyle) return `Add styles for ${name}`;
    if (hasClass) return `Add ${name} class implementation`;
    if (hasFunctions > 3) return `Add ${name} utility module with ${hasFunctions} functions`;
    if (hasFunctions > 0) return `Add ${name} ${lang} module`;
    return `Add ${filename}`;
  }

  _extToLang(ext) {
    const map = {
      '.js': 'JavaScript', '.ts': 'TypeScript', '.jsx': 'React JSX',
      '.tsx': 'React TSX', '.py': 'Python', '.java': 'Java',
      '.cs': 'C#', '.cpp': 'C++', '.c': 'C', '.go': 'Go',
      '.rs': 'Rust', '.rb': 'Ruby', '.php': 'PHP', '.swift': 'Swift',
      '.kt': 'Kotlin', '.html': 'HTML', '.css': 'CSS', '.scss': 'SCSS',
      '.json': 'JSON', '.yaml': 'YAML', '.yml': 'YAML', '.md': 'Markdown',
      '.sh': 'Shell', '.bat': 'Batch', '.ps1': 'PowerShell',
      '.sql': 'SQL', '.r': 'R', '.dart': 'Dart', '.vue': 'Vue'
    };
    return map[ext?.toLowerCase()] || 'code';
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

module.exports = { HuggingFaceClient };
