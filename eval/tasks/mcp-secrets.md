# MCP secret env

MCP plugins spawn with `pluginEnv(permissions)`. Unless `permissions.secrets` is true, API keys and tokens from the host process env must not appear in the child.
