PACER RESEARCH TOOL
===================
Version 1.0

HOW TO START:
1. Double-click 'Start Pacer Research.command'
2. If asked 'Are you sure?', click Open
3. The app opens in your browser automatically

FIRST-TIME SETUP:
1. You need an Anthropic API key for AI scoring
2. Get one at: console.anthropic.com
3. Enter it in the Setup section when the app opens
4. You only need to do this once

HOW TO BUILD THE DATABASE:
1. Go to the Pipeline tab
2. Select which research categories to search
3. Click 'Run pipeline'
4. Wait — this takes 2-4 hours to complete
5. You can pause and resume at any time

HOW TO REVIEW PAPERS:
1. Go to the Review tab after the pipeline completes
2. Read each paper and click Approve, Reject, or Later
3. Use keyboard shortcuts for speed: A, R, S
4. Work through one category at a time

HOW TO EXPORT FOR PACER:
1. When you're done reviewing, click 'Export for Pacer'
2. A file called pacer_database_[date].json will download
3. Send this file to your Pacer development team
4. They will import it into the Pacer application

TROUBLESHOOTING:
- App won't open: Make sure Node.js is installed (nodejs.org)
- Pipeline is slow: This is normal. PubMed and Semantic Scholar
  have rate limits. Leave it running in the background.
- API key error: Check your key at console.anthropic.com
