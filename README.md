# PayFlow Fintech Engine

A production-style UPI-inspired wallet system built with the MERN stack. PayFlow focuses on robust system design, ledger-based accounting, atomic transactions, idempotency, secure session management, and AI-powered financial insights.

> **Note:** This project is designed as a learning-focused fintech backend and is not connected to real banking or payment networks.

---

## Tech Stack

- **Frontend:** React (Vite), Vanilla CSS, React Query, Axios
- **Backend:** Node.js, Express.js, MongoDB (Mongoose), Zod, JWT
- **AI Layer:** Google Gemini API

---

## Core Concepts & Glossary

Here is a glossary of the key financial and technical terms used in the PayFlow engine:

| Term | Definition |
| :--- | :--- |
| **User** | A person using the PayFlow application. |
| **Account** | The financial identity associated with a user. |
| **Wallet** | A container showing available money for the user to spend. It is a cached view of money, not the absolute source of truth. |
| **Available Balance** | The amount of money that can be spent immediately. |
| **Blocked Balance** | Balance reserved for pending transactions (not spendable). |
| **Total Balance** | The sum of Available Balance and Blocked Balance (`Available + Blocked`). |
| **Ledger** | An immutable book of financial entries. Instead of editing history, every change is appended as a new record. |
| **Ledger Entry** | A single financial movement of type `CREDIT` or `DEBIT`. |
| **Double-Entry Accounting** | A system where every transaction must affect at least two accounts (a debit for one, a credit for the other) such that total debits equal total credits. |
| **Transaction** | A business operation representing a physical movement of money between entities. |
| **Transaction Ref ID** | A unique identifier for tracking and deduplicating a transaction. |
| **Payment Intent** | An object used to track the payment process from start to finish, crucial for idempotency, retry handling, and status tracking. |
| **Transaction State** | The current lifecycle state of a transaction (e.g., `INITIATED`, `PROCESSING`, `SUCCESS`). |
| **Authorization** | The permission required to execute a transaction (e.g., MPIN, device verification, biometric approval). |
| **Settlement** | The final exchange of money between financial entities (instant for wallets; bank-to-bank settlement is processed later via clearinghouses like NPCI/RBI). |
| **Reversal** | Undoing a completed transaction by creating a new, opposing transaction (never by deleting the old transaction). |
| **Atomicity** | The "all-or-nothing" property ensuring either all operations in a transaction succeed, or none do. |
| **Idempotency** | The property where performing an action multiple times yields the same result as doing it once. Managed via an `Idempotency-Key` header. |
| **Concurrency** | The occurrence of multiple operations or transaction requests happening at the exact same time. |
| **VPA / UPI-ID** | Virtual Payment Address (e.g., `rohit@payflow`) mapping to an underlying account or wallet. |
| **PSP (Payment Service Provider)** | The app providing the payment interface (e.g., PayFlow, PhonePe, GooglePay). |
| **Beneficiary** | The recipient receiving the money in a transaction. |
| **Aggregation Pipeline** | A sequence of database operations used to process and transform financial data into analytics or insights. |
| **Running Balance** | The calculated balance of an account after each individual ledger entry, useful for passbook-style audit trails. |
| **Session** | An object representing a logged-in device (stores `userId`, `deviceId`, `refreshTokenHash`, `expiresAt`) to allow session revocation and rotation. |

---

## Wallet vs. Ledger Architecture

In fintech applications, maintaining speed and auditability requires separating user dashboards from the source of truth:

*   **Wallet (Cached View):** Mutable, optimized for extremely fast reads. Used to load dashboard balances quickly.
*   **Ledger (Source of Truth):** Immutable, append-only, highly reliable audit trail. Balance can always be recalculated/rebuilt from the ledger history.

### Data Schemas

#### Wallet Schema Example
```json
{
  "_id": "W1",
  "userId": "rohit",
  "availableBalance": 8500,
  "blockedBalance": 0,
  "updatedAt": "2026-08-14T10:00:00Z"
}
```

#### Ledger Entry Schema Example
```json
{
  "_id": "L3",
  "walletId": "W1",
  "transactionId": "TXN123",
  "entryType": "DEBIT",
  "amount": 500,
  "balanceAfter": 8500,
  "createdAt": "2026-08-14T10:00:00Z"
}
```

---

## Transaction Lifecycle & Mental Model

### The Flow
```
Transaction Request
        │
        ▼
Creates Ledger Entries (Debit & Credit)
        │
        ▼
Determines Balance Changes
        │
        ▼
Updates Wallet Cached Snapshot
```

### Transfer Walkthrough
Suppose **Rohit** (Wallet `W1`, Balance: ₹10,000) sends **₹500** to **Alice** (Wallet `W2`, Balance: ₹2,000).

1.  **Create Transaction Record:**
    ```json
    {
      "_id": "TXN123",
      "fromWallet": "W1",
      "toWallet": "W2",
      "amount": 500,
      "status": "PROCESSING"
    }
    ```
2.  **Generate Double-Entry Ledger Records:**
    *   **Rohit's Debit Entry:**
        ```json
        { "walletId": "W1", "transactionId": "TXN123", "entryType": "DEBIT", "amount": 500 }
        ```
    *   **Alice's Credit Entry:**
        ```json
        { "walletId": "W2", "transactionId": "TXN123", "entryType": "CREDIT", "amount": 500 }
        ```
3.  **Update Wallet Snapshots:**
    *   `W1` (Rohit) available balance: `10,000 - 500 = 9,500`
    *   `W2` (Alice) available balance: `2,000 + 500 = 2,500`

---

## Transaction Fees & Financial Verification

When a transaction fee is applied (e.g., Rohit pays Alice ₹500, and PayFlow charges Rohit a ₹10 fee):
- **Rohit's Wallet:** Debited ₹510 (total outgo).
- **Alice's Wallet:** Credited ₹500 (payment received).
- **PayFlow Revenue Wallet:** Credited ₹10 (platform fee).

### Ledger Entries
*   **Rohit (Sender):** `DEBIT ₹510`
*   **Alice (Receiver):** `CREDIT ₹500`
*   **PayFlow Revenue:** `CREDIT ₹10`

### Ledger Validation Rule
To guarantee system-wide financial integrity, every operation must satisfy:
$$\text{Total DEBIT} = \text{Total CREDIT}$$
$$\text{e.g., } 510 \text{ (DEBIT)} = 500 \text{ (CREDIT)} + 10 \text{ (CREDIT)}$$

This assertion check (`totalDebit === totalCredit`) must run and succeed before committing any financial transaction.

---

## Atomicity & Failure Recovery

All balance updates and ledger entries for a single payment must be handled as one **Atomic Unit**. If any individual step fails (e.g., receiver's account is suspended, or system goes offline mid-operation), the entire set of changes must roll back automatically, leaving the balances untouched.

```
                  PAYMENT
                     │
           ┌─────────┴─────────┐
           │                   │
        Sender              Receiver
        - ₹500               + ₹500
           │                   │
           └─────────┬─────────┘
                     │
               ONE ATOMIC UNIT
```

We implement this in Node.js/Mongoose using MongoDB Sessions:

```javascript
const mongoose = require('mongoose');

const session = await mongoose.startSession();
try {
  await session.withTransaction(async () => {
    // 1. Debit sender's wallet snapshot (with balance check)
    // 2. Credit receiver's wallet snapshot
    // 3. Create debit/credit ledger entries
    // 4. Update the main Transaction/Payment Intent status to 'SUCCESS'
  });
} catch (error) {
  // Transaction is automatically rolled back if any error is thrown
  console.error("Transaction aborted:", error);
} finally {
  await session.endSession();
}
```

---

## Concurrency, Race Conditions & Mitigation

### The Double-Spend / Overdraft Problem
When multiple transactions execute at the exact same time, a race condition can occur if they read the same initial state before writing their updates:

```
Time   Request A (Send ₹80)               Request B (Send ₹50)
 │     (User Wallet Balance: ₹100)        (User Wallet Balance: ₹100)
 │
 ├────► Reads Balance (₹100)
 │                                        Reads Balance (₹100) ◄────┤
 ├────► Validates: ₹100 >= ₹80 (OK)
 │                                        Validates: ₹100 >= ₹50 (OK) ◄┤
 ├────► Calculates: 100 - 80 = ₹20
 │                                        Calculates: 100 - 50 = ₹50 ◄─┤
 ├────► Writes Balance: ₹20
 │                                        Writes Balance: ₹50 ◄─────┤ (Overwrites A's write!)
 ▼
```
In this scenario, the user successfully sent ₹130, but their wallet balance ends up at ₹50 (or ₹20 if Request A wrote last). The system has allowed an overdraft and lost money.

### Mitigations

#### 1. Atomic Database Updates (Failsafe Condition)
Instead of reading the balance into application memory, verifying it, and saving it, run atomic update operations directly in the database using conditional queries.
*   **Vulnerable (Anti-pattern):**
    ```javascript
    const wallet = await Wallet.findById(id);
    if (wallet.availableBalance >= amount) {
      wallet.availableBalance -= amount;
      await wallet.save();
    }
    ```
*   **Secure (Atomic):**
    ```javascript
    const res = await Wallet.updateOne(
      { _id: id, availableBalance: { $gte: amount } },
      { $inc: { availableBalance: -amount } },
      { session }
    );
    if (res.modifiedCount === 0) {
      throw new Error("Insufficient funds or wallet inactive");
    }
    ```
    This ensures that the balance check (`$gte: amount`) and decrement (`$inc`) happen in a single, thread-safe database action.

#### 2. Optimistic Concurrency Control (OCC)
For complex updates that cannot be easily done with a simple `$inc`, use version keys. Each document contains a version field (`version` or `__v`). When writing back, the database verifies that the version has not changed since it was read.
```javascript
const wallet = await Wallet.findOne({ userId });
const currentVersion = wallet.version;

// Perform complex operations...
const updatedBalance = wallet.availableBalance - amount;

const res = await Wallet.updateOne(
  { _id: wallet._id, version: currentVersion },
  { availableBalance: updatedBalance, $inc: { version: 1 } },
  { session }
);

if (res.modifiedCount === 0) {
  throw new Error("Concurrency conflict: document modified by another process. Please retry.");
}
```

#### 3. Distributed/Pessimistic Locking
In distributed systems or high-concurrency systems, transactions on the same wallet resource can be serialized using locking mechanisms.
*   **Redis Locks (Redlock):** A lock is acquired on the resource key `lock:wallet:<walletId>` before processing the transaction. Any parallel request trying to acquire the same lock will block or fail fast, preventing database-level contention entirely.

---

## Payment Lifecycle & State Machine

Payments in PayFlow transition through a series of states to handle delays, retries, and failures gracefully:

```
 [INITIATED] ──► [PROCESSING] ──┬──► [SUCCESS]
                                 ├──► [FAILED]
                                 └──► [EXPIRED] ──► [REVERSED] (if debited)
```

### State Definitions
*   **INITIATED:** The user has requested a payment. The payment intent is created, but no money has moved yet.
*   **PROCESSING:** The system is waiting for network/bank confirmations, or processing database modifications.
*   **SUCCESS:** The payment completed successfully. Balances are updated and ledger entries are locked.
*   **FAILED:** Something went wrong (e.g., network error, insufficient funds). No money is moved.
*   **REVERSED:** Undoing a completed transaction. A new transaction is created to credit the sender and debit the receiver.
*   **EXPIRED:** The payment request remained unresolved in `PROCESSING` for too long.
    *   *Note:* `EXPIRED` does not automatically return money. It indicates timeout. If funds were debited during `PROCESSING` before timeout, the system must trigger a `REVERSED` state to return the funds.

---

## Reconciliation & Discrepancy Auditing

Reconciliation is the process of comparing our internal system records (the database and immutable ledger) with another external source of truth to ensure consistency and correctness.

```
             RECONCILIATION
                   │
                   ▼
          Compare two records
                   │
          ┌────────┴────────┐
          ▼                 ▼
       MATCH            MISMATCH
          │                 │
        Done         Investigate/Resolve
                            │
                  ┌─────────┼─────────┐
                  ▼         ▼         ▼
               Update    Reverse    Manual
               state     money      review
```

### The Concept
*   **Match:** When both records agree. E.g., PayFlow logs `PAY123` as `SUCCESS` for ₹500, and the external payment network logs `PAY123` as `SUCCESS` for ₹500.
*   **Mismatch:** When status, amount, or details differ. E.g., PayFlow logs `PAY123` as `SUCCESS` for ₹500, but the external network logs it as `SUCCESS` for ₹450 (Amount Mismatch) or logs it as `FAILED` (Status Mismatch).

### Handling Mismatches
When a discrepancy is detected, the reconciliation system flags it for resolution based on the scenario:

| Scenario | Local Status | External Status | Action |
| :--- | :--- | :--- | :--- |
| **Scenario A** | `PROCESSING` | `SUCCESS` | Update local transaction state: `PROCESSING` → `SUCCESS` and execute ledger balance changes. |
| **Scenario B** | `SUCCESS` | `FAILED` | Investigate the root cause (e.g., timeout handling error) and perform a new **Reversal** / refund transaction to return the money. |
| **Scenario C** | Any | Mismatched Amount | Halt automatic processing, flag the transaction, and route it to **Manual review**. |

### Project Implementation (External Simulator)
To simulate this process, PayFlow compares its database with an isolated external simulated payment network:

```
┌──────────────────────┐
│       PayFlow        │
│    Local Database    │
└──────────┬───────────┘
           │
           │ Payment Request
           ▼
┌──────────────────────┐
│ Fake Payment Network │
│  External Simulator  │
└──────────────────────┘
```

The fake network maintains its own records independent of our local system. Our reconciliation service pulls these records, checks for inconsistencies, and runs discrepancy logic:

```
             PAY123
                │
        ┌───────┴───────┐
        ▼               ▼
     PayFlow        External
     SUCCESS         FAILED
        │               │
        └───────┬───────┘
                ▼
            MISMATCH -> Trigger Reversal & Alerts
```

### Reconciliation vs. Resolution

While **Reconciliation** is the analytical phase (detecting and classifying mismatches), **Resolution** is the operational phase (applying corrections to the ledger to fix those mismatches).

```
                External System
                      │
                      │ Reconciliation Data
                      ▼
              ┌─────────────────┐
              │ Reconciliation  │
              │     Engine      │
              └────────┬────────┘
                       │
                 Compare Records
                       │
          ┌────────────┴────────────┐
          │                         │
       MATCH                    MISMATCH
          │                         │
      No Action               Classify Issue
                                    │
                           ┌────────┴────────┐
                           │                 │
                       Fee Difference    Actual Issue
                           │                 │
                       No Correction      Investigate
                                             │
                                      Resolution Decision
                                             │
                                  ┌──────────┴─────────┐
                                  │                    │
                              Reversal             Adjustment
                                  │                    │
                                  └────────┬───────────┘
                                           │
                                      New Ledger Entry
```

*   **Fee Difference:** A common mismatch is a discrepancy due to varying transaction/network fees. Often, no balance correction is needed.
*   **Actual Issue:** A structural failure or processing discrepancy that requires investigation. The system makes a resolution decision (e.g., automated Reversal or manual Adjustment) and appends a **new ledger entry** to correct the balance.

---

## Audit Trails & Logging System

Audit logs record the exact history of events, state changes, and actors surrounding a financial transaction. They serve as the "CCTV" of the system.

### Actors in the System
Audit events are created by distinct actors to ensure clear accountability:
*   `USER`: The person initiating the action (e.g., Rohit sending money).
*   `ADMIN`: A platform administrator investigating or overriding an issue.
*   `API`: Automated system components responding to incoming webhooks.
*   `PAYMENT_WORKER`: The worker queue executing transfers and state commitments.
*   `RECONCILIATION_WORKER`: The worker identifying inconsistencies and triggers.
*   `SYSTEM`: Core scheduler or fallback automation daemon.

#### Example Event Object
```json
{
  "timestamp": "2026-08-16T10:05:01Z",
  "actorType": "SYSTEM",
  "actorId": "reconciliation-worker",
  "event": "RECONCILIATION_MISMATCH",
  "details": { "transactionId": "PAY123", "mismatchType": "AMOUNT_MISMATCH" }
}
```

### Timeline of a Discrepancy
```
10:00:01 ──► [USER / rohit] Payment initiated (PAYMENT_INITIATED)
10:00:02 ──► [USER / rohit] MPIN verified (MPIN_VERIFIED)
10:00:03 ──► [SYSTEM / payment-worker] Wallet debit completed (DEBIT_COMPLETED)
10:00:03 ──► [SYSTEM / payment-worker] Transaction marked SUCCESS (PAYMENT_SUCCESS)
10:05:00 ──► [SYSTEM / reconciliation-worker] Reconciliation started (RECONCILIATION_STARTED)
10:05:01 ──► [SYSTEM / reconciliation-worker] Amount mismatch detected (MISMATCH_DETECTED)
10:10:42 ──► [ADMIN / admin123] Investigation completed (DISCREPANCY_REVIEWED)
10:10:43 ──► [SYSTEM / payment-worker] Reversal created (REVERSAL_CREATED)
```

---

## The Three Layers of PayFlow

Every payment operation in the PayFlow engine is tracked across three independent but connected layers:

```
                PAYMENT
                   │
       ┌───────────┼────────────┐
       │           │            │
       ▼           ▼            ▼
   Transaction    Ledger      Audit
       │           │            │
   Business      Money        History
    State        Movement      of Actions
```

1.  **Transaction Layer (Business State):** Stores the current business story and user-facing status of the payment intent (e.g., `PAY123`, amount: ₹500, status: `SUCCESS`).
2.  **Ledger Layer (Money Movement):** The immutable accounting book. Every movement is recorded as double-entry ledger items (e.g., Rohit: `DEBIT ₹500`, Alice: `CREDIT ₹500`).
3.  **Audit Layer (History of Actions):** The step-by-step security record of everything that occurred (e.g., `PAYMENT_INITIATED`, `MPIN_VERIFIED`, `RECONCILIATION_STARTED`, `MISMATCH_DETECTED`, `REVERSAL_CREATED`).

> [!IMPORTANT]
> **Fintech Core Principle:** Never rewrite history to make the present look correct. If an error occurs or a correction is needed, always write a new record (ledger/audit log) explaining what happened, preserving the historical timeline.
