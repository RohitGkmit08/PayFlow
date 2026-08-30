const mongoose = require('mongoose');

const walletSchema = new mongoose.Schema(
  {
    userId: {
      // it represents Which user does this wallet belong to? (ownership)
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
    },

    accountId: {
      // it represent Which financial account does this wallet represent? (financial relationship)
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Account',
      required: true,
      unique: true,
    },

    availableBalance: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('Wallet', walletSchema);