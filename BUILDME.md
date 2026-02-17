# Portero - Claude Code Build Prompt

## Project Overview

Build a **self-hosted MCP gateway** that sits between Claude Code and multiple MCP servers. The gateway provides:

1. **MCP Aggregation** — Connect multiple MCPs, expose them as one unified MCP to Claude Code
2. **Data Anonymization** — Replace fake↔real data bidirectionally (explicit config, not auto-detection)
3. **2FA Approvals** — Telegram bot for approving sensitive operations
4. **Permission Policies** — Allow/deny/require-approval per tool
5. **Remote Access** — HTTPS endpoint so Claude Code can connect from anywhere

## Tech Stack

- **Runtime**: Node.js 20+ with TypeScript
- **MCP SDK**: `@modelcontextprotocol/sdk`
- **HTTP Server**: Express with HTTPS support
- **Telegram Bot**: `telegraf` or `node-telegram-bot-api`
- **Database**: SQLite (via `better-sqlite3`) for mappings, audit log, pending approvals
- **Config**: JSON files for MCPs, replacements, policies
- **Containerization**: Docker + docker-compose

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
│  │ MCP Protocol Handler                                   ││
│  │ - tools/list → aggregate from all child MCPs          ││
│  │ - tools/call → route to correct MCP, apply policies   ││
│  └────────────────────────────────────────────────────────┘│
│  ┌────────────────────────────────────────────────────────┐│
│  │ Middleware Pipeline                                    ││
│  │ 1. Anonymization (fake→real on requests)              ││
│  │ 2. Policy Check (allow/deny/require-approval)         ││
│  │ 3. 2FA Gate (wait for Telegram approval if needed)    ││
│  │ 4. Route to child MCP                                  ││
│  │ 5. Anonymization (real→fake on responses)             ││
│  └────────────────────────────────────────────────────────┘│
│  ┌────────────────────────────────────────────────────────┐│
│  │ MCP Client Manager                                     ││
│  │ - Spawn child MCP processes (stdio)                   ││
│  │ - Maintain connections                                 ││
│  │ - Namespace tool names (mcp_name/tool_name)           ││
│  └────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
                      │ stdio
        ┌─────────────┼─────────────┐
        ▼             ▼             ▼
   ┌─────────┐  ┌─────────┐  ┌─────────┐
   │ MCP 1   │  │ MCP 2   │  │ MCP 3   │
   │(github) │  │(notion) │  │(gmail)  │
   └─────────┘  └─────────┘  └─────────┘
```

## Directory Structure

```
portero/
├── src/
│   ├── index.ts                 # Entry point
│   ├── config/
│   │   ├── loader.ts            # Load JSON configs
│   │   └── types.ts             # Config type definitions
│   ├── gateway/
│   │   ├── server.ts            # Express HTTPS server
│   │   ├── mcp-handler.ts       # JSON-RPC protocol handler
│   │   └── auth.ts              # Bearer token validation
│   ├── mcp/
│   │   ├── client-manager.ts    # Manage child MCP processes
│   │   ├── router.ts            # Route calls to correct MCP
│   │   └── aggregator.ts        # Merge tools/resources from MCPs
│   ├── middleware/
│   │   ├── anonymizer.ts        # Bidirectional data replacement
│   │   ├── policy.ts            # Permission checking
│   │   └── approval.ts          # 2FA approval gate
│   ├── telegram/
│   │   ├── bot.ts               # Telegram bot setup
│   │   ├── commands.ts          # /status, /grant, /revoke
│   │   └── approvals.ts         # Inline keyboard approvals
│   ├── db/
│   │   ├── index.ts             # SQLite setup
│   │   ├── approvals.ts         # Pending approvals table
│   │   ├── grants.ts            # Session grants table
│   │   └── audit.ts             # Audit log table
│   └── utils/
│       ├── logger.ts            # Simple logger
│       └── crypto.ts            # Token generation
├── config/
│   ├── mcps.json                # MCP server definitions
│   ├── replacements.json        # Fake↔real mappings
│   └── policies.json            # Tool permissions
├── docker/
│   ├── Dockerfile
│   └── docker-compose.yml
├── scripts/
│   └── generate-certs.sh        # Self-signed SSL certs
├── .env.example
├── package.json
├── tsconfig.json
└── README.md
```

## Configuration Files

### config/mcps.json
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

### config/replacements.json
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
    },
    {
      "fake": "fake-api-key-12345",
      "real": "${REAL_API_KEY}",
      "bidirectional": false,
      "responseReplacement": "***API-KEY***"
    }
  ]
}
```

### config/policies.json
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

## Core Components to Build

### 1. MCP Client Manager (`src/mcp/client-manager.ts`)

```typescript
// Responsibilities:
// - Spawn child MCP processes using stdio transport
// - Use @modelcontextprotocol/sdk Client
// - Store active connections in a Map
// - Handle process crashes/restarts
// - Provide methods: connect(config), disconnect(name), getClient(name)

interface MCPConfig {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

class MCPClientManager {
  private clients: Map<string, Client>;
  private processes: Map<string, ChildProcess>;
  
  async connectAll(configs: MCPConfig[]): Promise<void>;
  async disconnect(name: string): Promise<void>;
  getClient(name: string): Client | undefined;
  getAllClients(): Map<string, Client>;
}
```

### 2. Aggregator (`src/mcp/aggregator.ts`)

```typescript
// Responsibilities:
// - Call tools/list on all connected MCPs
// - Prefix tool names with MCP name (e.g., "github/create_issue")
// - Merge all tools into single list
// - Cache and refresh periodically

class Aggregator {
  constructor(private clientManager: MCPClientManager);
  
  async listAllTools(): Promise<Tool[]>;
  async listAllResources(): Promise<Resource[]>;
}
```

### 3. Router (`src/mcp/router.ts`)

```typescript
// Responsibilities:
// - Parse namespaced tool name (e.g., "github/create_issue")
// - Route to correct MCP client
// - Strip namespace before calling child MCP
// - Add namespace back to response

class Router {
  constructor(private clientManager: MCPClientManager);
  
  async callTool(namespacedName: string, args: any): Promise<any>;
  
  private parseNamespace(name: string): { mcpName: string; toolName: string };
}
```

### 4. Anonymizer (`src/middleware/anonymizer.ts`)

```typescript
// Responsibilities:
// - Load replacements from config
// - Replace fake→real in requests (before sending to MCP)
// - Replace real→fake in responses (before returning to Claude)
// - Handle case sensitivity option
// - Handle one-way replacements (secrets)
// - Deep traverse objects/arrays

interface Replacement {
  fake: string;
  real: string;
  bidirectional: boolean;
  caseSensitive?: boolean;
  responseReplacement?: string;
}

class Anonymizer {
  constructor(private replacements: Replacement[]);
  
  // Called before routing to MCP
  anonymizeRequest(data: any): any;
  
  // Called before returning to Claude
  deanonymizeResponse(data: any): any;
  
  private replaceInValue(value: string, direction: 'toReal' | 'toFake'): string;
  private deepTraverse(obj: any, replacer: (str: string) => string): any;
}
```

### 5. Policy Engine (`src/middleware/policy.ts`)

```typescript
// Responsibilities:
// - Load policies from config
// - Check tool name against policies (with wildcard support)
// - Return: 'allow' | 'deny' | 'require-approval'

type PolicyAction = 'allow' | 'deny' | 'require-approval';

class PolicyEngine {
  constructor(private policies: Record<string, PolicyAction>);
  
  checkPolicy(toolName: string): PolicyAction;
  
  private matchesPattern(toolName: string, pattern: string): boolean;
}
```

### 6. Approval Gate (`src/middleware/approval.ts`)

```typescript
// Responsibilities:
// - Create pending approval in DB
// - Send Telegram message with inline keyboard
// - Wait for approval (with timeout)
// - Return approved/denied/timeout

interface PendingApproval {
  id: string;
  toolName: string;
  args: any;
  status: 'pending' | 'approved' | 'denied';
  createdAt: Date;
  expiresAt: Date;
}

class ApprovalGate {
  constructor(
    private db: Database,
    private telegramBot: TelegramBot
  );
  
  async requestApproval(toolName: string, args: any): Promise<'approved' | 'denied' | 'timeout'>;
  
  async handleCallback(approvalId: string, approved: boolean): Promise<void>;
}
```

### 7. Telegram Bot (`src/telegram/bot.ts`)

```typescript
// Responsibilities:
// - Initialize bot with token
// - Register commands: /status, /grant, /revoke, /help
// - Handle approval callbacks (inline keyboard)
// - Restrict to admin chat ID

// Commands:
// /status - Show connected MCPs, active grants, pending approvals
// /grant <mcp|*> <duration> - Grant temp access (e.g., /grant github 30m)
// /revoke - Revoke all temp grants
// /help - Show available commands

// Approval message format:
// 🔔 Approval Required
// Tool: github/create_issue
// Args: { title: "...", body: "..." }
// [✅ Approve] [❌ Deny]
```

### 8. HTTP Server (`src/gateway/server.ts`)

```typescript
// Responsibilities:
// - HTTPS server with self-signed or real certs
// - Bearer token authentication
// - POST /mcp/message - Main MCP endpoint (JSON-RPC)
// - GET /health - Health check

// JSON-RPC methods to handle:
// - initialize
// - tools/list
// - tools/call
// - resources/list (if MCPs support it)
// - resources/read (if MCPs support it)
```

### 9. MCP Handler (`src/gateway/mcp-handler.ts`)

```typescript
// The main orchestrator - handles incoming JSON-RPC requests

class MCPHandler {
  constructor(
    private aggregator: Aggregator,
    private router: Router,
    private anonymizer: Anonymizer,
    private policyEngine: PolicyEngine,
    private approvalGate: ApprovalGate,
    private grantsDb: GrantsDB
  );
  
  async handleRequest(request: JSONRPCRequest): Promise<JSONRPCResponse> {
    switch (request.method) {
      case 'initialize':
        return this.handleInitialize(request);
      
      case 'tools/list':
        return this.handleToolsList();
      
      case 'tools/call':
        return this.handleToolsCall(request);
      
      // ... other methods
    }
  }
  
  private async handleToolsCall(request: JSONRPCRequest): Promise<JSONRPCResponse> {
    const { name, arguments: args } = request.params;
    
    // 1. Anonymize request (fake → real)
    const realArgs = this.anonymizer.anonymizeRequest(args);
    
    // 2. Check policy
    const policy = this.policyEngine.checkPolicy(name);
    
    if (policy === 'deny') {
      throw new Error(`Tool ${name} is denied by policy`);
    }
    
    // 3. Check for active grant (skip approval if granted)
    const hasGrant = await this.grantsDb.hasActiveGrant(name);
    
    // 4. Request approval if needed
    if (policy === 'require-approval' && !hasGrant) {
      const approval = await this.approvalGate.requestApproval(name, realArgs);
      if (approval !== 'approved') {
        throw new Error(`Tool ${name} was ${approval}`);
      }
    }
    
    // 5. Route to MCP
    const result = await this.router.callTool(name, realArgs);
    
    // 6. Deanonymize response (real → fake)
    const fakeResult = this.anonymizer.deanonymizeResponse(result);
    
    return { result: fakeResult };
  }
}
```

## Database Schema (SQLite)

```sql
-- Pending approvals
CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  tool_name TEXT NOT NULL,
  args TEXT NOT NULL,  -- JSON
  status TEXT NOT NULL DEFAULT 'pending',  -- pending, approved, denied
  telegram_message_id INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  resolved_at DATETIME
);

-- Session grants (temporary permissions)
CREATE TABLE grants (
  id TEXT PRIMARY KEY,
  pattern TEXT NOT NULL,  -- tool pattern, e.g., "github/*" or "*"
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Audit log
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  tool_name TEXT NOT NULL,
  args TEXT,  -- JSON (anonymized)
  result TEXT,  -- JSON (anonymized)
  policy_action TEXT,
  approval_status TEXT,
  error TEXT
);
```

## Environment Variables (.env)

```bash
# Server
PORT=8443
BEARER_TOKEN=your-secret-token-here

# SSL (optional, will generate self-signed if not provided)
SSL_CERT_PATH=
SSL_KEY_PATH=

# Telegram
TELEGRAM_BOT_TOKEN=your-bot-token
TELEGRAM_ADMIN_CHAT_ID=your-chat-id

# Approval settings
APPROVAL_TIMEOUT_SECONDS=300

# Data anonymization (referenced in replacements.json)
REAL_NAME=Your Actual Name
REAL_EMAIL=your.real@email.com
REAL_API_KEY=sk-actual-key-here

# MCP environment (referenced in mcps.json)
GITHUB_TOKEN=ghp_your_github_token
```

## Build Order (Phases)

### Phase 1: Core MCP Proxy (no auth, no anonymization)
1. Set up TypeScript project with dependencies
2. Build MCPClientManager - spawn and connect to child MCPs
3. Build Aggregator - merge tools from all MCPs
4. Build Router - route calls to correct MCP
5. Build basic HTTP server with /mcp/message endpoint
6. Test: Connect filesystem MCP, list tools, call a tool

### Phase 2: Data Anonymization
1. Build Anonymizer with bidirectional replacement
2. Integrate into request/response pipeline
3. Test: Write file with fake name, verify real name in file

### Phase 3: Policies
1. Build PolicyEngine
2. Add policy checking to MCP handler
3. Test: Deny a tool, verify error returned

### Phase 4: Telegram Bot + 2FA
1. Set up Telegram bot with telegraf
2. Implement /status, /help commands
3. Build ApprovalGate with DB storage
4. Implement approval inline keyboards
5. Integrate approval flow into MCP handler
6. Test: Call require-approval tool, approve via Telegram

### Phase 5: Session Grants
1. Add grants table and GrantsDB
2. Implement /grant and /revoke commands
3. Check grants in MCP handler (skip approval if granted)
4. Test: Grant access, verify no approval needed

### Phase 6: Polish & Docker
1. Add audit logging
2. Add health endpoint
3. Create Dockerfile and docker-compose.yml
4. Write README with setup instructions
5. Test full flow in container

## Key Dependencies

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "express": "^4.18.2",
    "better-sqlite3": "^9.4.3",
    "telegraf": "^4.15.0",
    "dotenv": "^16.4.1",
    "uuid": "^9.0.0",
    "winston": "^3.11.0"
  },
  "devDependencies": {
    "typescript": "^5.3.3",
    "@types/node": "^20.11.0",
    "@types/express": "^4.17.21",
    "@types/better-sqlite3": "^7.6.8",
    "tsx": "^4.7.0"
  }
}
```

## CLI Commands (MVP - before full Telegram)

For faster MVP, implement CLI admin first:

```bash
# Start the gateway
npm start

# CLI commands (separate terminal)
npm run cli status          # Show connected MCPs, pending approvals
npm run cli grant github 30m   # Grant github access for 30 minutes  
npm run cli grant '*' 1h       # Grant all access for 1 hour
npm run cli revoke             # Revoke all grants
npm run cli approve <id>       # Manually approve pending request
npm run cli deny <id>          # Manually deny pending request
npm run cli logs               # Show recent audit log
```

## Testing with Claude Code

Once running, add to Claude Code MCP config:

```json
{
  "mcpServers": {
    "secure-gateway": {
      "transport": "http",
      "url": "https://your-server:8443/mcp/message",
      "headers": {
        "Authorization": "Bearer your-secret-token"
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
- Use these when asked for personal information.
```

## Success Criteria for MVP

- [ ] Can connect 2+ MCPs and list all their tools
- [ ] Tool calls route to correct MCP
- [ ] Data replacement works bidirectionally
- [ ] Policies block/allow tools correctly
- [ ] Telegram shows approval requests
- [ ] Inline keyboard approves/denies
- [ ] /grant gives temporary access
- [ ] Works from Claude Code over HTTPS
- [ ] Runs in Docker

## Notes for Claude Code

- Start simple, iterate. Don't over-engineer.
- Test each phase before moving to next.
- Use console.log liberally during dev, replace with proper logger later.
- The MCP SDK handles JSON-RPC parsing - don't reinvent it.
- For stdio MCPs, use SDK's StdioClientTransport.
- SQLite is fine for MVP - no need for Postgres.
- Self-signed certs are fine for personal use.

Let's build this! 🚀
