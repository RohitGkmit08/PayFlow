const mongoose = require('mongoose');

const idempotencyKeySchema = new mongoose.Schema(
// its job is to Make sure the same payment request doesn't cause the financial operation to execute more than once.
// It's a unique identifier supplied by the client for a particular operation.
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
// A fingerprint of what the client actually asked PayFlow to do.
// Same request → same fingerprint. Different request → different fingerprint.
// idempotency key identifies the logical request (ABC123), The fingerprint proves what that request actually contained: ABC123 + "UserA + UserB --> Rs. 500" 
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
// Which financial transaction resulted?
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Transaction',
      default: null,
    },

    response: {
// This stores the result of the original operation.
// Suppose UserA made a payment, payment succeeded, server sends a response, NETWORK FAILURE, UserA does not recieve the response.
// UserA's app doesnot know whether payment succeeded. So it retries the payment request, server finds ABC123 -> completed -> TXN123.
// So instead of processing another payment, it can return the response.
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