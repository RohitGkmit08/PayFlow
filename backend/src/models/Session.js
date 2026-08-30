const mongoose = require("mongoose");

const sessionSchema = new mongoose.Schema({
// session is basically server basicaly saying: "This browser/device has successfully authenticated as User U1."
    userId:{
        type: mongoose.Schema.Types.ObjectId,
        ref:"User",
        required:true,
        index:true
    },
    
    sessionTokenHash: {
      type: String,
      required: true,
      unique: true,
    },

    expiresAt: {
      type: Date,
      required: true,
    },

     revokedAt: {
      type: Date,
      default: null,
    },

}, {timestamps:true});

sessionSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0 }
);

module.exports = mongoose.model("Session", sessionSchema);

// Session is for the authentication, the server determines the sender from the authenticated session.

// Basic flow:
// UserA logs in
//       ↓
// Server verifies credentials
//       ↓
// Server creates Session
//       ↓
// Session token → HttpOnly cookie
//       ↓
// Browser stores cookie

// later:
// POST /payments
//       ↓
// Cookie automatically sent
//       ↓
// Server finds Session
//       ↓
// Session → userId
//       ↓
// userId → Rohit
//       ↓
// UserA's Account
//       ↓
// UserA's Wallet
//       ↓
// Payment