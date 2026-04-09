#!/bin/bash
cd "$(dirname "$0")"
echo "Starting Pacer Research Tool..."

# Check for Node.js
if ! command -v node &> /dev/null; then
  osascript -e 'display dialog "Node.js is not installed.
Please download it from nodejs.org, install it, then try again."
buttons {"OK"} default button "OK" with icon caution'
  exit 1
fi

# Install dependencies on first run
if [ ! -d "node_modules" ]; then
  echo "Installing dependencies (first run only)..."
  npm install --silent
fi

# Create data directory
mkdir -p data

# Kill any existing instance on port 3333
lsof -ti:3333 | xargs kill -9 2>/dev/null || true

# Start server in background
node server.js &
SERVER_PID=$!

# Wait for server to be ready
echo "Waiting for server..."
for i in {1..15}; do
  if curl -s http://localhost:3333/health > /dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

# Open browser
open http://localhost:3333
echo "Pacer Research Tool is running at http://localhost:3333"
echo "Close this window to stop the server."

# Keep running until window is closed
wait $SERVER_PID
