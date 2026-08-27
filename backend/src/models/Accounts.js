const mongoose = require('mongoose');

const accountSchema = new mongoose.Schema(
  {
    userId: {
      // The value stored in userId should be a MongoDB ObjectId.
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    accountType: {
      type: String,
      enum: [
        'USER_WALLET',
        'BANK_SUSPENSE',
        'PLATFORM_REVENUE',
        'SETTLEMENT_POOL',
      ],
      required: true,
    },

    currency: {
      type: String,
      required: true,
      default: 'INR',
      uppercase: true,
    },

    status: {
      type: String,
      enum: ['ACTIVE', 'BLOCKED', 'CLOSED'],
      default: 'ACTIVE',
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('Account', accountSchema);