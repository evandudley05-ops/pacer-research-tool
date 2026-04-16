#!/bin/bash
cd "$(dirname "$0")"
echo "Starting Pacer Research Pipeline v4..."
npm install --silent
node server.js &
sleep 2
open http://localhost:3333
echo "Open: http://localhost:3333"
wait
