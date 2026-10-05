# PayFlow Fintech Engine

A production-style, UPI-inspired real-time financial wallet and transaction processing engine built with **Node.js**, **Express**, and **MongoDB (Mongoose)**.

PayFlow demonstrates how modern, mission-critical payment systems handle high concurrency, distributed failures, and strict monetary accounting. The system enforces **ledger-based double-entry bookkeeping**, **multi-document ACID transactions**, **durable out-of-transaction idempotency**, **atomic conditional balance operations**, **two-tier distributed retry loops**, **fail-safe HTTP 202 commit escalation**, and **stateful SHA-256 hashed session security**.

> [!NOTE]
> **Learning-Focused Production Blueprint:** This repository is an educational, production-grade fintech reference implementation. While it adheres to real-world banking architecture principles, it operates in a simulated environment and is not connected to live external banking networks or NPCI/clearinghouses.

---

## Table of Contents

- [Core Engineering Highlights](#core-engineering-highlights)
- [Tech Stack](#tech-stack)
- [Repository Structure](#repository-structure)
- [Implementation Status](#implementation-status)
- [Getting Started & Local Setup](#getting-started--local-setup)
  - [Prerequisites](#prerequisites)
  - [Environment Configuration](#environment-configuration)
  - [Installation & Execution](#installation--execution)
- [API Reference](#api-reference)
  - [Health Check](#health-check)
  - [Authentication Endpoints (`/api/auth`)](#authentication-endpoints)
  - [Wallet Endpoints (`/api/wallet`)](#wallet-endpoints)
  - [Payment Endpoints (`/api/payments`)](#payment-endpoints)
- [Financial Accounting Model](#financial-accounting-model)
  - [Entity Separation Architecture](#entity-separation-architecture)
  - [Double-Entry Accounting Invariant](#double-entry-accounting-invariant)
  - [Paise Integer Arithmetic](#paise-integer-arithmetic)
  - [System Accounts](#system-accounts)
  - [Velocity Controls & Balance Ceilings](#velocity-controls--balance-ceilings)
- [Transaction Engine & Concurrency Safety](#transaction-engine--concurrency-safety)
  - [End-to-End P2P Payment Pipeline](#end-to-end-p2p-payment-pipeline)
  - [Durable PaymentIntent Pattern & Idempotency](#durable-paymentintent-pattern--idempotency)
  - [Atomic Conditional Balance Updates](#atomic-conditional-balance-updates)
  - [Distributed Transaction Resilience (Two-Tier Retries)](#distributed-transaction-resilience-two-tier-retries)
  - [Unknown Commit State & HTTP 202 Escalation](#unknown-commit-state--http-202-escalation)
- [Security & Authentication Hardening](#security--authentication-hardening)
- [Database Models & Indexes](#database-models--indexes)
- [Validation Rules](#validation-rules)
- [Extended System Blueprint & Future Roadmap](#extended-system-blueprint--future-roadmap)
  - [Settlement & Finalization](#settlement--finalization)
  - [Transactional Outbox & Asynchronous Workers](#transactional-outbox--asynchronous-workers)
  - [Reconciliation & Discrepancy Auditing](#reconciliation--discrepancy-auditing)
  - [Webhooks & Callbacks](#webhooks--callbacks)
  - [Refunds, Reversals & Adjustments](#refunds-reversals--adjustments)
  - [Financial Invariants & Chaos Testing](#financial-invariants--chaos-testing)
  - [Deterministic Risk Engine & AI Layer](#deterministic-risk-engine--ai-layer)

---

## Core Engineering Highlights

- **Double-Entry Bookkeeping**: Every transaction generates balanced, immutable debit and credit ledger records ($\sum \text{Debits} = \sum \text{Credits}$). Wallets are mutable balance projections; the immutable ledger is the source of truth.
- **Strict Integer Arithmetic in Paise**: All balances, transaction amounts, and limits are stored and computed strictly as integers in Paise (1 INR = 100 Paise). Floating-point arithmetic is prohibited to prevent precision drift.
- **Multi-Document ACID Transactions**: Distributed financial transactions run inside MongoDB replica set sessions (`session.startTransaction()`).
- **Durable Out-of-Transaction PaymentIntent**: `PaymentIntent` records are created *before and outside* the MongoDB transaction session, ensuring that in-progress request locks, failure tracking, and idempotency records survive transaction rollbacks and write conflicts.
- **Concurrent Race Serialization**: Compound unique indexing on `{ userId, idempotencyKey }` catches duplicate simultaneous requests via database duplicate key errors (`E11000`), ensuring only one request executes while duplicates safely await or receive existing results.
- **Zero-Overdraft Atomic Conditional Updates**: Balance deductions use MongoDB conditional atomic operators (`availableBalance: { $gte: amount }` with `$inc: -amount`) to eliminate READ-CHECK-WRITE race conditions and prevent overdrafts under high concurrency.
- **Two-Tier Distributed Retry Resilience**:
  - *Outer Loop*: Automatically handles `TransientTransactionError` (write conflicts, replica set elections) up to 3 attempts.
  - *Inner Commit Loop*: Automatically retries `UnknownTransactionCommitResult` up to 3 times without repeating monetary operations.
- **Fail-Safe HTTP 202 Escalation**: When commit status remains ambiguous after exhausted commit retries, the system raises `TRANSACTION_COMMIT_UNKNOWN`, preserves the in-flight intent, and returns **HTTP 202 Accepted**, preventing blind retries and double debits.
- **Stateful SHA-256 Session Security**: HttpOnly, SameSite cookie authentication using cryptographically generated 32-byte session tokens. The database stores strictly SHA-256 hashes, with native MongoDB TTL auto-cleanup after 7 days.
- **Tiered Financial Velocity Controls**: Hard constraints on single top-ups (₹50,000), cumulative daily top-ups (₹1,00,000), and wallet balance ceilings (₹2,00,000).
- **Runtime Schema Validation**: Zero-trust request parsing powered by **Zod**.

---

## Tech Stack

### Implemented Backend Core
- **Runtime & Framework:** Node.js (v18+), Express.js
- **Database & ODM:** MongoDB (v5+ with Replica Set / MongoDB Atlas), Mongoose
- **Validation & Security:** Zod, bcrypt, Node.js `crypto` (SHA-256, `randomBytes`)
- **Transport & Cookies:** `cors`, `cookie-parser`, `dotenv`
- **Development Tooling:** Nodemon

### Planned Architecture Layers (Roadmap)
- **Frontend Client:** React (Vite), React Query, Axios, CSS Modules / Vanilla CSS
- **Asynchronous Processing:** Redis, BullMQ (Transactional Outbox relay & workers)
- **AI Analytics & Insights:** Google Gemini API

---

## Repository Structure

```text
PayFlow/
├── backend/                      # Core Financial & Transaction Engine
│   ├── src/
│   │   ├── config/
│   │   │   └── db.js             # Mongoose connection with MongoDB Replica Set
│   │   ├── controllers/
│   │   │   ├── auth.controller.js    # Register, login, and getMe profile handlers
│   │   │   ├── payment.controller.js # P2P transfer handler with HTTP 202 handling
│   │   │   └── wallet.controller.js  # Wallet top-up (add-money) HTTP handler
│   │   ├── middleware/
│   │   │   └── auth.middleware.js    # SHA-256 session token cookie authenticator
│   │   ├── models/
│   │   │   ├── Accounts.js       # Financial accounts (USER_WALLET, BANK_SUSPENSE, etc.)
│   │   │   ├── Idempotency.js    # Generic request deduplication model
│   │   │   ├── LedgerEntry.js    # Immutable double-entry financial entries (DEBIT/CREDIT)
│   │   │   ├── PaymentIntent.js  # Durable out-of-transaction payment tracking & idempotency
│   │   │   ├── Session.js        # Stateful sessions with SHA-256 hashes & TTL auto-expiry
│   │   │   ├── Transaction.js    # High-level business event records
│   │   │   ├── User.js           # User identity, phone, email, and bcrypt credentials
│   │   │   └── Wallet.js         # Fast mutable balance projection (Paise integer)
│   │   ├── routes/
│   │   │   ├── auth.routes.js    # Auth routes mounted at /api/auth
│   │   │   ├── payment.routes.js # Payment routes mounted at /api/payments
│   │   │   └── wallet.routes.js  # Wallet routes mounted at /api/wallet
│   │   ├── services/
│   │   │   ├── payment.service.js# Resilient P2P pipeline with ACID retries & atomicity
│   │   │   └── wallet.service.js # Wallet funding service with velocity limit checks
│   │   ├── utils/                # Utilities and helpers
│   │   ├── validator/
│   │   │   ├── addMoney.validator.js # Zod schema for wallet top-up payloads
│   │   │   ├── auth.validator.js     # Zod schemas for registration and login
│   │   │   └── payment.validator.js  # Zod schema for P2P payment requests
│   │   ├── app.js                # Express application configuration and route bindings
│   │   └── server.js             # Server bootstrap and database connection
│   ├── .env.example              # Environment variables blueprint
│   ├── package.json              # Backend dependencies and execution scripts
│   └── README.md                 # Detailed backend technical documentation
├── frontend/                     # Client application (Vite / React - in roadmap)
├── notes.txt                     # Design notes and domain specifications
└── README.md                     # Main repository documentation (this file)
```

---

## Implementation Status

| Component / Subsystem | Status | Implementation Details |
| :--- | :--- | :--- |
| **User Identity & Auth** |  **Implemented** | Bcrypt password hashing, stateful SHA-256 session tokens, `HttpOnly` cookies, 7-day TTL index, `/api/auth/register`, `/api/auth/login`, `/api/auth/me`. |
| **Financial Accounting Model** |  **Implemented** | Separation of `User`, `Account`, `Wallet`, and `LedgerEntry`. Support for `USER_WALLET` and system accounts (`BANK_SUSPENSE`, `PLATFORM_REVENUE`, `SETTLEMENT_POOL`). |
| **Paise Integer Representation** |  **Implemented** | Zero floating-point math; all balances and values stored as integers in Paise ($100 = ₹1.00$). |
| **Inbound Top-Up (`addMoney`)** |  **Implemented** | Debits `BANK_SUSPENSE`, credits `USER_WALLET`, updates balance snapshot, writes paired ledger entries, enforces ₹50k per-txn, ₹100k daily, and ₹200k balance caps. |
| **Durable PaymentIntent Idempotency** |  **Implemented** | Out-of-transaction durable record with `{ userId, idempotencyKey }` unique compound index, surviving rollbacks and serializing concurrent races. |
| **Atomic P2P Money Movement** |  **Implemented** | MongoDB ACID multi-document transactions, atomic conditional debit (`$gte` and `$inc`), balanced credit, paired immutable `DEBIT`/`CREDIT` ledger records. |
| **Transaction Resilience & Retries** |  **Implemented** | Outer retry loop for `TransientTransactionError` (3x), inner commit-only loop for `UnknownTransactionCommitResult` (3x), HTTP 202 escalation on ambiguous commits. |
| **Runtime Validation** |  **Implemented** | Zod schemas for registration, login, add-money, and payment requests. |
| **Frontend UI (React/Vite)** |  *Roadmap* | Dashboard, passbook ledger view, send money modal, QR / VPA lookup. |
| **Transactional Outbox & Workers** |  *Blueprint* | Event-driven architecture with outbox relay, Redis, and BullMQ queues for settlement and notifications. |
| **Reconciliation & External Simulator**|  *Blueprint* | External payment network simulator, batch/poll reconciliation, mismatch classification, automated reversal ledger entries. |
| **Deterministic Risk & Gemini AI** |  *Blueprint* | Deterministic policy evaluation (`ALLOW`, `VERIFY`, `REVIEW`, `REJECT`) + asynchronous Gemini financial insights. |

---

## Getting Started & Local Setup

### Prerequisites

1. **Node.js**: `v18.x` or higher
2. **npm**: `v9.x` or higher
3. **MongoDB**: `v5.x` or higher with a **Replica Set** enabled.
   > [!IMPORTANT]
   > MongoDB multi-document ACID transactions (`mongoose.startSession()`) require a replica set. If running locally, start `mongod` with `--replSet rs0`. Alternatively, a free cloud database cluster from [MongoDB Atlas](https://www.mongodb.com/atlas) has replica sets enabled out-of-the-box.

### Environment Configuration

Create a `.env` file inside the `backend/` directory by copying `backend/.env.example`:

```bash
cp backend/.env.example backend/.env
```

Set the required environment parameters in `backend/.env`:

```env
PORT=5000
NODE_ENV=development
MONGO_URI=mongodb+srv://<username>:<password>@<cluster>.mongodb.net/payflow?retryWrites=true&w=majority
```

### Installation & Execution

1. **Install backend dependencies:**
   ```bash
   cd backend
   npm install
   ```

2. **Verify JavaScript syntax:**
   ```bash
   npm run check
   ```

3. **Start in development mode (hot-reload via `nodemon`):**
   ```bash
   npm run dev
   ```

4. **Start in production mode:**
   ```bash
   npm start
   ```

When the server boots successfully, the console will output:
```text
database connected successfully
PayFlow API is running on port 5000
```

---

## API Reference

### Health Check

#### `GET /`
Verifies backend service operational health.

- **Request:** No parameters or authentication required.
- **Response `200 OK`:**
```json
{
  "message": "PayFlow Backend",
  "status": "running"
}
```

---

### Authentication Endpoints

Base Route: `/api/auth`

#### 1. Register User
`POST /api/auth/register`

Creates a new user identity, automatically provisions a financial account of type `USER_WALLET`, and creates an associated `Wallet` with `0` balance within an atomic MongoDB transaction.

- **Request Body:**
```json
{
  "name": "Rohit Sinha",
  "phone": "9876543210",
  "email": "rohit@example.com",
  "password": "SecurePassword123"
}
```
*Validation Rules: `name` min 2 chars; `phone` exactly 10 digits; `email` valid format (optional); `password` min 6 chars.*

- **Response `201 Created`:**
```json
{
  "message": "User registered successfully",
  "user": {
    "id": "64b8f0f4a7c1b2c3d4e5f6a1",
    "name": "Rohit Sinha",
    "phone": "9876543210",
    "email": "rohit@example.com"
  }
}
```
- **Error Responses:**
  - `400 Bad Request`: Payload validation failed.
  - `409 Conflict`: Phone number or email already in use.
  - `500 Internal Server Error`: Server failure.

---

#### 2. Login User
`POST /api/auth/login`

Authenticates credentials using `bcrypt.compare`, verifies that account status is `ACTIVE`, generates a cryptographically secure 32-byte session token, stores its SHA-256 hash in MongoDB, and delivers an `HttpOnly` cookie.

- **Request Body:**
```json
{
  "email": "rohit@example.com",
  "password": "SecurePassword123"
}
```

- **Response `200 OK`:**
  - **Headers:**
    ```http
    Set-Cookie: sessionToken=<64-char-hex-token>; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800
    ```
  - **Body:**
    ```json
    {
      "message": "login successful",
      "user": {
        "id": "64b8f0f4a7c1b2c3d4e5f6a1",
        "name": "Rohit Sinha",
        "phone": "9876543210",
        "email": "rohit@example.com"
      }
    }
    ```
- **Error Responses:**
  - `400 Bad Request`: Missing email or password.
  - `401 Unauthorized`: Invalid credentials.
  - `403 Forbidden`: User account is `BLOCKED`.
  - `500 Internal Server Error`: Server error.

---

#### 3. Get Authenticated User Profile
`GET /api/auth/me`

Resolves the caller's identity via the active `sessionToken` cookie.

- **Authentication:** Required (`sessionToken` cookie).
- **Response `200 OK`:**
```json
{
  "user": {
    "id": "64b8f0f4a7c1b2c3d4e5f6a1",
    "name": "Rohit Sinha",
    "phone": "9876543210",
    "email": "rohit@example.com",
    "status": "ACTIVE"
  }
}
```
- **Error Responses:**
  - `401 Unauthorized`: Missing, expired, or invalid session cookie.
  - `404 Not Found`: User record not found.

---

### Wallet Endpoints

Base Route: `/api/wallet`

#### 1. Add Money / Wallet Top-Up
`POST /api/wallet/add-money`

Loads funds into the authenticated user's wallet from the platform's external banking clearing account (`BANK_SUSPENSE`).

**Execution & Accounting Lifecycle:**
1. Resolves caller's `User`, `Account` (`USER_WALLET`), and `Wallet`.
2. Locates or initializes the platform `BANK_SUSPENSE` account.
3. Evaluates velocity controls:
   - Single top-up cap: $\le 5,000,000$ Paise (₹50,000).
   - Maximum wallet balance ceiling: $\le 20,000,000$ Paise (₹2,00,000).
   - Daily cumulative top-up limit: $\le 10,000,000$ Paise (₹1,00,000) for the current day.
4. Generates a `Transaction` record (`type: "ADD_MONEY"`, `status: "INITIATED"`).
5. Increments `userWallet.availableBalance` by `amount`.
6. Creates balanced double-entry records:
   - `DEBIT` on `BANK_SUSPENSE` account for `amount`.
   - `CREDIT` on caller's `USER_WALLET` account for `amount`.
7. Transitions `Transaction.status = "SUCCESS"`.

- **Authentication:** Required (`sessionToken` cookie).
- **Request Body:**
```json
{
  "amount": 500000
}
```
*Note: `amount` must be a positive integer in Paise (`500000` = ₹5,000.00).*

- **Response `201 Created`:**
```json
{
  "message": "Money added successfully",
  "transaction": {
    "id": "TXN-1725807600000-84729",
    "type": "ADD_MONEY",
    "amount": 500000,
    "currency": "INR",
    "status": "SUCCESS"
  }
}
```
- **Error Responses:**
  - `400 Bad Request`: Invalid amount format (non-integer or non-positive).
  - `401 Unauthorized`: Authentication required.
  - `500 Internal Server Error`: Limit exceeded (`"Transaction amount limit exceeded"`, `"Daily add-money limit exceeded"`, `"Wallet balance limit exceeded"`).

---

### Payment Endpoints

Base Route: `/api/payments`

#### 1. Execute Peer-to-Peer (P2P) Transfer
`POST /api/payments`

Transfers money atomically between two users' wallet accounts. Utilizes an out-of-transaction durable `PaymentIntent`, MongoDB multi-document ACID isolation, atomic conditional balance decrements, double-entry ledger entries, and two-tier retry resilience.

- **Authentication:** Required (`sessionToken` cookie).
- **HTTP Headers:**
  ```http
  Idempotency-Key: <unique-client-uuid-or-id>
  ```
  *(Mandatory in production. Enforces exactly-once execution across network retries and duplicate submits).*
- **Request Body:**
```json
{
  "receiverAccountId": "64b8f102a7c1b2c3d4e5f6b2",
  "amount": 50000
}
```
*Note: `amount` must be an integer in Paise (`50000` = ₹500.00). Sender is automatically resolved server-side from the authenticated session; client-supplied sender values are rejected.*

- **Response `200 OK` (Payment Successful):**
```json
{
  "message": "Payment successful",
  "transaction": {
    "id": "TXN-1725330000000-48291",
    "amount": 50000,
    "currency": "INR",
    "status": "SUCCESS"
  }
}
```
*(Also returned if an identical idempotency key is submitted whose payment previously reached `SUCCESS`).*

- **Response `202 Accepted` (Commit Status Ambiguous):**
Returned when MongoDB commit attempts encounter `UnknownTransactionCommitResult` and cannot confirm whether the replica set finalized the write before network disruption. The `PaymentIntent` remains in `PROCESSING`. The client must not re-execute the transfer blindly.
```json
{
  "message": "payment status could not be confirmed",
  "status": "UNKNOWN",
  "transactionId": "TXN-1725330000000-48291"
}
```

- **Error Responses:**
  - `400 Bad Request`: Missing receiver account ID or invalid amount.
  - `401 Unauthorized`: Authentication required or invalid session.
  - `500 Internal Server Error`: Business rule failure:
    - `"Insufficient balance"`
    - `"Cannot transfer money to your own account"`
    - `"Payment is already in progress"`
    - `"Payment has already failed"`
    - `"Receiver account not found"`

---

## Financial Accounting Model

### Entity Separation Architecture

PayFlow strictly separates human identity, financial accounting entities, fast mutable balance state, durable request intent, and immutable transaction audit logs:

```text
                        USER (Identity & Credentials)
                                     │
                                     ▼
                         ACCOUNT (Financial Entity)
                       (USER_WALLET, BANK_SUSPENSE,
                       PLATFORM_REVENUE, SETTLEMENT_POOL)
                                     │
          ┌──────────────────────────┼──────────────────────────┐
          ▼                          ▼                          ▼
    PAYMENT INTENT            LEDGER ENTRIES             WALLET (Balance)
  (Durable Intent & Idemp)   (Immutable Ledger)     (Fast Mutable Projection)
          │                          │
          └─────────────► TRANSACTION ◄─────────────┘
                       (Financial Event)
```

1. **User (`User`)**: Represents the human entity, holds login credentials, phone, and email. Has zero financial balance fields.
2. **Account (`Account`)**: The accounting identity that participates in financial movements. A user holds an account of type `USER_WALLET`. Platform accounts (`BANK_SUSPENSE`, `PLATFORM_REVENUE`, `SETTLEMENT_POOL`) represent platform holdings and clearinghouses.
3. **Wallet (`Wallet`)**: A fast, cached view of spendable balance for rapid dashboard loading. **The wallet is a mutable projection, not the financial source of truth.** If wallet state were ever lost or corrupted, it can be recomputed from ledger history.
4. **PaymentIntent (`PaymentIntent`)**: The durable request state machine (`RECEIVED` → `PROCESSING` → `SUCCESS` / `FAILED`) created outside the financial transaction boundary. Survives rollbacks and anchors idempotency.
5. **Transaction (`Transaction`)**: Represents a high-level business event (`P2P_TRANSFER`, `ADD_MONEY`) and tracks processing lifecycle (`INITIATED` → `PROCESSING` → `SUCCESS` / `FAILED` / `REVERSED`).
6. **Ledger Entry (`LedgerEntry`)**: The immutable proof of money movement following double-entry bookkeeping. Every financial event generates paired debit and credit entries.

---

### Double-Entry Accounting Invariant

Every financial movement in PayFlow satisfies the fundamental accounting invariant:

$$\sum \text{Debits} = \sum \text{Credits}$$

#### 1. Inbound Funding (`ADD_MONEY`):
When a user loads ₹5,000 into their wallet from an external bank:
- `BANK_SUSPENSE` Account is **DEBITED** by ₹5,000 (`500000` Paise).
- User's `USER_WALLET` Account is **CREDITED** by ₹5,000 (`500000` Paise).
- User's `Wallet.availableBalance` increases by `500000` Paise.

```text
[BANK_SUSPENSE Account] ──(DEBIT ₹5,000)──> [User Account] ──(CREDIT ₹5,000)
                                                    │
                                                    ▼
                                         Wallet Balance += ₹5,000
```

#### 2. Peer-to-Peer Transfer (`P2P_TRANSFER`):
When Rohit transfers ₹500 to Alice:
- Rohit's `USER_WALLET` Account is **DEBITED** by ₹500 (`50000` Paise).
- Alice's `USER_WALLET` Account is **CREDITED** by ₹500 (`50000` Paise).
- Rohit's `Wallet.availableBalance` decrements by `50000` Paise.
- Alice's `Wallet.availableBalance` increments by `50000` Paise.

```text
[Rohit's Account] ──(DEBIT ₹500)──> [Alice's Account] ──(CREDIT ₹500)
       │                                     │
       ▼                                     ▼
Rohit Balance -= ₹500               Alice Balance += ₹500
```

---

### Paise Integer Arithmetic

> [!IMPORTANT]
> **No Floating-Point Arithmetic for Money:** Storing fractional currency amounts (e.g., `500.50`) in IEEE 754 floating-point numbers causes precision drift (e.g., `0.1 + 0.2 = 0.30000000000000004`).
>
> All amounts, balances, and limits in PayFlow are stored strictly as **integers in Paise** ($1 \text{ INR} = 100 \text{ Paise}$):
> - ₹1.00 = `100` Paise
> - ₹500.00 = `50000` Paise
> - ₹50,000.00 = `5000000` Paise

Mongoose schema validation explicitly enforces integer constraints on all balance and amount fields:
```javascript
validate: {
  validator: Number.isInteger,
  message: "Amount must be an integer representing paise"
}
```

---

### System Accounts

Money never enters or leaves PayFlow out of thin air. External monetary flows are anchored to platform-level system accounts:

| System Account Type | Purpose | Financial Role |
| :--- | :--- | :--- |
| **`BANK_SUSPENSE`** | Holds external funds in transit before final clearing. | Debited when users add money; credited during bank withdrawals. |
| **`PLATFORM_REVENUE`**| Platform revenue and service fees. | Credited when transaction fees or merchant interchange are applied. |
| **`SETTLEMENT_POOL`**  | Inter-bank clearing and partner settlement pool. | Used during end-of-day bank clearing and net settlement cycles. |

---

### Velocity Controls & Balance Ceilings

To defend against rapid balance inflation, fraud, and excessive risk exposure, wallet funding enforces tiered velocity controls:

| Limit Policy | Rupee Value | Paise Value | Triggered Exception |
| :--- | :--- | :--- | :--- |
| **Max Single Top-Up** | ₹50,000 | `5,000,000` | `"Transaction amount limit exceeded"` |
| **Cumulative Daily Top-Up** | ₹1,00,000 | `10,000,000` | `"Daily add-money limit exceeded"` |
| **Max Wallet Balance Cap** | ₹2,00,000 | `20,000,000` | `"Wallet balance limit exceeded"` |

- Daily limits aggregate all successful `ADD_MONEY` records for the user's account between `00:00:00.000` and `23:59:59.999` of the current day.
- Balance caps assert that `availableBalance + amount <= MAX_WALLET_BALANCE` before initiating the transfer.

---

## Transaction Engine & Concurrency Safety

### End-to-End P2P Payment Pipeline

```text
                     ┌───────────────────────────────┐
                     │ Client sends Payment Request  │
                     │ (Header: Idempotency-Key: K)  │
                     └───────────────┬───────────────┘
                                     │
                     [1. Durable Idempotency Check]
                  PaymentIntent exists for {userId, K}?
                  ├── Yes:
                  │   ├── PROCESSING? ──► Has txnId? ──► Return cached Transaction
                  │   │                               └── Error: "Payment is already in progress"
                  │   ├── SUCCESS? ──► Return cached Transaction (200 OK)
                  │   └── FAILED? ──► Error: "Payment has already failed"
                  └── No: Proceed
                                     │
                     [2. Pre-Transaction Resolution]
                     Resolve Sender (User, Account, Wallet)
                     Resolve Receiver (Account, Wallet)
                     Validate Sender Account != Receiver Account
                                     │
                  [3. Create Durable PaymentIntent (Outside Session)]
                     Insert PaymentIntent (status: "PROCESSING")
                     ├── Duplicate Key (E11000 race)?
                     │   └── Fetch existing PaymentIntent & resolve status
                     └── Success ──► Proceed to Transaction Loop
                                     │
                                     ▼
                 ┌───────────────────────────────────────┐
                 │     Transaction Attempt (Max: 3)      │
                 │     mongoose.startSession()           │
                 │     session.startTransaction()        │
                 └───────────────────┬───────────────────┘
                                     │
              1. IDENTIFY ───────────┤ Re-read Sender & Receiver within session (Snapshot Isolation)
              2. VALIDATE ───────────┤ Re-assert Sender Account != Receiver Account
              3. CREATE TXN ─────────┤ Insert Transaction (status: "INITIATED")
              4. LINK INTENT ────────┤ Set paymentIntent.transactionId = txn._id (in session)
              5. MOVE ───────────────┤ Atomic Conditional Debit (availableBalance >= amount)
                                     │ Credit Receiver Balance ($inc: amount)
              6. RECORD ─────────────┤ Insert immutable DEBIT & CREDIT LedgerEntry records
              7. COMPLETE ───────────┤ Set Transaction status = "SUCCESS"
                                     │
                                     ▼
                 ┌───────────────────────────────────────┐
                 │         Commit Phase (Max: 3)         │
                 │       session.commitTransaction()     │
                 └───────────────────┬───────────────────┘
                                     │
              ├── Commit Succeeded ──┴─► [Post-Commit Intent Finalization]
              │                          Update PaymentIntent (status: "SUCCESS") outside session
              │                          Return Transaction (200 OK)
              │
              ├── UnknownTransactionCommitResult?
              │   ├── Retry Commit ONLY (commitAttempt < 3)
              │   └── Attempts Exhausted ──► Throw TRANSACTION_COMMIT_UNKNOWN
              │                              ├── PaymentIntent remains "PROCESSING"
              │                              └── Controller returns 202 Accepted
              │
              ├── TransientTransactionError during operations?
              │   └── Abort session & Retry Whole Transaction Loop (attempt < 3)
              │
              └── Other Error / Attempts Exhausted?
                  ├── Abort active transaction session
                  ├── Update PaymentIntent (status: "FAILED") outside session
                  └── Throw Error (500)
```

---

### Durable PaymentIntent Pattern & Idempotency

#### Why In-Transaction Idempotency Fails in Distributed Systems
Traditional systems record idempotency tokens inside the ACID transaction session. This presents a critical flaw:
- If a transaction aborts (e.g. write conflict, transient network blip, or balance check failure), **the idempotency record rolls back alongside the monetary changes**.
- The database loses all memory that an attempt occurred.
- A client retry arrives as a completely fresh request, creating vulnerability to double-spending or untraceable state.

#### The Out-of-Transaction Solution
PayFlow creates the `PaymentIntent` **outside and before** the MongoDB transaction:
- The intent document acts as an immutable anchor that survives inner transaction aborts, rollbacks, and failovers.
- States: `RECEIVED` → `PROCESSING` → `SUCCESS` / `FAILED`.

```text
PaymentIntent States:
[RECEIVED] ──► [PROCESSING] ──┬──(Commit Succeeded)──► [SUCCESS]
                              │
                              ├──(Non-Retryable Error)──► [FAILED]
                              │
                              └──(Commit Unknown)──────► [PROCESSING (Pending Reconciliation)]
```

#### Concurrency Race Resolution via Compound Unique Index
The `PaymentIntent` collection enforces a compound unique index:
```javascript
paymentIntentSchema.index(
  { userId: 1, idempotencyKey: 1 },
  { unique: true }
);
```
When two identical requests arrive simultaneously:
1. The first request inserts the `PaymentIntent` with status `"PROCESSING"` and claims execution ownership.
2. The concurrent duplicate request hits MongoDB duplicate key error `E11000`.
3. The catch block handles `E11000` by querying the winning `PaymentIntent`:
   - If still `"PROCESSING"`, returns `"Payment is already in progress"`.
   - If completed (`"SUCCESS"`), fetches and returns the cached `Transaction` immediately.
   - If failed (`"FAILED"`), returns `"Payment has already failed"`.

---

### Atomic Conditional Balance Updates

PayFlow prevents the classic READ-CHECK-WRITE double-spend race condition by utilizing **atomic conditional database updates**:

```javascript
// ATOMIC DEBIT: Balance check and decrement in a single database operation
const senderDebit = await Wallet.updateOne(
  {
    _id: senderWallet._id,
    availableBalance: { $gte: amount }
  },
  {
    $inc: { availableBalance: -amount }
  },
  { session }
);

if (senderDebit.modifiedCount === 0) {
  throw new Error("Insufficient balance");
}
```

- MongoDB verifies `availableBalance >= amount` and decrements `availableBalance` in a single atomic write.
- If balance is insufficient, `modifiedCount === 0` and the transaction aborts immediately.
- **Overdrafts and negative balances are mathematically impossible at the database engine level.**

---

### Distributed Transaction Resilience (Two-Tier Retries)

Distributed replica sets can experience transient network partitions or write conflicts under load. PayFlow implements a two-tier retry strategy:

#### 1. Whole-Transaction Retries (`TransientTransactionError`)
- Governed by `MAX_ATTEMPTS = 3`.
- Catches MongoDB errors with the label `TransientTransactionError` (write conflicts, replica set elections).
- Aborts the failed session cleanly, acquires a fresh session, and restarts the transaction pipeline.

#### 2. Commit-Only Retries (`UnknownTransactionCommitResult`)
- Governed by `MAX_COMMIT_ATTEMPTS = 3`.
- Catches MongoDB errors with label `UnknownTransactionCommitResult`. This occurs when the commit message was sent, but the driver could not confirm whether the replica set finished committing before connection loss.
- **Fintech Principle**: In this scenario, **only the commit is retried**. The balance movements and ledger entries are **never repeated**, strictly preventing duplicate debits.

---

### Unknown Commit State & HTTP 202 Escalation

If all 3 commit attempts fail to confirm the outcome:
1. The service tags the error with metadata:
   ```javascript
   err.code = "TRANSACTION_COMMIT_UNKNOWN";
   err.transactionId = createdTransaction.transactionId;
   err.idempotencyKey = idempotencyKey;
   ```
2. The outer retry loop recognizes `err.code === "TRANSACTION_COMMIT_UNKNOWN"` and intentionally avoids re-executing the transaction.
3. The `PaymentIntent` intentionally remains in `status: "PROCESSING"`. Any subsequent retry with the same key is blocked with `"Payment is already in progress"`.
4. The payment controller catches this error and returns **HTTP 202 Accepted**:
   ```json
   {
     "message": "payment status could not be confirmed",
     "status": "UNKNOWN",
     "transactionId": "TXN-1725330000000-48291"
   }
   ```
5. This informs the client application that the payment was accepted, but the final outcome is pending verification. The client must not re-submit a new payment blindly.

---

## Security & Authentication Hardening

Rather than stateless JWTs (which cannot be revoked instantly without distributed blacklists and are vulnerable when stored in localStorage), PayFlow uses a **stateful, hashed session-cookie pattern**:

```text
Client (Browser)                       Backend API                          MongoDB
      │                                     │                                  │
      │─── POST /api/auth/login ───────────>│                                  │
      │    { email, password }              │─── Verify password (bcrypt) ────>│
      │                                     │─── Generate 32-byte raw token ───│
      │                                     │─── Compute SHA-256 hash ─────────│
      │                                     │─── Store { userId, hash } ──────>│ (TTL: 7 days)
      │<── Set-Cookie: sessionToken ────────│                                  │
      │    (HttpOnly, SameSite=Lax)         │                                  │
      │                                     │                                  │
      │─── Request with Cookie ────────────>│                                  │
      │                                     │─── Hash cookie token (SHA-256) ──│
      │                                     │─── Look up session document ────>│
      │                                     │─── Attach req.userId ────────────│
      │<── Processed Response ──────────────│                                  │
```

- **Cryptographic Token Generation**: 64-character hex token generated via `crypto.randomBytes(32)`.
- **Hashed Storage**: MongoDB stores only the **SHA-256 hash** (`sessionTokenHash`). Even if the database is leaked, valid session tokens cannot be derived.
- **Cookie Flags**: Delivered with `HttpOnly: true` (blocking client-side JavaScript access) and `SameSite: "lax"`.
- **Automatic TTL Expiry**: Sessions expire after 7 days via a native MongoDB TTL index on `expiresAt`.
- **Zero-Trust Identity**: Senders are resolved strictly server-side from `req.userId` attached by `authMiddleware`. Request body sender parameters are never trusted.

---

## Database Models & Indexes

### Schema Models Summary

| Model | Collection | Primary Responsibility | Key Attributes |
| :--- | :--- | :--- | :--- |
| **`User`** | `users` | Human identity & login credentials | `name`, `phone` (unique), `email` (sparse, unique), `hashPswd`, `status` (`ACTIVE`, `BLOCKED`) |
| **`Account`** | `accounts` | Financial accounting identity | `userId` (ref `User`, null for system), `accountType` (`USER_WALLET`, `BANK_SUSPENSE`, `PLATFORM_REVENUE`, `SETTLEMENT_POOL`), `currency`, `status` |
| **`Wallet`** | `wallets` | Fast mutable balance projection | `userId` (unique), `accountId` (ref `Account`, unique), `availableBalance` (integer Paise, $\ge 0$) |
| **`PaymentIntent`** | `paymentintents` | Durable request state & idempotency | `userId`, `senderAccountId`, `receiverAccountId`, `amount` (Paise), `currency`, `idempotencyKey`, `transactionId`, `status` (`RECEIVED`, `PROCESSING`, `SUCCESS`, `FAILED`) |
| **`Transaction`** | `transactions` | Business event record | `transactionId` (unique), `type` (`P2P_TRANSFER`, `ADD_MONEY`), `senderAccountId`, `receiverAccountId`, `amount`, `status` (`INITIATED`, `PROCESSING`, `SUCCESS`, `FAILED`, `REVERSED`) |
| **`LedgerEntry`** | `ledgerentries` | Immutable double-entry financial record | `transactionId` (ref `Transaction`), `accountId` (ref `Account`), `entryType` (`DEBIT`, `CREDIT`), `amount` (Paise), `currency` |
| **`Session`** | `sessions` | Active authenticated device session | `userId` (ref `User`), `sessionTokenHash` (unique), `expiresAt` (TTL), `revokedAt` |
| **`IdempotencyKey`** | `idempotencykeys`| Request deduplication store | `userId`, `key`, `requestFingerprint`, `status` (`IN_PROGRESS`, `COMPLETED`), `transactionId`, `response`, `expiresAt` (TTL) |

### Database Index Specifications

```javascript
// User uniqueness
users.phone: { unique: true }
users.email: { unique: true, sparse: true }

// Session security & automated cleanup
sessions.sessionTokenHash: { unique: true }
sessions.expiresAt: { expireAfterSeconds: 0 }  // Native MongoDB TTL cleanup

// Durable Idempotency
paymentintents.{ userId: 1, idempotencyKey: 1 }: { unique: true }
idempotencykeys.{ userId: 1, key: 1 }: { unique: true }
idempotencykeys.expiresAt: { expireAfterSeconds: 0 }

// Financial Audit & Query Performance
transactions.transactionId: { unique: true }
ledgerentries.transactionId: { index: true }
ledgerentries.accountId: { index: true }
```

---

## Validation Rules

Incoming requests are strictly validated using **Zod** before executing business logic:

| Schema | File | Field | Validation Rules | Error Message |
| :--- | :--- | :--- | :--- | :--- |
| `registerSchema` | `validator/auth.validator.js` | `name` | String, trimmed, min 2 characters | `"Name must contain at least 2 characters"` |
| `registerSchema` | `validator/auth.validator.js` | `phone` | String, 10-digit regex (`^\d{10}$`) | `"Phone must be a valid 10-digit number"` |
| `registerSchema` | `validator/auth.validator.js` | `email` | Optional, trimmed, valid email format | `"Invalid email address"` |
| `registerSchema` | `validator/auth.validator.js` | `password` | String, min 6 characters | `"Password must contain at least 6 characters"` |
| `loginSchema` | `validator/auth.validator.js` | `email` | String, trimmed, valid email format | `"Invalid email address"` |
| `loginSchema` | `validator/auth.validator.js` | `password` | String, min 1 character | `"Password is required"` |
| `addMoneySchema` | `validator/addMoney.validator.js` | `amount` | Number, integer, strictly positive ($> 0$) | `"Number must be positive"`, `"amount must be greater than 0"` |
| `paymentSchema` | `validator/payment.validator.js` | `receiverAccountId` | String, non-empty | `"reciever account ID is required"` |
| `paymentSchema` | `validator/payment.validator.js` | `amount` | Number, integer, strictly positive ($> 0$) | `"amount must be an integer"`, `"amount must be greater than 0"` |

---

## Extended System Blueprint & Future Roadmap

The following sections define the architectural blueprint for upcoming phases of the PayFlow platform.

### Settlement & Finalization

Settlement is the process where financial obligations between transacting entities are cleared.

> [!IMPORTANT]
> **Fintech Principle:** $\text{PAYMENT SUCCESS} \neq \text{SETTLEMENT COMPLETE}$
> A successful wallet transaction signifies instant local authorization. Inter-bank settlement operates asynchronously through clearinghouses (e.g. NPCI, RBI, or central settlement pools).

```text
Payment Instruction ──► Local SUCCESS ──► Settlement Record (PENDING) ──► Clearing Worker ──► SETTLED
```

- **Settlement States:** `PENDING` → `SETTLED` / `FAILED` / `INVESTIGATING`.
- **Settlement Pool Account:** Uses `SETTLEMENT_POOL` system accounts to track pooled bank liabilities during multi-party batch settlement.

---

### Transactional Outbox & Asynchronous Workers

To prevent distributed data inconsistencies between MongoDB commits and message queue publications, PayFlow is designed around the **Transactional Outbox Pattern**:

```text
                     Payment Engine
                           │
                           ▼
                   MongoDB Transaction
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
        Transaction      Ledger       Outbox
                                         │
                                         ▼
                                      COMMIT
                                         │
                                         ▼
                                   Outbox Relay
                                         │
                                         ▼
                                      BullMQ
                                         │
             ┌───────────────────────────┼─────────────────────┐
             ▼                           ▼                     ▼
        Settlement                 Reconciliation        Notification
          Worker                       Worker               Worker
```

1. **Transactional Outbox**: Outbox event records are saved within the same MongoDB transaction as the financial ledger entries.
2. **Outbox Relay**: Reads committed outbox records and publishes them to Redis-backed **BullMQ** job queues.
3. **Worker Idempotency**: Workers check transaction state prior to executing actions, tolerating at-least-once message delivery safely.

---

### Reconciliation & Discrepancy Auditing

Reconciliation audits internal ledger balances against external banking network records:

```text
                External Bank / Network
                           │
                           │ Batch Settlement File
                           ▼
                 Reconciliation Engine
                           │
                     Compare Records
                           │
              ┌────────────┴────────────┐
              ▼                         ▼
            MATCH                    MISMATCH
              │                         │
          No Action              Classify & Resolve
                                        │
                               ┌────────┴────────┐
                               ▼                 ▼
                            Reversal         Adjustment
                               │                 │
                               └────────┬────────┘
                                        ▼
                             New Corrective Ledger
```

- **Match**: PayFlow and external network agree on status and amount.
- **Mismatch Types**:
  - `STATUS_MISMATCH` (e.g. Local `PROCESSING`, External `SUCCESS`).
  - `AMOUNT_MISMATCH` (e.g. Fee discrepancy or partial deduction).
- **Resolution**: Errors are corrected by appending **new double-entry ledger entries**, never by modifying historical records.

---

### Webhooks & Callbacks

External banking simulators notify PayFlow of transaction progress via signed webhook callbacks:

```text
External Gateway ──► POST /webhooks/payment ──► Verify HMAC Signature ──► Check State Machine ──► Apply Idempotently
```

- Defends against duplicate webhooks, delayed callbacks, and out-of-order events.
- Idempotent handler guarantees that duplicate webhooks cause at most one financial effect.

---

### Refunds, Reversals & Adjustments

Corrections strictly preserve historical ledger immutability:
- **Refunds**: Triggered when a completed transaction is returned to the payer (full or partial). Cumulative refunds cannot exceed the original payment amount.
- **Reversals**: Systemic corrections when a transaction timed out or failed mid-stream, returning held funds to the sender.
- **Rule**: Every refund or reversal creates a brand-new `Transaction` and paired `LedgerEntry` records referencing the original `transactionId`.

---

### Financial Invariants & Chaos Testing

Automated testing and continuous invariant checkers verify the following non-negotiable rules:

1. **Double-Entry Invariant**: $\sum \text{DEBIT} = \sum \text{CREDIT}$ across every individual transaction and across the entire platform.
2. **Non-Negative Balance Invariant**: `availableBalance >= 0` for all user wallets at all times.
3. **Idempotency Invariant**: 100 simultaneous duplicate payment requests must produce exactly 1 financial ledger debit and credit.
4. **Race Condition Invariant**: 10 simultaneous transfers of ₹100 from an account holding ₹100 must result in exactly 1 success and 9 rejections.

---

### Deterministic Risk Engine & AI Layer

Risk evaluation and automated financial insights operate as decoupled layers:

```text
Payment Request
      │
      ▼
Deterministic Risk Engine
      │
      ├── ALLOW  ──► Proceed to atomic payment
      ├── VERIFY ──► Challenge with MPIN / OTP
      ├── REVIEW ──► Route to manual review queue
      └── REJECT ──► Decline immediately
      │
      ▼
Async AI Layer (Google Gemini)
      │
      ▼
Natural Language Passbook Summaries & Anomaly Explanations
```

- **Deterministic Core**: Balances and transfers are governed strictly by deterministic code and hard limits.
- **AI Layer**: Consumes immutable transaction and ledger data asynchronously to generate spending analytics, explain flagged anomalies, and provide natural language passbook summaries without direct mutation privileges.

---

## License

This project is licensed under the MIT License.
