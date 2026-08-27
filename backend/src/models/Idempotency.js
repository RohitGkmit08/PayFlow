const mongoose = require('mongoose');

const idempotencyKeySchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },

    key: {
      type: String,
      required: true,
    },

    requestFingerprint: {
      type: String,
      required: true,
    },

    status: {
      type: String,
      enum: ['IN_PROGRESS', 'COMPLETED'],
      required: true,
      default: 'IN_PROGRESS',
    },

    transactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Transaction',
      default: null,
    },

    response: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    expiresAt: {
      type: Date,
      required: true,
    },
  },
  {
    timestamps: true,
  }
);
// compound unique idx = for a particular user idempotenct key can exists only once.
// it treats two values together as the unique identity. '1' means index this ascending order( sometimes -1 is also written).
idempotencyKeySchema.index(
  { userId: 1, key: 1 },
  { unique: true }
);

// ttl = time to live index, it tells mongoDb that "expiresAt" is reached, this document is eligible for auto-deletion.
// mongoDb's ttl mechanism periodically checks the index. After expiration time, mongoDb removes the document. So we dont need a worker to do this job explicitly.
// if we dont use "expireAfterSeconds" even after their expiration dates pass, they remain in MongoDB.
idempotencyKeySchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0 }
);

module.exports = mongoose.model(
  'IdempotencyKey',
  idempotencyKeySchema
);