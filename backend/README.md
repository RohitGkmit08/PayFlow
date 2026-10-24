# PayFlow Backend Engine

The core transaction processing, financial accounting, and double-entry ledger backend for **PayFlow**, a production-style fintech wallet system inspired by modern real-time payment systems (such as UPI).

Built with **Node.js**, **Express**, and **MongoDB (Mongoose)**, this backend implements enterprise-grade fintech engineering patterns:
- **Ledger-Based Double-Entry Accounting**: Balanced, immutable debit and credit ledger records for both P2P transfers and external wallet funding ($\sum \text{Debits} = \sum \text{Credits}$).
- **Strict Entity Separation**: Clear architectural boundaries between user identity (`User`), accounting entities (`Account`), mutable balance projection (`Wallet`), and audit records (`LedgerEntry`).
- **Strict Integer Arithmetic in Paise**: All balances, limits, and amounts are stored and computed strictly as integers in Paise (1 INR = 100 Paise) to prevent floating-point precision loss.
- **Multi-Document ACID Transactions**: Distributed transactions managed through MongoDB replica set sessions (`session.startTransaction()`) with snapshot isolation.
- **Two-Tier Distributed Transaction Resilience**:
  - Outer retry loop automatically handling `TransientTransactionError` (write conflicts, replica set elections) up to 3 attempts.
  - Inner commit retry loop handling `UnknownTransactionCommitResult` up to 3 attempts without repeating monetary operations.
  - Fail-safe `TRANSACTION_COMMIT_UNKNOWN` error escalation returning HTTP `202 Accepted` when commit status is ambiguous.
- **Atomic Conditional Balance Updates**: Balance deductions use MongoDB conditional atomic operators (`$gte` and `$inc`) to eliminate race conditions and overdrafts under concurrent requests.
- **Durable Payment Tracking with PaymentIntent**: Dedicated `PaymentIntent` lifecycle model (`RECEIVED` → `PROCESSING` → `SUCCESS` / `FAILED`) created outside the financial MongoDB transaction to survive rollbacks, transient write conflicts, and ambiguous commits.
- **Idempotency & Request Fingerprinting**: Strict idempotency using client-provided `Idempotency-Key` headers enforced via compound unique indexing (`{ userId, idempotencyKey }`) and SHA-256 request fingerprinting, preventing double-payments and serializing concurrent duplicate attempts.
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
  - [The End-to-End Payment Pipeline](#the-end-to-end-payment-pipeline)
  - [Durable PaymentIntent Pattern & SHA-256 Request Fingerprinting](#durable-paymentintent-pattern--sha-256-request-fingerprinting)
  - [Atomic Conditional Balance Updates](#atomic-conditional-balance-updates)
  - [Distributed Transaction Resilience & Retries](#distributed-transaction-resilience--retries)
  - [Unknown Commit Result & HTTP 202 Flow](#unknown-commit-result--http-202-flow)
- [Directory Structure](#directory-structure)
- [Database Models & Index Specifications](#database-models--index-specifications)
- [Validation Reference (Zod)](#validation-reference-zod)
- [API Reference](#api-reference)
  - [Health Check](#health-check)
  - [Authentication Endpoints (`/api/auth`)](#authentication-endpoints)
  - [Wallet Endpoints (`/api/wallet`)](#wallet-endpoints)
  - [Payment Endpoints (`/api/payments`)](#payment-endpoints)
- [Getting Started & Local Setup](#getting-started--local-setup)
  - [Prerequisites & Replica Set Requirement](#prerequisites--replica-set-requirement)
  - [Environment Variables](#environment-variables)
  - [Installation & Local Run](#installation--local-run)
- [End-to-End cURL Testing Walkthrough](#end-to-end-curl-testing-walkthrough)
- [Security & Resilience Summary](#security--resilience-summary)

---

## Architecture & Core Concepts

### The Financial Accounting Model

PayFlow enforces a strict separation between **identity**, **financial accounting entities**, **durable payment intent**, **fast mutable balance state**, and **immutable transaction audit logs**:

```text
                         USER (Identity & Auth)
                                   │
                                   ▼
                        ACCOUNT (Financial Entity)
                       (USER_WALLET, BANK_SUSPENSE,
                       PLATFORM_REVENUE, SETTLEMENT_POOL)
                                   │
        ┌──────────────────────────┼──────────────────────────┐
        ▼                          ▼                          ▼
  PAYMENT INTENT            LEDGER ENTRIES             WALLET (Balance)
(Durable Request State)  (Immutable Audit Record)  (Fast Mutable Projection)
        │                          │
        └─────────────► TRANSACTION ◄─────────────┘
                     (Financial Event)
```

1. **User (`User`)**: Represents the human identity holding login credentials (`hashPswd`), phone number, and email. Has zero financial balance fields.
2. **Account (`Account`)**: The accounting identity participating in transactions. A user owns an account of type `USER_WALLET`. System accounts (`BANK_SUSPENSE`, `PLATFORM_REVENUE`, `SETTLEMENT_POOL`) represent platform entities and external clearinghouses.
3. **Wallet (`Wallet`)**: A fast, cached view of available funds for rapid user balance queries. **The wallet is a mutable projection, not the source of financial truth; the ledger is.** If wallet balances ever desynchronize, they can be reconstructed from ledger history.
4. **PaymentIntent (`PaymentIntent`)**: The durable request state machine (`RECEIVED` → `PROCESSING` → `SUCCESS` / `FAILED`) created outside the financial transaction boundary. It ensures that payment requests, in-flight locks, and idempotency keys survive any transaction aborts, rollbacks, or network failures.
5. **Transaction (`Transaction`)**: Represents a high-level business event (`P2P_TRANSFER`, `ADD_MONEY`) along with its lifecycle state (`INITIATED` -> `PROCESSING` -> `SUCCESS` / `FAILED` / `REVERSED`). Created inside the multi-document ACID transaction.
6. **Ledger Entry (`LedgerEntry`)**: The immutable proof of money movement following double-entry bookkeeping. Every financial event generates paired debit and credit entries that balance to zero.

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
- Wrapped in an atomic MongoDB transaction session (`session.startTransaction()`).

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

Mongoose schema validation explicitly enforces integer constraints on all balance and amount fields:
```javascript
validate: {
  validator: Number.isInteger,
  message: "balance must be an integer representing paise"
}
```

---

### Financial Limits & Velocity Controls

To safeguard against fraud, unauthorized loading, and excessive risk exposure, the wallet funding workflow (`backend/src/services/wallet.service.js`) enforces strict tiered limits:

| Limit Policy | Value in Rupees | Value in Paise | Error Triggered |
| :--- | :--- | :--- | :--- |
| **Max Per-Transaction Top-Up** | ₹50,000 | `5,000,000` | `"Transaction amount limit exceeded"` |
| **Max Cumulative Daily Top-Up** | ₹1,00,000 | `10,000,000` | `"Daily add-money limit exceeded"` |
| **Max Wallet Balance Cap** | ₹2,00,000 | `20,000,000` | `"Wallet balance limit exceeded"` |

- **Daily limit calculation**: Aggregates all successful `ADD_MONEY` transactions for the user's account between `00:00:00.000` and `23:59:59.999` of the current calendar day:
  ```javascript
  const todayTransaction = await Transaction.find({
    type: "ADD_MONEY",
    receiverAccountId: userAccount._id,
    status: "SUCCESS",
    createdAt: { $gte: startOfDay, $lt: endOfDay }
  });
  ```
- **Wallet balance cap**: Verifies that `userWallet.availableBalance + amount <= MAX_WALLET_BALANCE` prior to initiating the movement.

---

### Session Authentication Architecture

Rather than stateless JWTs (which cannot be revoked immediately without distributed blacklists and are vulnerable to client-side token theft), PayFlow uses a **stateful, hashed session-cookie pattern**:

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

- **Token Generation**: Raw token is a 64-character hex string generated via `crypto.randomBytes(32).toString("hex")`.
- **Database Storage**: The database stores exclusively the **SHA-256 hash** (`sessionTokenHash`). Even in the event of a database compromise, valid session cookies cannot be synthesized.
- **Cookie Security**: Delivered with `HttpOnly: true`, `SameSite: "lax"`, and `Secure: true` in production environments (`maxAge: 7 days`).
- **Automatic TTL Expiry**: Sessions expire after 7 days via a native MongoDB TTL index on `expiresAt` (`expireAfterSeconds: 0`).
- **Atomic User Provisioning**: User registration uses a MongoDB transaction session to atomically create the `User`, the corresponding `Account` (`USER_WALLET`), and the `Wallet` (`availableBalance: 0`).

---

## Transaction Engine & Concurrency Safety

### The End-to-End Payment Pipeline

The core P2P payment service (`backend/src/services/payment.service.js`) implements a fault-tolerant transaction pipeline designed to handle network failures, concurrent race conditions, write conflicts, and ambiguous commit states:

```text
                    ┌───────────────────────────────┐
                    │  Client sends Payment Request │
                    │ (Header: Idempotency-Key: K)  │
                    └───────────────┬───────────────┘
                                    │
                    [1. Durable Idempotency Check]
                 PaymentIntent exists for {userId, K}?
                 ├── Yes:
                 │   ├── PROCESSING? ──► Has txnId (SUCCESS)? ──► Return cached Transaction (200 OK)
                 │   │                                        └── Throw 202: "Payment is still processing..."
                 │   ├── SUCCESS? ──► Return cached Transaction (200 OK)
                 │   └── FAILED? ──► Throw 409: "This payment request has already failed"
                 └── No: Proceed
                                    │
                    [2. Pre-Transaction Resolution]
                    Resolve Sender (User, Account, Wallet)
                    Resolve Receiver (Account, Wallet)
                    Validate Sender Account != Receiver Account
                    Compute SHA-256 Request Fingerprint
                                    │
                 [3. Create Durable PaymentIntent (Outside Session)]
                    Insert PaymentIntent (status: "PROCESSING")
                    ├── Duplicate Key (E11000 race)?
                    │   └── Fetch existing PaymentIntent & resolve outcome
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
             3. CREATE TXN ─────────┤ Insert Transaction (status: "INITIATED", id: TXN-UUID)
             4. DEBIT SENDER ───────┤ Atomic Conditional: availableBalance >= amount ($inc: -amount)
             5. CREDIT RECEIVER ────┤ Atomic Update: $inc: { availableBalance: amount }
             6. RECORD LEDGER ──────┤ Insert paired DEBIT and CREDIT LedgerEntry records
             7. COMPLETE TXN ───────┤ Set Transaction status = "SUCCESS"
             8. LINK INTENT ────────┤ Set paymentIntent.transactionId = txn._id (in session)
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

### Durable PaymentIntent Pattern & SHA-256 Request Fingerprinting

#### 1. Why In-Transaction Idempotency Fails in Distributed Systems
In traditional transaction architectures, idempotency records are written inside the transaction session. This creates a critical design flaw:
- If a transaction aborts (e.g., due to write conflicts, insufficient balance, or a network timeout), **the idempotency record is rolled back alongside the financial operations**.
- The database loses all record that an attempt occurred.
- A subsequent retry arrives with a clean slate, creating vulnerability to duplicate charges or untraceable processing states.
- If commit outcome is unknown (`UnknownTransactionCommitResult`), the server cannot safely record status inside the session.

#### 2. The PaymentIntent Solution: Decoupled Lifecycle Tracking
PayFlow solves this by decoupling **payment intent** from **ledger execution**:
- The `PaymentIntent` document is created **prior to and outside** the financial transaction.
- It acts as an immutable durable anchor that survives transaction aborts, rollbacks, and replica set failovers.

```text
PaymentIntent States:
[RECEIVED] ──► [PROCESSING] ──┬──(Commit Succeeded)──► [SUCCESS]
                              │
                              ├──(Non-Retryable Error)──► [FAILED]
                              │
                              └──(Commit Unknown)──────► [PROCESSING (Awaiting Reconciliation)]
```

- **`RECEIVED`**: Default schema state prior to execution.
- **`PROCESSING`**: Intent established; financial transaction in-flight or commit status pending reconciliation.
- **`SUCCESS`**: Financial transaction committed; funds transferred; linked to `Transaction._id`.
- **`FAILED`**: Aborted due to business rule validation, insufficient balance, or exhausted retry attempts.

#### 3. SHA-256 Request Fingerprinting
PayFlow binds every `Idempotency-Key` to the specific parameters of the transfer by computing a SHA-256 canonical hash:
```javascript
function createRequestFingerprint({ senderAccountId, receiverAccountId, amount, currency }) {
  const canonicalRequest = JSON.stringify({
    senderAccountId: String(senderAccountId),
    receiverAccountId: String(receiverAccountId),
    amount,
    currency,
  });

  return crypto
    .createHash("sha256")
    .update(canonicalRequest)
    .digest("hex");
}
```
If a client submits the same `Idempotency-Key` with different receiver accounts, amounts, or currencies, `findExistingIntent` rejects the request with HTTP `409 Conflict` (`IDEMPOTENCY_KEY_REUSED`), defending against payload tampering or accidental key reuse.

#### 4. Concurrent Race Serialization via Unique Compound Index
The `PaymentIntent` collection enforces a compound unique index:
```javascript
paymentIntentSchema.index(
  { userId: 1, idempotencyKey: 1 },
  { unique: true }
);
```
When two identical requests arrive simultaneously:
1. The first request successfully inserts the `PaymentIntent` with status `"PROCESSING"` and claims ownership of the transaction execution.
2. The concurrent duplicate request fails with MongoDB duplicate key error `E11000`.
3. The catch block handles `E11000` by querying the existing `PaymentIntent`:
   - If still `"PROCESSING"`, returns HTTP `202 Accepted` (`"Payment is still processing or its outcome is unresolved"`).
   - If already completed (`"SUCCESS"`), retrieves the finalized `Transaction` and returns it immediately (`200 OK`).
   - If already marked `"FAILED"`, returns HTTP `409 Conflict` (`"This payment request has already failed"`).

#### 5. Post-Commit Asynchronous Decoupling
Once `session.commitTransaction()` succeeds, the financial truth (the ledger and wallet balances) is durable in the database.
- Updating `PaymentIntent` to `"SUCCESS"` occurs outside the transaction in an isolated `try/catch`.
- If an auxiliary error occurs while updating `PaymentIntent`, the error is swallowed:
  ```javascript
  try {
    await PaymentIntent.updateOne(
      { _id: paymentIntent._id },
      { $set: { status: "SUCCESS", transactionId: createdTransaction._id } }
    );
  } catch (error) {
    // Leave PROCESSING for reconciliation.
    // Never execute the payment again because this update failed.
  }
  ```
  This ensures that a secondary status update failure never causes an already-committed financial transaction to fail or be re-executed.

---

### Atomic Conditional Balance Updates

Rather than reading balances into memory, checking sufficiency in JavaScript, and saving the document (which is vulnerable to lost updates and race conditions), PayFlow executes an **atomic conditional decrement**:

```javascript
const debit = await Wallet.updateOne(
  {
    _id: accounts.senderWallet._id,
    availableBalance: { $gte: amount },
  },
  {
    $inc: { availableBalance: -amount },
  },
  { session }
);

if (debit.modifiedCount !== 1) {
  throw createServiceError(
    "Insufficient balance",
    "INSUFFICIENT_BALANCE",
    400
  );
}
```

- MongoDB verifies `availableBalance >= amount` and decrements `availableBalance` in a single atomic database operation.
- If the sender has insufficient funds, `debit.modifiedCount !== 1`, and the transaction aborts immediately. Overdrafts and negative balances are impossible.

---

### Distributed Transaction Resilience & Retries

In a distributed MongoDB replica set, transient network partitions or write lock contention can cause operations to fail temporarily. PayFlow implements a two-tier retry strategy:

#### 1. Whole-Transaction Retries (`TransientTransactionError`)
- Governed by `MAX_TRANSACTION_ATTEMPTS = 3`.
- If an operation within the transaction throws an error with the label `TransientTransactionError` (such as a concurrent write conflict or primary election):
  - The failed transaction is safely aborted (`session.abortTransaction()`).
  - The session is discarded and a fresh session is initialized.
  - The transactional execution attempt is retried cleanly up to `MAX_TRANSACTION_ATTEMPTS = 3`.
  - If retries are exhausted, calls `markIntentFailedIfSafe(paymentIntent._id)` and throws `TRANSACTION_RETRY_EXHAUSTED` (HTTP 503).

#### 2. Commit-Only Retries (`UnknownTransactionCommitResult`)
- Governed by `MAX_COMMIT_ATTEMPTS = 3`.
- If `session.commitTransaction()` throws an error with label `UnknownTransactionCommitResult`, it signifies that the commit message was sent, but the driver could not confirm whether the replica set committed it before a network disruption.
- **Fintech Principle**: In this scenario, **only the commit is retried**. The balance movements and ledger entries are **never re-executed**, strictly preventing double debits or credit duplication.

---

### Unknown Commit Result & HTTP 202 Flow

If all 3 commit attempts fail to confirm the commit outcome:
1. The service tags the error with metadata:
   ```javascript
   error.code = "TRANSACTION_COMMIT_UNKNOWN";
   error.transactionId = createdTransaction.transactionId;
   error.paymentIntentId = String(paymentIntent._id);
   error.idempotencyKey = idempotencyKey;
   ```
2. The outer transaction retry catch recognizes `error.code === "TRANSACTION_COMMIT_UNKNOWN"` and intentionally avoids retrying the transaction, preserving ledger integrity.
3. The `PaymentIntent` record intentionally remains in `status: "PROCESSING"`. Because the durable intent is created outside the session, its in-progress state is preserved. Any subsequent retry using the same `Idempotency-Key` safely blocks with HTTP `202 Accepted` rather than duplicate-executing.
4. The payment controller catches this error and responds with **HTTP 202 Accepted**:
   ```json
   {
     "message": "payment status could not be confirmed",
     "status": "UNKNOWN",
     "transactionId": "TXN-a1b2c3d4-e5f6-7890-abcd-ef1234567890"
   }
   ```
5. This explicitly informs the client application that the payment has been submitted, but the final outcome is pending automated reconciliation or ledger verification. The client must not re-submit a new payment blindly.

---

## Directory Structure

```text
backend/
├── src/
│   ├── config/
│   │   └── db.js                 # Mongoose connection setup with replica set support
│   ├── controllers/
│   │   ├── auth.controller.js    # Register, login, and getMe profile handlers
│   │   ├── payment.controller.js # P2P payment HTTP handler with 202 escalation
│   │   └── wallet.controller.js  # Add money / wallet top-up HTTP handler
│   ├── middleware/
│   │   └── auth.middleware.js    # Session cookie extractor, SHA-256 hasher & authenticator
│   ├── models/
│   │   ├── Accounts.js           # Financial accounts (USER_WALLET, BANK_SUSPENSE, etc.)
│   │   ├── Idempotency.js        # Request deduplication and replay protection store
│   │   ├── LedgerEntry.js        # Immutable double-entry financial records (DEBIT/CREDIT)
│   │   ├── PaymentIntent.js      # Durable payment intent tracking and idempotency store
│   │   ├── Session.js            # Stateful sessions with SHA-256 hash & TTL auto-expiry
│   │   ├── Transaction.js        # High-level business transaction records
│   │   ├── User.js               # User identity, phone, email, and bcrypt credentials
│   │   └── Wallet.js             # Fast-access available balance model (Paise integer)
│   ├── routes/
│   │   ├── auth.routes.js        # Auth route definitions (/api/auth)
│   │   ├── payment.routes.js     # Payment route definitions (/api/payments)
│   │   └── wallet.routes.js      # Wallet route definitions (/api/wallet)
│   ├── services/
│   │   ├── payment.service.js    # Atomic P2P transfer workflow with MongoDB transactions
│   │   └── wallet.service.js     # Wallet top-up (add-money) workflow with velocity limits
│   ├── utils/
│   │   └── .gitkeep              # Shared helper functions directory
│   ├── validator/
│   │   ├── addMoney.validator.js # Zod schema for wallet funding payloads
│   │   ├── auth.validator.js     # Zod schemas for registration & login
│   │   └── payment.validator.js  # Zod schema for P2P payment requests
│   ├── app.js                    # Express app initialization, middleware, and route mounting
│   └── server.js                 # Server entry point & database initialization
├── .env                          # Local environment variables (gitignored)
├── .env.example                  # Environment variable blueprint
├── package.json                  # Dependencies and run scripts
├── package-lock.json             # Pinned dependency lockfile
└── README.md                     # Backend technical documentation (this file)
```

---

## Database Models & Index Specifications

### Schema Models Reference

| Model | Collection | Purpose | Key Attributes |
| :--- | :--- | :--- | :--- |
| **`User`** | `users` | User identity & authentication credentials | `name`, `phone` (unique), `email` (sparse, unique), `hashPswd`, `status` (`ACTIVE`, `BLOCKED`) |
| **`Account`** | `accounts` | Financial accounting identity | `userId` (ref `User`, null for system accounts), `accountType` (`USER_WALLET`, `BANK_SUSPENSE`, `PLATFORM_REVENUE`, `SETTLEMENT_POOL`), `currency` (`INR`), `status` (`ACTIVE`, `BLOCKED`, `CLOSED`) |
| **`Wallet`** | `wallets` | Fast mutable balance snapshot | `userId` (unique), `accountId` (ref `Account`, unique), `availableBalance` (integer paise, $\ge 0$) |
| **`PaymentIntent`** | `paymentintents` | Durable payment request lifecycle & idempotency tracking | `userId` (ref `User`), `senderAccountId` (ref `Account`), `receiverAccountId` (ref `Account`), `amount` (paise, integer $\ge 1$), `currency` (`INR`), `idempotencyKey`, `requestFingerprint`, `transactionId` (ref `Transaction`, nullable), `status` (`RECEIVED`, `PROCESSING`, `SUCCESS`, `FAILED`) |
| **`Transaction`** | `transactions` | Business event record | `transactionId` (unique `TXN-...`), `type` (`P2P_TRANSFER`, `ADD_MONEY`), `senderAccountId` (ref `Account`), `receiverAccountId` (ref `Account`), `amount` (paise), `status` (`INITIATED`, `PROCESSING`, `SUCCESS`, `FAILED`, `REVERSED`), `failureReason` |
| **`LedgerEntry`** | `ledgerentries` | Double-entry financial audit record | `transactionId` (ref `Transaction`), `accountId` (ref `Account`), `entryType` (`DEBIT`, `CREDIT`), `amount` (paise), `currency` (`INR`) |
| **`Session`** | `sessions` | Active authenticated device sessions | `userId` (ref `User`), `sessionTokenHash` (unique), `expiresAt` (TTL index), `revokedAt` |
| **`IdempotencyKey`** | `idempotencykeys`| General request deduplication store | `userId`, `key`, `requestFingerprint`, `status` (`IN_PROGRESS`, `COMPLETED`), `transactionId`, `response`, `expiresAt` (TTL index) |

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
idempotencykeys.expiresAt: { expireAfterSeconds: 0 } // Native MongoDB TTL cleanup

// Financial Audit & Query Performance
transactions.transactionId: { unique: true }
ledgerentries.transactionId: { index: true }
ledgerentries.accountId: { index: true }
```

---

## Validation Reference (Zod)

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
  - `400 Bad Request`: Input validation failed (`"invalid registration data"`).
  - `409 Conflict`: Phone number or email is already registered (`"User already exists"`).
  - `500 Internal Server Error`: Transaction aborted or internal server error (`"internal server error"`).

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
  - `400 Bad Request`: Missing or malformed email/password (`"invalid login data"`).
  - `401 Unauthorized`: Invalid email or password (`"invalid email or password"`).
  - `403 Forbidden`: Account status is `BLOCKED` (`"account is blocked"`).
  - `500 Internal Server Error`: Server error during authentication (`"internal server error"`).

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
  - `401 Unauthorized`: Cookie missing (`"Authentication required"`), invalid session hash (`"invalid session"`), or expired session (`"session expired"`).
  - `404 Not Found`: User document not found (`"User not found"`).
  - `500 Internal Server Error`: Server error (`"Internal server error"`).

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

Executes an atomic transfer from the authenticated user's wallet to another user's wallet account using a multi-document MongoDB transaction session with durable `PaymentIntent` tracking and commit retry protection.

- **Authentication**: Required (`sessionToken` cookie)
- **Headers**:
  ```http
  Idempotency-Key: <unique-client-generated-key>
  ```
  *(Mandatory for all payment requests. Used to create and query durable `PaymentIntent` records, guaranteeing exactly-once execution across network retries and client blips).*
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
      "id": "TXN-a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "amount": 50000,
      "currency": "INR",
      "status": "SUCCESS"
    }
  }
  ```
  *(Also returned if the client retries an identical request whose `PaymentIntent` has already reached `SUCCESS`).*

- **Response `202 Accepted` (Commit Status Unknown)**:
  Returned when the MongoDB transaction commit attempts encounter `UnknownTransactionCommitResult` and cannot confirm whether the replica set finalized the commit. The transfer may have succeeded; the `PaymentIntent` remains in `PROCESSING` status. The client must not re-submit the transfer blindly and should query transaction status or await background reconciliation.
  ```json
  {
    "message": "payment status could not be confirmed",
    "status": "UNKNOWN",
    "transactionId": "TXN-a1b2c3d4-e5f6-7890-abcd-ef1234567890"
  }
  ```

- **Error Responses**:
  - `400 Bad Request`: Validation failure (empty receiver ID, non-integer or non-positive amount).
    ```json
    {
      "message": "Invalid input data",
      "errors": [...]
    }
    ```
  - `401 Unauthorized`: Authentication required or invalid/expired session cookie.
  - `409 Conflict`: Idempotency key reused with different payment parameters (`"Idempotency-Key was already used with different payment details"`) or payment previously failed (`"This payment request has already failed"`).
  - `500 Internal Server Error`: Business logic failure, insufficient funds, self-transfer attempt, or transaction abort:
    ```json
    {
      "message": "Internal server error"
    }
    ```

---

## Getting Started & Local Setup

### Prerequisites & Replica Set Requirement

- **Node.js**: `v18.x` or higher
- **npm**: `v9.x` or higher
- **MongoDB**: `v5.x` or higher with a **Replica Set** enabled (required for multi-document ACID transactions via `session.startTransaction()`). A free cloud cluster on [MongoDB Atlas](https://www.mongodb.com/atlas) works out-of-the-box.

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

3. Verify JavaScript syntax:
   ```bash
   npm run check
   ```

4. Start in development mode (with hot-reload via `nodemon`):
   ```bash
   npm run dev
   ```

5. Start in production mode:
   ```bash
   npm start
   ```

Upon a successful startup, the console will log:
```text
database connected successfully
PayFlow API is running on port 5000
```

---

## End-to-End cURL Testing Walkthrough

Follow this step-by-step cURL sequence to test the entire backend locally:

```bash
BASE_URL="http://localhost:5000"

# 1. Health Check
curl -s -X GET "${BASE_URL}/"

# 2. Register Alice
curl -s -X POST "${BASE_URL}/api/auth/register" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Alice Sharma",
    "phone": "9876543211",
    "email": "alice@example.com",
    "password": "Password123"
  }'

# 3. Register Bob
curl -s -X POST "${BASE_URL}/api/auth/register" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Bob Verma",
    "phone": "9876543212",
    "email": "bob@example.com",
    "password": "Password123"
  }'

# 4. Login Alice (save cookie jar)
curl -s -c alice_cookie.txt -X POST "${BASE_URL}/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "alice@example.com",
    "password": "Password123"
  }'

# 5. Check Alice's Authenticated Profile
curl -s -b alice_cookie.txt -X GET "${BASE_URL}/api/auth/me"

# 6. Top-Up Alice's Wallet by ₹500 (50,000 paise)
curl -s -b alice_cookie.txt -X POST "${BASE_URL}/api/wallet/add-money" \
  -H "Content-Type: application/json" \
  -d '{"amount": 50000}'

# 7. Execute P2P Transfer from Alice to Bob
# Provide Bob's Account _id from MongoDB:
BOB_ACCOUNT_ID="<BOB_ACCOUNT_ID>"
KEY=$(uuidgen 2>/dev/null || echo "idem-$(date +%s)")

curl -s -b alice_cookie.txt -X POST "${BASE_URL}/api/payments" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: ${KEY}" \
  -d "{
    \"receiverAccountId\": \"${BOB_ACCOUNT_ID}\",
    \"amount\": 20000
  }"

# 8. Retry Transfer with the Same Key (Receives Cached Result - No Duplicate Debit)
curl -s -b alice_cookie.txt -X POST "${BASE_URL}/api/payments" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: ${KEY}" \
  -d "{
    \"receiverAccountId\": \"${BOB_ACCOUNT_ID}\",
    \"amount\": 20000
  }"
```

---

## Security & Resilience Summary

### Failure Modes & Defensive Mechanisms

| Threat / Failure Mode | PayFlow Defense Mechanism | Implementation Details |
| :--- | :--- | :--- |
| **Floating-Point Precision Drift** | Strict integer math in Paise | All balances, amounts, and limits are stored in Paise ($100 = ₹1.00$). Floating-point numbers are prohibited. |
| **Balance Overdraft / Concurrency Race** | Atomic conditional decrement | `Wallet.updateOne({ _id, availableBalance: { $gte: amount } }, { $inc: { availableBalance: -amount } })`. Prevents negative balances at database level. |
| **Double-Spending / Duplicate Submission** | Durable PaymentIntent idempotency engine | Pre-flight intent check + out-of-transaction insertion into `PaymentIntent` with compound unique index `{ userId, idempotencyKey }` (catches `E11000`). |
| **Transaction Abort Visibility / Intent Durability** | Out-of-transaction `PaymentIntent` | Intent record created before ACID session persists regardless of inner transaction abort, rollback, or write conflict. |
| **Payload Tampering on Idempotent Retries** | SHA-256 Request Fingerprinting | Serializes `{ senderAccountId, receiverAccountId, amount, currency }` into SHA-256 hash. Reusing key with altered payload triggers HTTP 409. |
| **Write Conflicts / Primary Election** | Outer transaction retry loop | Retries whole transaction up to 3 times on `TransientTransactionError`, safely aborting and restarting. |
| **Dropped Commit Network Packets** | Isolated commit retry loop | Retries only `session.commitTransaction()` up to 3 times on `UnknownTransactionCommitResult` without re-executing balance debits. |
| **Ambiguous Distributed Commit State** | Fail-safe HTTP 202 escalation & persistent intent | Raises `TRANSACTION_COMMIT_UNKNOWN`, preventing blind retries; returns HTTP `202 Accepted` (`status: "UNKNOWN"`) while `PaymentIntent` stays `PROCESSING`. |
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
   - `paymentintents.{userId, idempotencyKey}`: Compound unique index for strict idempotency enforcement and serialized concurrent request handling.
   - `idempotencykeys.{userId, key}`: Compound unique index.
   - `idempotencykeys.expiresAt`: Native MongoDB TTL index (`expireAfterSeconds: 0`) with 24-hour expiration.
   - `transactions.transactionId`: Unique indexed transaction reference.
   - `ledgerentries.transactionId` & `ledgerentries.accountId`: Indexed for high-throughput audit queries and reconciliation.
