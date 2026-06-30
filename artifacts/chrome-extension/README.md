# UpworkAI Chrome Extension

A Manifest V3 Chrome Extension that monitors Upwork job listings and sends them to your UpworkAI dashboard for AI analysis.

## How to Install (Developer Mode)

1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer mode** (toggle in the top-right)
3. Click **Load unpacked**
4. Select the `artifacts/chrome-extension/` folder from this project

## Setup

1. After installing, click the UpworkAI icon in your Chrome toolbar
2. Enter your **Dashboard URL** (e.g., `https://your-app.replit.app`)
3. Click **Save Settings**
4. The extension will verify the connection to your dashboard

## How It Works

### Content Script (`content.js`)
- Runs on all `upwork.com` pages
- Detects job listings on search results pages and job detail pages
- Extracts: title, description, budget, skills, client info, payment status, proposal count
- Sends each detected job to the background worker

### Background Service Worker (`background.js`)
- Receives job data from the content script
- Deduplicates jobs (tracks seen job IDs)
- POSTs new jobs to your dashboard API (`POST /api/jobs`)
- Automatically triggers AI analysis (`POST /api/jobs/:id/analyze`)
- Shows browser notifications for high-scoring jobs (score >= 75)

### Popup (`popup.html` + `popup.js`)
- Configure dashboard URL
- Toggle job monitoring on/off
- View detection stats
- Quick link to open dashboard

## Architecture

```
Upwork Page
    │
    ▼
content.js (extracts job data)
    │
    ▼
background.js (service worker)
    │
    ├── POST /api/jobs          → stores job in dashboard DB
    └── POST /api/jobs/:id/analyze → AI scores the job
                                       │
                                       └── Browser notification if score >= 75
```

## Detected Job Fields

| Field | Source |
|-------|--------|
| `title` | Job title element |
| `description` | Job description text |
| `budgetType` | hourly/fixed from budget text |
| `budgetMin/Max` | Parsed from budget range |
| `clientCountry` | Client location |
| `clientHireRate` | Client hire rate % |
| `clientTotalSpent` | Total client spending |
| `paymentVerified` | Payment verification badge |
| `proposalCount` | Number of proposals |
| `skills` | Skill tags |
| `jobUrl` | Full Upwork job URL |
| `upworkJobId` | Extracted from URL (`~xxxxxxxxx`) |

## Limitations

- Upwork frequently updates their HTML structure — selectors may need updating
- The extension cannot automatically submit proposals (requires human approval via the dashboard)
- WhatsApp notifications are handled by the dashboard server, not the extension
