# PayFlow Fintech Engine

A production-style UPI-inspired wallet system built with the MERN stack. PayFlow focuses on robust system design, ledger-based accounting, atomic transactions, idempotency, secure session management, and AI-powered financial insights.

> **Note:** This project is designed as a learning-focused fintech backend and is not connected to real banking or payment networks.

---

## Core Features

- **Double-Entry Ledger Accounting:** Immutable ledger entries with credit/debit verification as the source of truth.
- **Atomic Transactions:** Multi-document MongoDB transactions ensuring absolute transaction consistency.
- **Idempotency:** Payment APIs protected with `Idempotency-Key` headers to prevent duplicate processing on retries.
- **Secure Authentication & Session Rotation:** Refresh token rotation and active session revocation using HttpOnly secure cookies.
- **AI Spending Insights:** Financial insights and budget suggestions powered by the Google Gemini API.
- **Reconciliation & Auditing:** Automated reconciliation workflows and comprehensive audit trails.

---

## Tech Stack

- **Frontend:** React (Vite), Tailwind CSS, React Query, Axios
- **Backend:** Node.js, Express.js, MongoDB (Mongoose), Zod, JWT
- **AI Layer:** Google Gemini API

---

## Architecture Overview

```text
React Client
     │
     ▼
Express API
 ├── Auth & Session Service
 ├── Wallet & Ledger Service
 ├── Payment & Reconciliation Service
 └── AI Insights Service (Gemini API)
       │
       ▼
MongoDB Database
```
