# PayFlow Fintech Engine

A production-style UPI-inspired wallet system built with the MERN stack. PayFlow focuses on robust system design, ledger-based accounting, atomic transactions, idempotency, secure session management, and AI-powered financial insights.

> **Note:** This project is designed as a learning-focused fintech backend and is not connected to real banking or payment networks.

---

## Core Features

- **Double-Entry Ledger Accounting:** Immutable ledger entries with credit/debit verification as the source of truth.
- **Atomic Transactions:** Multi-document MongoDB transactions ensuring absolute transaction consistency.
- **Idempotency:** Payment APIs protected with `Idempotency-Key` headers to prevent duplicate processing.
- **Secure Authentication & Session Rotation:** Refresh token rotation and active session revocation using HttpOnly secure cookies.
- **AI Spending Insights:** Financial insights and budget suggestions powered by the Google Gemini API.
- **Reconciliation & Auditing:** Automated reconciliation workflows and comprehensive audit trails.

---

## Tech Stack

- **Frontend:** React (Vite), Tailwind CSS, React Query, Axios
- **Backend:** Node.js, Express.js, MongoDB (Mongoose), Zod, JWT
- **AI Layer:** Google Gemini API

---

## UPI Simulation & Development Flow

To mimic a real peer-to-peer UPI-like payment experience without complex network topologies, PayFlow utilizes a single backend and database with isolated browser sessions:

### 1. Multi-Session Isolation (Normal vs. Incognito)
- **Window 1 (Sender):** Logged in as `Rohit` (`rohit@payflow`, balance: ₹10,000) in a standard browser window.
- **Window 2 (Receiver):** Logged in as `Alice` (`alice@payflow`, balance: ₹2,000) in an incognito window.
- Since cookies are isolated, both sessions can interact in real time against the same local database.
- A **Demo Login** page is provided to authenticate as Rohit or Alice with a single click (`POST /auth/demo-login`).

### 2. Payment Lifecycle & State Machine
Payments are treated as state transitions rather than instant updates:
1. **Initiation:** Creating a transaction with state `PROCESSING`.
2. **Simulation:** An artificial 3-second network delay is introduced via the backend.
3. **Execution:** The backend runs a MongoDB transaction to debit the sender, credit the receiver, and update the transaction status to `SUCCESS`.
4. **Real-time Propagation:** WebSockets notify the receiver's window to show a toast message and update their balance automatically.

---

## Development Roadmap

### Phase 1: Core Foundation & Multi-Session
- Set up Express backend and MongoDB models.
- Implement cookie-based JWT authentication and Demo Login.
- Create user wallets and the basic transfer API (`POST /payments/transfer`).
- Support dual-browser testing (Normal/Incognito sessions).

### Phase 2: Transaction Lifecycle & Delay
- Introduce transaction states (`INITIATED`, `PROCESSING`, `SUCCESS`, `FAILED`).
- Add artificial processing delays to simulate real-world ledger committing.
- Build transaction history and list endpoints.

### Phase 3: Real-Time WebSockets
- Implement socket connection mapping (User ID to Socket ID).
- Push real-time toast alerts and automatic balance updates to the receiver client.
