# Portero

A self-hosted MCP (Model Context Protocol) gateway that sits between Claude Code and multiple MCP servers, providing:

- **MCP Aggregation** — Connect multiple MCPs and expose them as one unified endpoint
- **Data Anonymization** — Bidirectional fake↔real data replacement for privacy
- **2FA Approvals** — Telegram bot for approving sensitive operations
- **Permission Policies** — Allow/deny/require-approval per tool
- **Remote Access** — HTTPS endpoint accessible from anywhere

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    TELEGRAM BOT                             │
│  /status, /grant, /revoke, approval callbacks               │
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
│  │ 3. 2FA Gate (wait for Telegram approval if needed)    ││
│  │ 4. Route to child MCP                                  ││
│  │ 5. Anonymization (real→fake on responses)             ││
│  └────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
                      │ stdio
        ┌─────────────┼─────────────┐
        ▼             ▼             ▼
   ┌─────────┐  ┌─────────┐  ┌─────────┐
   │ MCP 1   │  │ MCP 2   │  │ MCP 3   │
   │(github) │  │(filesys)│  │(google) │
   └─────────┘  └─────────┘  └─────────┘
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

### 5. Configure Data Anonymization

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

### 6. Configure Policies

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

### 7. Generate SSL Certificates (Optional)

```bash
./scripts/generate-certs.sh
```

Or skip SSL for local testing (uses HTTP).

### 8. Start the Gateway

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
- `/pending` - Show pending approval requests
- `/logs` - Show recent audit logs
- `/help` - Show all commands

## How 2FA Approval Works

1. Claude Code calls a tool (e.g., `github/create_pull_request`)
2. Gateway intercepts the request
3. Policy engine checks: requires approval
4. Telegram bot sends you a message with **Approve/Deny** buttons
5. You click a button
6. Gateway proceeds or blocks based on your decision
7. Response returns to Claude Code

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
- `require-approval` — Request Telegram approval

Patterns support wildcards:

- `github/*` — All GitHub tools
- `*/delete_*` — All delete operations
- `*` — All tools

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
│   ├── config/                  # Config loader
│   ├── gateway/                 # HTTP server & handler
│   ├── mcp/                     # MCP client management
│   ├── middleware/              # Anonymizer, policy, approval
│   ├── telegram/                # Telegram bot
│   ├── db/                      # SQLite database
│   └── utils/                   # Logger, crypto
├── config/                      # JSON config files
├── docker/                      # Docker setup
└── scripts/                     # Helper scripts
```

### Build Commands

```bash
npm run dev      # Development with hot reload
npm run build    # Compile TypeScript
npm start        # Start production build
```

### Database

SQLite database at `./data/gateway.db` stores:

- Pending approvals
- Temporary grants
- Audit logs

## Troubleshooting

### Gateway won't start

- Check Node.js version: `node -v` (should be 20+)
- Verify `.env` file exists and has all required variables
- Check logs in `./logs/combined.log`

### MCP connection fails

- Verify MCP command is correct in `config/mcps.json`
- Check MCP is installed: `npx -y @modelcontextprotocol/server-github --version`
- Check environment variables are set (e.g., `GITHUB_TOKEN`)

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
- Documentation: [See PROMPT.md for architecture details]

---

Built for Claude Code users who want privacy, security, and control over their MCP connections.
