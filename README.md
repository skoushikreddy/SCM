# CodeGuard-SCM

CodeGuard analyzes Git commits, maps their dependency impact, recommends targeted regression tests, and records test and risk results in SQLite.

## Prerequisites

- **Node.js**: v20 or higher (v22 recommended)
- **npm**: v10 or higher
- **Python**: Python 3.8+ (used for AST parsing verification and `unittest` regression test execution; only Python standard library modules `ast` and `unittest` are used, no third-party pip packages required)
- **Git**: Installed and accessible in your system PATH

## Windows PowerShell Setup & Run

Open **Windows PowerShell** in the project directory:

```powershell
# 1. Install Node.js dependencies
npm install

# 2. (Optional) Create and activate a Python virtual environment
py -3 -m venv .venv
.\.venv\Scripts\Activate.ps1
py -3 -m pip install -r requirements.txt

# 3. (Optional) Configure environment variables
# Copy .env.example to .env if you wish to customize port or host:
Copy-Item .env.example .env

# 4. Start the development server
npm run dev
```

The server will display:
```
======================================================
  CodeGuard-SCM Server Running Successfully!
  - Local Access:      http://localhost:3000
  - Loopback IP:       http://127.0.0.1:3000
  - Network Interface: http://0.0.0.0:3000
======================================================
```

Open `http://localhost:3000` (or `http://127.0.0.1:3000`) in your web browser.

## Production Build & Start

```powershell
npm run build
npm start
```

## Environment Configuration

Configure variables in `.env` (or via PowerShell `$env:VARIABLE="value"`):

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Port for the HTTP server |
| `HOST` | `0.0.0.0` | Host interface to bind |
| `NODE_ENV` | `development` | Application mode (`development` or `production`) |
| `PYTHON_EXECUTABLE` | Auto-detected | Path or command for Python (`python`, `py`, or full path to python.exe) |

## Troubleshooting `ERR_CONNECTION_REFUSED` / Port Conflicts

If `http://localhost:3000` fails to connect:

1. **Verify the server is running**: Ensure `npm run dev` or `npm start` is actively executing in your terminal and has logged the server startup banner.
2. **Port 3000 already occupied (`EADDRINUSE`)**:
   - Check if an existing process or previous server instance is using port 3000:
     ```powershell
     Get-Process -Id (Get-NetTCPConnection -LocalPort 3000).OwningProcess | Stop-Process -Force
     ```
   - Alternatively, specify an alternative port:
     ```powershell
     $env:PORT="3001"
     npm run dev
     ```
     Then open `http://localhost:3001`.
3. **Loopback resolution**: If `http://localhost:3000` does not connect due to IPv6/IPv4 local resolution differences, navigate directly to `http://127.0.0.1:3000`.

## Verification & Tests

Run all automated checks in PowerShell:

```powershell
# TypeScript type check
npm run lint

# Bundle production build
npm run build

# Run all TypeScript unit & integration tests (22 tests)
npm run test:unit

# Run Python test runner integration suite
npm run test:python
```
