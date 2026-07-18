# ShelfQueue

A MERN application for managing a physical book-lending shelf: catalog browsing, loan
requests, an ordered waitlist/queue for high-demand titles, and a librarian console for
approvals, loan lifecycle management, and audit review.

## Stack

- **Frontend:** React + Vite (member and librarian UI in one app, route-gated by role)
- **Backend:** Express (Node.js)
- **Database:** MongoDB
- **Cache / ephemeral state:** Redis (rate limits, lockouts, token revocation)

## Project layout

```
shelfqueue/
├── backend/    # Express API
├── frontend/   # React + Vite SPA
├── docs/       # Threat model, key management, accessibility, pentest evidence
└── docker-compose.yml
```

## Getting started

1. Copy the environment templates and fill in real values:
   ```
   cp backend/.env.example backend/.env
   cp frontend/.env.example frontend/.env
   ```
2. Start everything:
   ```
   docker-compose up --build
   ```
3. Backend: http://localhost:5000
   Frontend: http://localhost:5173

## Development notes

- This project runs over plain HTTP on localhost for development, testing, and the PoC
  video — no reverse proxy, no TLS certificate. This is a deliberate, documented scope
  decision (see `docs/threat-model.md`).
- The backend never trusts role/ownership claims from the client — every state-changing
  request re-derives permission server-side from the JWT + a fresh DB lookup.

## Status

Currently in active development — see the phased build plan for what's implemented so far.
