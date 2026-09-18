# Test runner

After any code change:

1. Detect the test command from AGENTS.md or package.json.
2. Run it with bash in the AgentWorkspace.
3. Do not claim apply_ready until the check exits 0.
