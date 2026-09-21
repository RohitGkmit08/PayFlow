# PayFlow Backend Engine

The core transaction processing and financial ledger backend for **PayFlow**, a production-style fintech wallet system inspired by modern real-time payment systems (such as UPI).

Built with **Node.js**, **Express**, and **MongoDB (Mongoose)**, this backend implements critical fintech engineering patterns:
- **Ledger-Based Double-Entry Accounting**: Balanced, immutable debit and credit ledger records for both P2P transfers and external wallet funding.
- **Strict Entity Separation**: Clear boundaries between user identity (`User`), accounting entities (`Account`), mutable balance projection (`Wallet`), and audit records (`LedgerEntry`).
- **Strict Integer Arithmetic in Paise**: All balances, limits, and amounts are stored and computed strictly as integers in Paise (1 INR = 100 Paise) to prevent floating-point precision loss.
- **Multi-Document ACID Transactions**: Distributed transactions managed through MongoDB sessions (`session.startTransaction()`).
- **Distributed Transaction Resilience**:
  - Outer retry loop automatically handling `TransientTransactionError` (write conflicts, network hiccups) up to 3 attempts.
  - Inner commit retry loop handling `UnknownTransactionCommitResult` up to 3 attempts without repeating monetary operations.
  - Fail-safe `TRANSACTION_COMMIT_UNKNOWN` error escalation returning HTTP `202 Accepted` when commit status is ambiguous.
- **Atomic Conditional Balance Updates**: Balance deductions use MongoDB conditional atomic operators (`$gte` and `$inc`) to eliminate race conditions and overdrafts under concurrent requests.
- **Dual-Layer Idempotency Engine**: Supports client-supplied `Idempotency-Key` HTTP headers with pre-transaction checks, in-transaction duplicate key race resolution (`E11000`), in-progress request locking, and response replay.
- **Financial Velocity Controls**: Hard caps on single transactions (₹50k), cumulative daily top-ups (₹100k), and maximum wallet balance ceilings (₹200k).
- **Stateful, Hashed Session Authentication**: Secure session-cookie authentication using SHA-256 token hashing and `HttpOnly` cookies.
- **Runtime Schema Validation**: Zero-trust request validation powered by **Zod**.

---

## Table of Contents

- [Architecture & Core Concepts](#architecture--core-concepts)
  - [The Financial Accounting Model](#the-financial-accounting-model)
  - [Double-Entry Accounting in PayFlow](#double-entry-accounting-in-payflow)
  - [Money Representation (Paise vs Rupees)](#money-representation-paise-vs-rupees)
  - [Financial Limits & Velocity Controls](#financial-limits--velocity-controls)
  - [Session Authentication Architecture](#session-authentication-architecture)
- [Transaction Engine & Concurrency Safety](#transaction-engine--concurrency-safety)
  - [The 6-Stage Payment Lifecycle](#the-6-stage-payment-lifecycle)
  - [Dual-Layer Idempotency Engine](#dual-layer-idempotency-engine)
  - [Atomic Conditional Balance Updates](#atomic-conditional-balance-updates)
  - [Distributed Transaction Resilience & Retries](#distributed-transaction-resilience--retries)
  - [Unknown Commit Result & HTTP 202 Flow](#unknown-commit-result--http-202-flow)
- [Directory Structure](#directory-structure)
- [Database Models](#database-models)
- [API Reference](#api-reference)
  - [Health Check](#health-check)
  - [Authentication Endpoints (`/api/auth`)](#authentication-endpoints)
  - [Wallet Endpoints (`/api/wallet`)](#wallet-endpoints)
  - [Payment Endpoints (`/api/payments`)](#payment-endpoints)
- [Validation Rules](#validation-rules)
- [Getting Started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [Environment Variables](#environment-variables)
  - [Installation & Local Run](#installation--local-run)
- [Security & Resilience Summary](#security--resilience-summary)


---

## Architecture & Core Concepts

### The Financial Accounting Model

PayFlow enforces a strict separation between **identity**, **financial accounting entities**, **fast mutable balance state**, and **immutable transaction audit logs**:

```text
                         USER (Identity & Auth)
                                   │
                                   ▼
                        ACCOUNT (Financial Entity)
                       (USER_WALLET, BANK_SUSPENSE,
                       PLATFORM_REVENUE, SETTLEMENT_POOL)
                                   │
                   ┌────────────────┴────────────────┐
                   ▼                                 ▼
          LEDGER ENTRIES                     WALLET (Balance State)
      (Immutable Append-Only Audit)          (Fast Mutable View for UI)
```

1. **User (`User`)**: Represents the human identity holding login credentials (`hashPswd`), phone number, and email.
2. **Account (`Account`)**: The accounting identity participating in transactions. A user owns an account of type `USER_WALLET`. System accounts (`BANK_SUSPENSE`, `PLATFORM_REVENUE`, `SETTLEMENT_POOL`) represent platform entities and external banking integrations.
3. **Wallet (`Wallet`)**: A fast, cached view of available funds for rapid user balance queries. **The wallet is a mutable projection, not the source of financial truth; the ledger is.** If wallet balances ever desynchronize, they can be reconstructed from ledger history.
4. **Transaction (`Transaction`)**: Represents a high-level business event (`P2P_TRANSFER`, `ADD_MONEY`) along with its lifecycle state (`INITIATED` -> `PROCESSING` -> `SUCCESS` / `FAILED` / `REVERSED`).
5. **Ledger Entry (`LedgerEntry`)**: The immutable proof of money movement following double-entry bookkeeping. Every financial event generates paired debit and credit entries that balance to zero.

---

### Double-Entry Accounting in PayFlow

Every transaction in PayFlow satisfies the fundamental accounting equation:

$$\sum \text{Debits} = \sum \text{Credits}$$

#### 1. Add Money / External Top-Up (`ADD_MONEY`)
When a user loads money into their wallet from an external bank:
- The system's **`BANK_SUSPENSE`** account is **DEBITED**.
- The user's **`USER_WALLET`** account is **CREDITED**.
- The user's `Wallet.availableBalance` increases by the added amount.

```text
[BANK_SUSPENSE Account] ──(DEBIT ₹500)──> [User USER_WALLET Account] ──(CREDIT ₹500)
                                                    │
                                                    ▼
                                       User Wallet Balance += ₹500
```

#### 2. Peer-to-Peer Transfer (`P2P_TRANSFER`)
When User A sends money to User B:
- User A's **`USER_WALLET`** account is **DEBITED**.
- User B's **`USER_WALLET`** account is **CREDITED**.
- User A's `Wallet.availableBalance` decreases, and User B's increases.
- Wrapped in an atomic MongoDB transaction session (`startTransaction()`).

```text
[Sender Account] ──(DEBIT ₹300)──> [Receiver Account] ──(CREDIT ₹300)
       │                                     │
       ▼                                     ▼
Sender Balance -= ₹300              Receiver Balance += ₹300
```

---

### Money Representation (Paise vs Rupees)

> [!IMPORTANT]
> **No floating-point numbers are used for monetary calculations or database storage.**
> Storing amounts as `10.50` in IEEE 754 floating-point numbers causes precision drift (e.g., `0.1 + 0.2 !== 0.3`).
> All balances, limits, and transaction amounts are stored strictly as **integers in Paise** (1 INR = 100 paise).
>
> - ₹1.00 = `100` paise
> - ₹500.00 = `50000` paise
> - ₹50,000.00 = `5000000` paise

---

### Financial Limits & Velocity Controls

To safeguard against fraud, unauthorized loading, and excessive risk exposure, the wallet funding workflow (`addMoney`) enforces strict tiered limits:

| Limit Type | Value in Rupees | Value in Paise | Error Triggered |
| :--- | :--- | :--- | :--- |
| **Max Per-Transaction Add Money** | ₹50,000 | `5,000,000` | `"Transaction amount limit exceeded"` |
| **Max Cumulative Daily Add Money** | ₹1,00,000 | `10,000,000` | `"Daily add-money limit exceeded"` |
| **Max Wallet Balance Cap** | ₹2,00,000 | `20,000,000` | `"Wallet balance limit exceeded"` |

- **Daily limit calculation**: Aggregates all successful `ADD_MONEY` transactions for the user's account between `00:00:00.000` and `23:59:59.999` of the current day.
- **Wallet balance cap**: Verifies that `userWallet.availableBalance + amount <= MAX_WALLET_BALANCE` prior to initiating the movement.

---

### Session Authentication Architecture

Rather than stateless JWTs (which cannot be revoked immediately without distributed blacklists and are often stored in accessible browser storage), PayFlow uses a **stateful, hashed session-cookie pattern**:

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

- **Token Generation**: Raw token is a 64-character hex string generated via `crypto.randomBytes(32)`.
- **Database Storage**: The database stores exclusively the **SHA-256 hash** (`sessionTokenHash`). Even in the event of a database leak, valid session cookies cannot be synthesized.
- **Cookie Security**: Delivered with `HttpOnly: true`, `SameSite: "lax"`, and `Secure: true` in production environments.
- **Automatic TTL Expiry**: Sessions expire after 7 days via a native MongoDB TTL index on `expiresAt`.

---

## Transaction Engine & Concurrency Safety

The core P2P payment service (`backend/src/services/payment.service.js`) implements an enterprise-grade, fault-tolerant transaction pipeline designed to handle network failures, concurrent race conditions, write conflicts, and ambiguous commit states:

```text
                    ┌───────────────────────────────┐
                    │  Client sends Payment Request │
                    │ (Header: Idempotency-Key: K)  │
                    └───────────────┬───────────────┘
                                    │
                         [Idempotency Check]
                        Key exists in DB for user?
                        ├── Yes: IN_PROGRESS? ──► Error: "Payment is already in progress"
                        │        SUCCESS/FAILED? ──► Return cached Transaction
                        └── No: Proceed to Transaction Loop
                                    │
                                    ▼
                ┌───────────────────────────────────────┐
                │     Transaction Attempt (Max: 3)      │
                │     mongoose.startSession()           │
                │     session.startTransaction()        │
                └───────────────────┬───────────────────┘
                                    │
             1. IDENTIFY ───────────┤ Resolve User, Account, Wallet for Sender & Receiver
             2. VALIDATE ───────────┤ Sender != Receiver check
             3. CREATE ─────────────┤ Insert Transaction ("INITIATED")
             4. IDEMPOTENCY ────────┤ Insert IdempotencyKey (Catch duplicate key 11000)
             5. MOVE ───────────────┤ Atomic Conditional Debit (availableBalance >= amount)
                                    │ Credit Receiver Balance
             6. RECORD ─────────────┤ Insert DEBIT & CREDIT LedgerEntry records
             7. COMPLETE ───────────┤ Set Transaction status = "SUCCESS"
                                    │
                                    ▼
                ┌───────────────────────────────────────┐
                │         Commit Phase (Max: 3)         │
                │       session.commitTransaction()     │
                └───────────────────┬───────────────────┘
                                    │
             ├── Succeeded ─────────┴─► Return Transaction (200 OK)
             │
             ├── UnknownTransactionCommitResult?
             │   ├── Retry Commit ONLY (attempt < 3)
             │   └── Attempts Exhausted ──► Throw TRANSACTION_COMMIT_UNKNOWN
             │                              └── Controller returns 202 Accepted
             │
             └── TransientTransactionError during operations?
                 └── Abort transaction & Retry Whole Loop (attempt < 3)
```

### The 6-Stage Payment Lifecycle

Every P2P transfer strictly follows the sequence: **IDENTIFY → VALIDATE → CREATE → MOVE → RECORD → COMPLETE**:

1. **`IDENTIFY`**:
   - Resolves sender's `User`, active `USER_WALLET` `Account`, and `Wallet` using `req.userId`.
   - Resolves receiver's active `USER_WALLET` `Account` and `Wallet` using `receiverAccountId`.
   - All lookups are attached to the active MongoDB transaction session (`.session(session)`).
2. **`VALIDATE`**:
   - Asserts `!senderAccount._id.equals(receiverAccount._id)` to block self-transfers.
3. **`CREATE`**:
   - Generates a unique transaction identifier (`TXN-<timestamp>-<random>`).
   - Inserts the `Transaction` document with `status: "INITIATED"` inside the session.
4. **`IDEMPOTENCY`**:
   - Attempts to insert `IdempotencyKey` record bound to `senderUserId` and `idempotencyKey` with a 24-hour expiration TTL.
   - Handles concurrent request races (see [Dual-Layer Idempotency Engine](#dual-layer-idempotency-engine)).
5. **`MOVE`**:
   - Debits sender's balance using an atomic conditional update (`$gte` + `$inc`).
   - Credits receiver's balance (`$inc`).
6. **`RECORD`**:
   - Inserts an immutable `DEBIT` `LedgerEntry` for the sender's account.
   - Inserts an immutable `CREDIT` `LedgerEntry` for the receiver's account.
7. **`COMPLETE`**:
   - Updates `Transaction.status = "SUCCESS"`.
   - Executes the commit retry loop (`session.commitTransaction()`).

---

### Dual-Layer Idempotency Engine

Payment APIs must guarantee that duplicate HTTP requests (from client retries, double-clicks, or dropped connections) never trigger duplicate fund transfers:

#### Layer 1: Pre-Transaction Cache Check
Before opening a database session, the service checks if an `IdempotencyKey` already exists for `{ userId: senderUserId, key: idempotencyKey }`:
- **If transaction is still in progress** (`INITIATED` or `PROCESSING`), it immediately throws `"Payment is already in progress"` to prevent concurrent re-entrancy.
- **If transaction already succeeded or failed** (`SUCCESS` or `FAILED`), it bypasses the transaction logic and returns the existing transaction result immediately.

#### Layer 2: In-Transaction Concurrent Race Resolution
If two identical requests arrive simultaneously, both might pass the pre-transaction check. Inside the transaction session, both attempt to insert an `IdempotencyKey`. The compound unique index on `{ userId: 1, key: 1 }` guarantees that only one succeeds:
1. The losing request catches MongoDB duplicate-key error (`err.code === 11000`).
2. The losing transaction is immediately rolled back (`session.abortTransaction()`).
3. It fetches the idempotency record and associated transaction created by the winning request.
4. If the winning request is still processing, it returns `"Payment is already in progress"`.
5. If the winning request has completed (`SUCCESS` or `FAILED`), it returns the completed transaction result to the caller.

---

### Atomic Conditional Balance Updates

Rather than reading balances into memory, checking sufficiency in JavaScript, and saving the document (which is vulnerable to lost updates and race conditions), PayFlow executes an **atomic conditional decrement**:

```javascript
const senderDebit = await Wallet.updateOne(
    {
        _id: senderWallet._id,
        availableBalance: { $gte: amount }
    },
    {
        $inc: {
            availableBalance: -amount
        }
    },
    { session }
);

if (senderDebit.modifiedCount === 0) {
    throw new Error("Insufficient balance");
}
```

- MongoDB tests `availableBalance >= amount` and decrements `availableBalance` in a single atomic database operation.
- If the sender has insufficient funds, `senderDebit.modifiedCount === 0`, and the transaction is aborted immediately. Overdrafts and negative balances are impossible.

---

### Distributed Transaction Resilience & Retries

In a distributed MongoDB replica set, transient network partitions or write lock contention can cause operations to fail temporarily. PayFlow implements a two-tier retry strategy:

#### 1. Whole-Transaction Retries (`TransientTransactionError`)
- Governed by `MAX_ATTEMPTS = 3`.
- If an operation within the transaction throws an error containing the MongoDB label `TransientTransactionError` (such as a concurrent write conflict or primary election):
  - The failed transaction is safely aborted (`session.abortTransaction()`).
  - The session is discarded and a fresh session is initialized.
  - The entire 6-stage lifecycle is retried cleanly.

#### 2. Commit-Only Retries (`UnknownTransactionCommitResult`)
- Governed by `MAX_COMMIT_ATTEMPTS = 3`.
- If `session.commitTransaction()` throws an error with label `UnknownTransactionCommitResult`, it signifies that the commit message was sent, but the driver could not confirm whether the replica set committed it before a network disruption.
- **Fintech Principle**: In this scenario, **only the commit is retried**. The balance movements and ledger entries are **never re-executed**, strictly preventing double debits or credit duplication.

---

### Unknown Commit Result & HTTP 202 Flow

If all 3 commit attempts fail to confirm the commit outcome:
1. The service tags the error with metadata:
   ```javascript
   err.code = "TRANSACTION_COMMIT_UNKNOWN";
   err.transactionId = createdTransaction.transactionId;
   err.idempotencyKey = idempotencyKey;
   ```
2. The outer transaction retry catch recognizes `err.code === "TRANSACTION_COMMIT_UNKNOWN"` and intentionally avoids retrying the transaction, preserving ledger integrity.
3. The payment controller catches this error and responds with **HTTP 202 Accepted**:
   ```json
   {
     "message": "payment status could not be confirmed",
     "status": "UNKNOWN",
     "transactionId": "TXN-1725330000000-48291"
   }
   ```
4. This explicitly informs the client application that the payment has been submitted, but the final outcome is pending automated reconciliation or ledger verification. The client must not re-submit a new payment blindly.

---

## Directory Structure

```text
backend/
├── src/
│   ├── config/
│   │   └── db.js                 # Mongoose connection setup
│   ├── controllers/
│   │   ├── auth.controller.js    # Register, login, and profile (getMe) handlers
│   │   ├── payment.controller.js # P2P payment HTTP handler
│   │   └── wallet.controller.js  # Add money / wallet top-up HTTP handler
│   ├── middleware/
│   │   └── auth.middleware.js    # Session cookie extractor, SHA-256 hasher & authenticator
│   ├── models/
│   │   ├── Accounts.js           # Financial accounts (USER_WALLET, BANK_SUSPENSE, etc.)
│   │   ├── Idempotency.js        # Request deduplication and replay protection store
│   │   ├── LedgerEntry.js        # Immutable double-entry financial records (DEBIT/CREDIT)
│   │   ├── Session.js            # Stateful sessions with SHA-256 hash & TTL auto-expiry
│   │   ├── Transaction.js        # High-level business transaction records
│   │   ├── User.js               # User identity, phone, email, and bcrypt credentials
│   │   └── Wallet.js             # Fast-access available balance model (Paise)
│   ├── routes/
│   │   ├── auth.routes.js        # Auth route definitions (/api/auth)
│   │   ├── payment.routes.js     # Payment route definitions (/api/payments)
│   │   └── wallet.routes.js      # Wallet route definitions (/api/wallet)
│   ├── services/
│   │   ├── payment.service.js    # Atomic P2P transfer workflow with MongoDB transactions
│   │   └── wallet.service.js     # Wallet top-up (add-money) workflow with velocity limits
│   ├── utils/                    # Shared helper functions
│   ├── validator/
│   │   ├── addMoney.validator.js # Zod schema for wallet funding payloads
│   │   ├── auth.validator.js     # Zod schemas for registration & login
│   │   └── payment.validator.js  # Zod schema for P2P payment requests
│   ├── app.js                    # Express app initialization, middleware, and route mounting
│   └── server.js                 # Server entry point & database initialization
├── .env                          # Local environment variables (gitignored)
├── .env.example                  # Environment variable blueprint
├── package.json                  # Dependencies and run scripts
└── README.md                     # Backend documentation
```

---

## Database Models

| Model | Collection | Purpose | Key Attributes |
| :--- | :--- | :--- | :--- |
| **`User`** | `users` | User identity & authentication credentials | `name`, `phone` (unique), `email` (sparse, unique), `hashPswd`, `status` (`ACTIVE`, `BLOCKED`) |
| **`Account`** | `accounts` | Financial accounting identity | `userId` (ref `User`, null for system accounts), `accountType` (`USER_WALLET`, `BANK_SUSPENSE`, `PLATFORM_REVENUE`, `SETTLEMENT_POOL`), `currency` (`INR`), `status` (`ACTIVE`, `BLOCKED`, `CLOSED`) |
| **`Wallet`** | `wallets` | Fast mutable balance snapshot | `userId` (unique), `accountId` (ref `Account`, unique), `availableBalance` (integer paise, $\ge 0$) |
| **`Transaction`** | `transactions` | Business event record | `transactionId` (unique `TXN-...`), `type` (`P2P_TRANSFER`, `ADD_MONEY`), `senderAccountId` (ref `Account`), `receiverAccountId` (ref `Account`), `amount` (paise), `status` (`INITIATED`, `PROCESSING`, `SUCCESS`, `FAILED`, `REVERSED`), `failureReason` |
| **`LedgerEntry`** | `ledgerentries` | Double-entry financial audit record | `transactionId` (ref `Transaction`), `accountId` (ref `Account`), `entryType` (`DEBIT`, `CREDIT`), `amount` (paise), `currency` (`INR`) |
| **`Session`** | `sessions` | Active authenticated device sessions | `userId` (ref `User`), `sessionTokenHash` (unique), `expiresAt` (TTL index), `revokedAt` |
| **`IdempotencyKey`** | `idempotencykeys`| Request deduplication store | `userId`, `key`, `requestFingerprint`, `status` (`IN_PROGRESS`, `COMPLETED`), `transactionId`, `response`, `expiresAt` (TTL index) |

---

## API Reference

### Health Check

#### `GET /`
Checks backend service availability.

- **Request Headers**: None
- **Response `200 OK`**:
```json
{
  "message": "PayFlow Backend",
  "status": "running"
}
```

---

### Authentication Endpoints

Base Path: `/api/auth`

#### 1. Register User
`POST /api/auth/register`

Atomically creates a new `User`, provisions a corresponding `Account` (`accountType: "USER_WALLET"`), and initializes a `Wallet` with `0` balance within an ACID MongoDB transaction session.

- **Request Body**:
```json
{
  "name": "Rohit Sinha",
  "phone": "9876543210",
  "email": "rohit@example.com",
  "password": "SecurePassword123"
}
```
*Notes: `phone` must be a 10-digit number. `email` is optional. `password` minimum length is 6.*

- **Response `201 Created`**:
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

- **Error Responses**:
  - `400 Bad Request`: Input validation failed (invalid phone format, short password, etc.).
  - `409 Conflict`: Phone number or email is already registered.
  - `500 Internal Server Error`: Transaction aborted or internal server error.

---

#### 2. Login User
`POST /api/auth/login`

Verifies credentials via `bcrypt`, validates that the account is not `BLOCKED`, creates a persistent session with a SHA-256 hashed token, and sends an `HttpOnly` cookie back to the client.

- **Request Body**:
```json
{
  "email": "rohit@example.com",
  "password": "SecurePassword123"
}
```

- **Response `200 OK`**:
  - **Headers**:
    ```http
    Set-Cookie: sessionToken=<64-character-hex>; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800
    ```
  - **Body**:
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

- **Error Responses**:
  - `400 Bad Request`: Missing or malformed email/password.
  - `401 Unauthorized`: Invalid email or password.
  - `403 Forbidden`: Account status is `BLOCKED`.
  - `500 Internal Server Error`: Server error during authentication.

---

#### 3. Get Current User Profile
`GET /api/auth/me`

Resolves the authenticated user from the active `sessionToken` cookie.

- **Authentication**: Required (`sessionToken` cookie)
- **Response `200 OK`**:
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

- **Error Responses**:
  - `401 Unauthorized`: Cookie missing, invalid session hash, or expired session.
  - `404 Not Found`: User document not found.
  - `500 Internal Server Error`: Server error.

---

### Wallet Endpoints

Base Path: `/api/wallet`

#### 1. Add Money to Wallet
`POST /api/wallet/add-money`

Loads funds into the authenticated user's wallet from the platform's external banking suspense account (`BANK_SUSPENSE`).

**Execution & Accounting Lifecycle**:
1. **Resolve Identity & Entities**: Identifies user from `req.userId`, finds active `USER_WALLET` account, and locates user's `Wallet`.
2. **Resolve Bank Suspense Account**: Finds (or lazily creates) the platform's active `BANK_SUSPENSE` account.
3. **Validate Velocity & Balance Limits**:
   - Asserts `amount <= 5,000,000` paise (₹50,000 per transaction limit).
   - Asserts `userWallet.availableBalance + amount <= 20,000,000` paise (₹2,00,000 balance ceiling).
   - Queries all successful `ADD_MONEY` transactions for the account today; asserts `todayTotal + amount <= 10,000,000` paise (₹1,00,000 daily limit).
4. **Create Transaction**: Inserts a `Transaction` with `type: "ADD_MONEY"`, `senderAccountId: bankSuspenseAccount._id`, and status `"INITIATED"`.
5. **Update Wallet Balance**: Increments `userWallet.availableBalance` by `amount`.
6. **Record Ledger Entries**:
   - `DEBIT` against `bankSuspenseAccount._id` for `amount`.
   - `CREDIT` against user's `userAccount._id` for `amount`.
7. **Complete Transaction**: Updates transaction status to `"SUCCESS"`.

- **Authentication**: Required (`sessionToken` cookie)
- **Request Body**:
```json
{
  "amount": 500000
}
```
*Note: `amount` must be a positive integer in paise (e.g., `500000` = ₹5,000.00).*

- **Response `201 Created`**:
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

- **Error Responses**:
  - `400 Bad Request`: Validation failure (e.g., non-integer, zero, or negative amount).
    ```json
    {
      "message": "Invalid add-money data",
      "errors": [...]
    }
    ```
  - `401 Unauthorized`: Authentication required or invalid session.
  - `500 Internal Server Error`: Limit exceeded or processing error:
    - `"Transaction amount limit exceeded"`
    - `"Wallet balance limit exceeded"`
    - `"Daily add-money limit exceeded"`
    - `"User account not found"` / `"User wallet not found"`

---

### Payment Endpoints

Base Path: `/api/payments`

#### 1. Execute Peer-to-Peer (P2P) Transfer
`POST /api/payments`

Executes an atomic transfer from the authenticated user's wallet to another user's wallet account using a multi-document MongoDB transaction session with idempotency tracking and commit retry protection.

- **Authentication**: Required (`sessionToken` cookie)
- **Headers**:
  ```http
  Idempotency-Key: <unique-client-generated-key>
  ```
  *(Recommended for all payment requests. Used to guarantee exactly-once processing across network retries).*
- **Request Body**:
```json
{
  "receiverAccountId": "64b8f102a7c1b2c3d4e5f6b2",
  "amount": 50000
}
```
*Note: `amount` must be a positive integer in paise (e.g., `50000` = ₹500.00).*

- **Response `200 OK` (Payment Successful)**:
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

- **Response `202 Accepted` (Commit Status Unknown)**:
Returned when the MongoDB transaction commit attempts encounter `UnknownTransactionCommitResult` and cannot confirm whether the replica set finalized the commit. The transfer may have succeeded; the client must not re-submit the transfer blindly and should query transaction status or await background reconciliation.
```json
{
  "message": "payment status could not be confirmed",
  "status": "UNKNOWN",
  "transactionId": "TXN-1725330000000-48291"
}
```

- **Error Responses**:
  - `400 Bad Request`: Validation failure (empty receiver ID, non-integer or negative amount).
    ```json
    {
      "message": "Invalid input data",
      "errors": [...]
    }
    ```
  - `401 Unauthorized`: Authentication required or invalid/expired session cookie.
  - `500 Internal Server Error`: Business logic failure, insufficient funds, self-transfer attempt, payment already in progress, or transaction abort.
    ```json
    {
      "message": "Internal server error"
    }
    ```


---

## Getting Started

### Prerequisites

- **Node.js**: `v18.x` or higher
- **npm**: `v9.x` or higher
- **MongoDB**: `v5.x` or higher with a **Replica Set** enabled (required for multi-document ACID transactions via `startSession()`). A free cloud cluster on [MongoDB Atlas](https://www.mongodb.com/atlas) works out-of-the-box.

### Environment Variables

Create a `.env` file inside the `backend/` directory by copying `.env.example`:

```bash
cp .env.example .env
```

Configure the following parameters in `backend/.env`:

| Variable | Description | Example / Default |
| :--- | :--- | :--- |
| `PORT` | Port on which the Express server listens | `5000` |
| `NODE_ENV` | Runtime environment (`development` or `production`) | `development` |
| `MONGO_URI` | MongoDB connection URI (must support replica sets / Atlas) | `mongodb+srv://<user>:<password>@cluster0.mongodb.net/payflow` |

### Installation & Local Run

1. Navigate to the `backend` directory:
   ```bash
   cd backend
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Start in development mode (with hot-reload via `nodemon`):
   ```bash
   npm run dev
   ```

4. Start in production mode:
   ```bash
   npm start
   ```

Upon a successful startup, the console will log:
```text
database connected successfully
PayFlow API is running on port 5000
```

---

## Validation Rules

Payloads are strictly validated using **Zod** schemas before reaching controllers or services:

| Schema | File | Field | Validation Rules | Error Message |
| :--- | :--- | :--- | :--- | :--- |
| `registerSchema` | `validator/auth.validator.js` | `name` | String, trimmed, min 2 characters | `"Name must contain at least 2 characters"` |
| `registerSchema` | `validator/auth.validator.js` | `phone` | String, 10-digit regex (`^\d{10}$`) | `"Phone must be a valid 10-digit number"` |
| `registerSchema` | `validator/auth.validator.js` | `email` | Optional, trimmed, lowercase, valid email | `"Invalid email address"` |
| `registerSchema` | `validator/auth.validator.js` | `password` | String, min 6 characters | `"Password must contain at least 6 characters"` |
| `loginSchema` | `validator/auth.validator.js` | `email` | String, trimmed, lowercase, valid email | `"Invalid email address"` |
| `loginSchema` | `validator/auth.validator.js` | `password` | String, min 1 character | `"Password is required"` |
| `addMoneySchema` | `validator/addMoney.validator.js` | `amount` | Number, integer, strictly positive ($> 0$) | `"Number must be positive"`, `"amount must be greater than 0"` |
| `paymentSchema` | `validator/payment.validator.js` | `receiverAccountId` | String, non-empty | `"reciever account ID is required"` |
| `paymentSchema` | `validator/payment.validator.js` | `amount` | Number, integer, strictly positive ($> 0$) | `"amount must be an integer"`, `"amount must be greater than 0"` |

---

## Security & Resilience Summary

### Failure Modes & Defensive Mechanisms

| Threat / Failure Mode | PayFlow Defense Mechanism | Implementation Details |
| :--- | :--- | :--- |
| **Floating-Point Precision Drift** | Strict integer math in Paise | All balances, amounts, and limits are stored in Paise ($100 = ₹1.00$). Floating-point numbers are prohibited. |
| **Balance Overdraft / Concurrency Race** | Atomic conditional decrement | `Wallet.updateOne({ _id, availableBalance: { $gte: amount } }, { $inc: { availableBalance: -amount } })`. Prevents negative balances at database level. |
| **Double-Spending / Duplicate Submission** | Dual-layer idempotency engine | Pre-flight cache lookup + in-transaction insertion into `IdempotencyKey` with unique compound index `{ userId, key }` (catches `E11000`). |
| **Write Conflicts / Primary Election** | Outer transaction retry loop | Retries whole transaction up to 3 times on `TransientTransactionError`, safely aborting and restarting. |
| **Dropped Commit Network Packets** | Isolated commit retry loop | Retries only `session.commitTransaction()` up to 3 times on `UnknownTransactionCommitResult` without re-executing balance debits. |
| **Ambiguous Distributed Commit State** | Fail-safe HTTP 202 escalation | Raises `TRANSACTION_COMMIT_UNKNOWN`, preventing blind retries and returning HTTP `202 Accepted` (`status: "UNKNOWN"`). |
| **Session Theft / Database Leaks** | Hashed stateful sessions | Raw 32-byte tokens are sent via `HttpOnly`, `SameSite=Lax` cookies; only SHA-256 hashes are persisted in MongoDB. |
| **Arbitrary Balance Inflation** | Double-entry invariant | Money is sourced exclusively from `BANK_SUSPENSE`; every debit is strictly paired with an equal credit in `LedgerEntry`. |
| **Runaway Account Exposure** | Tiered velocity controls | Per-transaction cap (₹50,000), cumulative daily limit (₹1,00,000), and max wallet balance cap (₹2,00,000). |

---

### Core Security Best Practices

1. **Monetary Integrity & Ledger Invariance**:
   - Double-entry bookkeeping guarantees that money is never created or destroyed arbitrarily.
   - External top-ups are sourced from the dedicated `BANK_SUSPENSE` system account.
   - Balances are stored strictly as integers in paise, preventing floating-point inaccuracies.
2. **Password Security**:
   - User passwords are encrypted using `bcrypt` with a salt cost factor of 8. Passwords are never stored or logged in plain text.
3. **Session Hardening**:
   - Session tokens are generated using 32 cryptographically secure random bytes (`crypto.randomBytes(32)`).
   - Only the SHA-256 hash is persisted in MongoDB. Stolen database dumps cannot be leveraged to forge valid session cookies.
   - Cookies are protected with `HttpOnly: true` (blocking client-side JavaScript access) and `SameSite: "lax"`.
4. **Velocity & Fraud Mitigation**:
   - Hard limits on individual top-ups (₹50,000) and cumulative daily top-ups (₹1,00,000).
   - Balance cap (₹2,00,000) prevents runaway wallet exposure.
   - Self-transfer guards prevent loops and balance inflation.
5. **Database Indexing & Automated TTL Cleanup**:
   - `users.phone`: Unique index.
   - `users.email`: Sparse unique index.
   - `sessions.sessionTokenHash`: Unique index.
   - `sessions.expiresAt`: Native MongoDB TTL index (`expireAfterSeconds: 0`) for automatic expiration cleanup without background cron workers.
   - `idempotencykeys.{userId, key}`: Compound unique index.
   - `idempotencykeys.expiresAt`: Native MongoDB TTL index (`expireAfterSeconds: 0`) with 24-hour expiration.
   - `transactions.transactionId`: Unique indexed transaction reference.
   - `ledgerentries.transactionId` & `ledgerentries.accountId`: Indexed for high-throughput audit queries and reconciliation.

