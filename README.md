# Portero

A self-hosted MCP (Model Context Protocol) gateway that sits between Claude Code and multiple MCP servers, providing:

- **MCP Aggregation** — Connect multiple MCPs and expose them as one unified endpoint
- **Data Anonymization** — Bidirectional fake↔real data replacement for privacy
- **Async 2FA Approvals** — Non-blocking Telegram approval flow with task tracking
- **Permission Policies** — Allow/deny/require-approval per tool
- **Remote Access** — HTTPS endpoint accessible from anywhere

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    TELEGRAM BOT                             │
│  /status, /grant, /revoke, /tasks, approval callbacks       │
│  Executes approved tasks asynchronously                     │
└─────────────────────┬───────────────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────────────┐
│                      PORTERO                                │
│  ┌────────────────────────────────────────────────────────┐│
│  │ HTTP Server (Express)                                  ││
│  │ - POST /mcp/message (JSON-RPC, Bearer auth)           ││
│  │ - GET /health                                          ││
│  └────────────────────────────────────────────────────────┘│
│  ┌────────────────────────────────────────────────────────┐│
│  │ Middleware Pipeline                                    ││
│  │ 1. Anonymization (fake→real on requests)              ││
│  │ 2. Policy Check (allow/deny/require-approval)         ││
│  │ 3. If approval needed → create task, return pending   ││
│  │ 4. If allowed → route to child MCP immediately        ││
│  │ 5. Anonymization (real→fake on responses)             ││
│  └────────────────────────────────────────────────────────┘│
│  ┌────────────────────────────────────────────────────────┐│
│  │ Task Store (data/tasks.json)                          ││
│  │ pending-approval → approved → executing → completed   ││
│  └────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
                      │ stdio
        ┌─────────────┼─────────────┬─────────────┐
        ▼             ▼             ▼             ▼
   ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐
   │ MCP 1   │  │ MCP 2   │  │ MCP 3   │  │ MCP 4   │
   │(github) │  │(filesys)│  │(google) │  │(stripe) │
   └─────────┘  └─────────┘  └─────────┘  └─────────┘
```

## Prerequisites

- **Node.js 20+** (LTS recommended)
- **Telegram Bot** (create via [@BotFather](https://t.me/botfather))
- Your **Telegram Chat ID** (get from [@userinfobot](https://t.me/userinfobot))

## Quick Start

### 1. Clone and Install

```bash
git clone <your-repo-url>
cd portero
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env with your settings
```

**Required settings in `.env`:**

```bash
# Generate a secure token
BEARER_TOKEN=$(openssl rand -hex 32)

# Get from @BotFather
TELEGRAM_BOT_TOKEN=123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11

# Get from @userinfobot
TELEGRAM_ADMIN_CHAT_ID=123456789

# Your real info (for anonymization)
REAL_NAME="Your Name"
REAL_EMAIL="your@email.com"
```

### 3. Configure MCP Servers

Edit `config/mcps.json` to define which MCP servers to connect:

```json
{
  "mcps": [
    {
      "name": "filesystem",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
      "env": {}
    },
    {
      "name": "github",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}"
      }
    }
  ]
}
```

### 4. Configure Google Workspace (Optional)

To add Gmail, Calendar, and Drive integration via [workspace-mcp](https://github.com/taylorwilsdon/google_workspace_mcp):

1. **Create a Google Cloud project** at [console.cloud.google.com](https://console.cloud.google.com)
2. **Enable APIs**: Gmail API, Google Calendar API, Google Drive API
3. **Create OAuth 2.0 credentials**: APIs & Services → Credentials → Create Credentials → OAuth client ID → Desktop app
4. **Set environment variables** in `.env`:
   ```bash
   GOOGLE_OAUTH_CLIENT_ID=your-client-id.apps.googleusercontent.com
   GOOGLE_OAUTH_CLIENT_SECRET=your-client-secret
   ```
5. **First run**: The workspace-mcp server will open a browser for OAuth consent. Approve the requested scopes.
6. **Headless / Docker**: Run once locally to complete the OAuth flow, then copy the token cache into the container.

If `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` are not set, Portero will skip the Google MCP and start without it.

The Google tools appear as `google/send_email`, `google/list_events`, `google/search_files`, etc. Write operations (send, create, delete) require Telegram approval; reads are allowed by default. See `config/policies.json` for the full list.

### 5. Configure Notion (Optional)

To add Notion integration:

1. **Create a Notion integration** at [notion.so/my-integrations](https://www.notion.so/my-integrations)
2. **Copy the Internal Integration Secret** (starts with `ntn_`)
3. **Share pages/databases** with the integration: Open a page → ... → Connections → Add your integration
4. **Set environment variable** in `.env`:
   ```bash
   NOTION_API_TOKEN=ntn_your-token-here
   ```

If `NOTION_API_TOKEN` is not set, Portero will skip the Notion MCP and start without it. Read operations (search, retrieve pages/blocks) are allowed by default; write operations (create/update/delete) require Telegram approval.

### 6. Configure Stripe (Optional)

To add Stripe integration for payment management:

1. **Get your Stripe API key** from [dashboard.stripe.com/apikeys](https://dashboard.stripe.com/apikeys)
2. **Set environment variable** in `.env`:
   ```bash
   STRIPE_API_KEY=sk_test_your-key-here
   ```

If `STRIPE_API_KEY` is not set, Portero will skip the Stripe MCP and start without it.

**Default policies:**
- **Read tools** (list/get customers, invoices, payments, subscriptions, balance) — `allow`
- **Write tools** (create customer, invoice, payment, refund, subscription) — `require-approval`

### 7. Configure Data Anonymization

Edit `config/replacements.json` to define fake↔real mappings:

```json
{
  "replacements": [
    {
      "fake": "John Doe",
      "real": "${REAL_NAME}",
      "bidirectional": true
    },
    {
      "fake": "john@example.com",
      "real": "${REAL_EMAIL}",
      "bidirectional": true,
      "caseSensitive": false
    }
  ]
}
```

### 8. Configure Policies

Edit `config/policies.json` to set permission rules:

```json
{
  "policies": {
    "github/create_issue": "allow",
    "github/create_pull_request": "require-approval",
    "filesystem/write_file": "require-approval",
    "filesystem/read_file": "allow",
    "filesystem/delete_file": "deny",
    "*": "allow"
  },
  "defaultPolicy": "allow"
}
```

### 9. Generate SSL Certificates (Optional)

```bash
./scripts/generate-certs.sh
```

Or skip SSL for local testing (uses HTTP).

### 10. Start the Gateway

```bash
# Development mode (with hot reload)
npm run dev

# Production mode
npm run build
npm start
```

## Docker Deployment

```bash
# Build and start with docker-compose
docker-compose up -d

# View logs
docker-compose logs -f

# Stop
docker-compose down
```

## Connect from Claude Code

Add to your Claude Code MCP configuration:

```json
{
  "mcpServers": {
    "portero": {
      "transport": "http",
      "url": "https://your-server:8443/mcp/message",
      "headers": {
        "Authorization": "Bearer your-bearer-token-here"
      }
    }
  }
}
```

Add to Claude Code system prompt:

```
Your identity:
- Name: John Doe
- Email: john@example.com
Use these when asked for personal information.
```

## Telegram Bot Commands

Once running, message your bot:

- `/status` - Show connected MCPs, active grants, pending approvals
- `/grant <pattern> <duration>` - Grant temporary access
  - Examples: `/grant github/* 30m`, `/grant * 1h`
- `/revoke` - Revoke all active grants
- `/allow <pattern>` - Persistently allow a tool/pattern (no approvals needed)
- `/deny <pattern>` - Persistently deny a tool/pattern
- `/rules` - List persistent rules
- `/unrule <id>` - Remove a persistent rule
- `/tasks` - Show recent tasks grouped by status
- `/pending` - Show pending approval requests
- `/logs` - Show recent audit logs
- `/help` - Show all commands

## How Async Approval Works

Portero uses a fully asynchronous approval flow — the HTTP request is never blocked waiting for Telegram approval.

1. Claude Code calls a tool (e.g., `github/create_pull_request`)
2. Gateway checks policy: requires approval
3. Gateway creates a **task** (status: `pending-approval`), sends Telegram message with Approve/Deny buttons, and **returns immediately** with a task ID
4. Claude Code receives `{ status: "pending-approval", taskId: "..." }` and can continue working
5. Admin approves/denies via Telegram buttons
6. If approved, Portero executes the tool in the background and stores the result
7. Claude Code calls `portero/check_task` with the task ID to retrieve the result
8. If not ready yet, Claude Code can call `portero/check_task` again later

This means:
- No timeout pressure — approvals can happen whenever
- Claude Code stays responsive while waiting
- Multiple approvals can be pending simultaneously

## Virtual Tools

Portero injects these virtual tools alongside your MCP tools:

| Tool | Description |
|------|-------------|
| `portero/search_tools` | Search available tools by keyword or category |
| `portero/call` | Call any tool by its full name (useful for non-pinned tools) |
| `portero/check_task` | Check status/result of a pending or completed async task |
| `portero/list_tasks` | List recent tasks with optional status filter |

## Configuration Reference

### Data Anonymization

Replacements support:

- **Bidirectional** — Replace in both directions (fake↔real)
- **One-way** — Replace only fake→real, use `responseReplacement` for responses
- **Case sensitivity** — Set `caseSensitive: false` for case-insensitive matching

### Permission Policies

Policy actions:

- `allow` — Allow without approval
- `deny` — Block completely
- `require-approval` — Request Telegram approval (async)

Patterns support wildcards:

- `github/*` — All GitHub tools
- `*/delete_*` — All delete operations
- `*` — All tools

Policy priority (highest first):
1. Persistent rules (from Telegram `/allow`, `/deny` commands)
2. Config exact matches (from `config/policies.json`)
3. Config pattern matches (wildcards)
4. Default policy

### Temporary Grants

Skip approval for a limited time:

```bash
/grant github/* 30m      # Grant GitHub access for 30 minutes
/grant * 1h              # Grant all access for 1 hour
/revoke                   # Revoke all grants immediately
```

## Security Considerations

1. **Bearer Token** — Generate a strong random token:
   ```bash
   openssl rand -hex 32
   ```

2. **SSL/TLS** — Use HTTPS in production (Let's Encrypt, self-signed, or reverse proxy)

3. **Telegram** — Only your admin chat ID can control the bot

4. **Firewall** — Restrict gateway port (8443) to authorized IPs

5. **Environment Variables** — Never commit `.env` to git

## Development

### Project Structure

```
portero/
├── src/
│   ├── index.ts                 # Entry point
│   ├── config/                  # Config loader & types
│   ├── gateway/                 # HTTP server & MCP handler
│   ├── mcp/                     # MCP client management
│   ├── middleware/              # Anonymizer, policy, approval
│   ├── telegram/                # Telegram bot & admin store
│   ├── db/                      # File-backed JSON storage
│   ├── storage/                 # Atomic file operations & paths
│   └── utils/                   # Logger, crypto
├── config/                      # JSON config files
├── data/                        # Runtime data (auto-created)
└── scripts/                     # Helper scripts
```

### Build Commands

```bash
npm run dev      # Development with hot reload
npm run build    # Compile TypeScript
npm start        # Start production build
```

### Storage

File-backed JSON storage in `./data/`:

- `approvals.json` — Legacy pending approvals (kept for backward compatibility)
- `tasks.json` — Async task tracking (pending → approved → executing → completed)
- `grants.json` — Temporary access grants
- `rules.json` — Persistent policy rules (from /allow, /deny commands)
- `audit.ndjson` — Append-only audit log (NDJSON format)

## Troubleshooting

### Gateway won't start

- Check Node.js version: `node -v` (should be 20+)
- Verify `.env` file exists and has all required variables
- Check logs in `./logs/combined.log`

### MCP connection fails

- Verify MCP command is correct in `config/mcps.json`
- Check MCP is installed: `npx -y @modelcontextprotocol/server-github --version`
- Check environment variables are set (e.g., `GITHUB_TOKEN`)
- MCPs with missing env vars are skipped automatically (non-blocking)

### Telegram bot not responding

- Verify bot token is correct
- Check admin chat ID matches your Telegram ID
- Ensure bot was started with `/start`

### Claude Code can't connect

- Verify bearer token matches in Claude Code config
- Check SSL certificates if using HTTPS
- Test with `curl`:
  ```bash
  curl -X POST https://localhost:8443/health
  ```

## Contributing

Contributions welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## License

MIT License - see [LICENSE](LICENSE) file for details

## Support

- GitHub Issues: [Report bugs or request features]

---

Built for Claude Code users who want privacy, security, and control over their MCP connections.
