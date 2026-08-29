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
      // not every account has the smame purpose 
      type: String,
      enum: [
        'USER_WALLET', // user's financial position inside payflow
        'BANK_SUSPENSE', // funds linked with external movement whose accounting status may not yet be finalized
        'PLATFORM_REVENUE', // money payflow earns from fees 
        'SETTLEMENT_POOL', // funds involved in settlement between payflow and external system
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