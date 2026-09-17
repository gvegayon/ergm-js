# Agent Contribution Attribution and Delivery Workflow

Agents must attribute their own substantive work before submitting it.

- Every commit an agent creates must include a `Co-authored-by:` trailer with
  the agent's name and email address. For example:

  ```text
  Co-authored-by: OpenAI Codex <noreply@openai.com>
  ```

- Every pull request an agent creates or materially updates must include the
  same `Co-authored-by:` line in its description for each contributing agent.
- Do not add attribution for agents that did not contribute to the commit or
  pull request.

# Pull Request Workflow

Unless the user explicitly requests a different delivery method (for example,
directly committing to `main` or making no pull request), AI agents must use
the project pull-request workflow for substantive additions or changes:

1. Work on a dedicated branch, normally prefixed with `codex/`.
2. Run the relevant checks before submitting the work.
3. Commit and push the branch, including the required co-author trailer.
4. Open or update a pull request that explains the user-facing effect, the
   implementation, related issues, and validation performed.

The pull request description must also include the required `Co-authored-by:`
line for every AI agent that made a substantive contribution. Do not bypass
this workflow merely because an issue is small; only an explicit user
instruction authorizes an exception.
