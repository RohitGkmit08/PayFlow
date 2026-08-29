const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema(
// it defines, what actually happened with the money.
// it is NOT  the ledger, a transaction happens and its consequence is a ledger entry.
// 
  {
    transactionId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },

    type: {
      type: String,
      enum: ['P2P_TRANSFER'],
      required: true,
    },

    senderAccountId: {
// why not senderWalletId ? Because we've already decided that the accounting identity is in account, not in wallet.
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Account',
      required: true,
    },

    receiverAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Account',
      required: true,
    },

    amount: {
      type: Number,
      required: true,
      min: 1,
    },

    currency: {
      type: String,
      required: true,
      default: 'INR',
      uppercase: true,
    },

    status: {
      type: String,
      enum: [
        'INITIATED',
        'PROCESSING',
        'SUCCESS',
        'FAILED',
        'REVERSED',
      ],
      default: 'INITIATED',
    },

    failureReason: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('Transaction', transactionSchema);

// How Transaction fits with Wallet

// ex: UserA wallet availableBal: Rs 1000.   UserB wallet availableBal: Rs. 700
// User A initiates Rs. 300 transfer
// The Transaction records: 
// TXN123

// senderAccountId   = UserA Account
// receiverAccountId = UserB Account
// amount            = 30000
// currency          = INR
// status            = ...

// Then the payment service will eventually modify: UserA Wallet: Rs. 1,000 → Rs. 700, UserB Wallet: Rs. 500 → ₹800

// and create:
// Ledger:
// DEBIT  UserA Account  Rs. 300
// CREDIT UserB Account  Rs. 300

// Why transaction exists separately from Ledger?

// Because a transaction can have multiple accounting consequences.
// Simple P2P: 
// TXN123
//  ├── UserA  Rohit   ₹500
//  └── UserB Alice   ₹500

//  payment with a fee:
//  TXN124
//  ├── DEBIT  Rohit             ₹510
//  ├── CREDIT Alice             ₹500
//  └── CREDIT Platform Revenue   ₹10

//  still one transaction, but THREE LEDGER ENTRIES