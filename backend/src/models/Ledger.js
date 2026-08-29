const mongoose = require('mongoose');

const ledgerEntrySchema = new mongoose.Schema(
// A Transaction describes the business event. A LedgerEntry records the financial effect of that event on an Account.
// Transactions can describe what happened; ledger entries prove how the accounting changed.
  {
    transactionId: {
// Every ledger entry should be traceable back to the business event that produc
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Transaction',
      required: true,
      index: true,
    },

    accountId: {
//  Which financial account was affected? 
//  why not wallet? Lets say platform adds a platform fees, that cannot be linked with a wallet.
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Account',
      required: true,
      index: true,
    },

    entryType: {
      type: String,
      enum: ['DEBIT', 'CREDIT'],
      required: true,
    },

    amount: {
      type: Number,
      required: true,
      min: 1,
    },

    currency: {
// because number doesnot inherintly tell us about currency
      type: String,
      required: true,
      default: 'INR',
      uppercase: true,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('LedgerEntry', ledgerEntrySchema);